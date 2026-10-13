/*
 * Sync across devices: reading progress, Recently Read, reader settings and
 * "My channels", stored per user in Supabase (see supabase/schema.sql).
 *
 * Sync runs by itself: on sign-in, on a timer while the page is visible, when
 * the tab comes back, when a comic is opened or closed and when the network
 * returns. Local changes are remembered in `pending` and pushed within seconds.
 *
 * Merge rule: the server copy wins unless this device has an unsent change
 * that is newer (per comic, and for the settings as a whole). Comic files and
 * Telegram logins never leave the device.
 *
 * The auth session lives in sessionStorage unless "Stay signed in" is ticked,
 * because every project on the same <user>.github.io origin shares localStorage.
 */
document.addEventListener('DOMContentLoaded', () => {
    const config = window.COMIC_SYNC_CONFIG || {};
    const configured = /^https:\/\/.+/.test(config.supabaseUrl || '') && Boolean(config.supabaseAnonKey);

    const SUPABASE_SRC = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/dist/umd/supabase.js';
    const SUPABASE_SRI = 'sha384-Rj26LVGvoeRVR6+mwQmFfcR3QOBEwT+ZmuCWpuiqeTzJpCs0ER4ITAWGb4Hiy3Ok';
    /*
     * STATE_KEY: { userId, lastSyncAt (last successful cycle, display only),
     *   settingsChangedAt, settingsSeenAt (remote updated_at last applied),
     *   pending: { file_name: updated_at ms }, settingsPending,
     *   cursor, settingsCursor (newest server_updated_at seen, server clock),
     *   caps: { serverClock, checkedAt }, lastFullAt, probeToken }
     */
    const STATE_KEY = 'comic_sync_state';
    const PERSIST_KEY = 'comic_sync_persist'; // '1' = keep the session in localStorage
    const PUSH_DELAY = 1500;                  // library: wait for changes to settle
    const READING_PUSH_WAIT = 10 * 1000;      // reader open: push at most this late
    const TICK = 30 * 1000;                   // incremental pull (and status refresh)
    const PROBE_EVERY = 60 * 1000;            // change probe when the server clock is missing
    const FULL_EVERY = 15 * 60 * 1000;
    const CAPS_TTL = 24 * 60 * 60 * 1000;
    const CURSOR_OVERLAP = 10 * 1000;         // transactions can commit out of order with now()
    const PAGE_SIZE = 1000;                   // Supabase default max rows per request
    const FETCH_TIMEOUT = 20 * 1000;
    const LIBRARY_TIMEOUT = 15 * 1000;
    const PENDING_STALE = 15 * 1000;          // longer than one reading push interval
    const BACKOFF = [15, 30, 60, 120, 300].map((s) => s * 1000);
    const UPSERT_CHUNK = 200;
    const PROGRESS_COLS = 'file_name,last_page,total_pages,source,hidden,read_at,updated_at';
    const SETTINGS_COLS = 'reader,channels,updated_at';

    const $ = (id) => document.getElementById(id);
    const els = {
        bar: $('syncBar'),
        barText: $('syncBarText'),
        barBtn: $('syncBarBtn'),
        status: $('syncStatus'),
        notConfigured: $('syncNotConfigured'),
        signedOut: $('syncSignedOut'),
        signedIn: $('syncSignedIn'),
        tabs: document.querySelectorAll('.account-tab'),
        form: $('syncAuthForm'),
        email: $('syncEmail'),
        password: $('syncPassword'),
        passwordHint: $('syncPasswordHint'),
        persist: $('syncPersist'),
        submit: $('syncAuthSubmit'),
        forgot: $('syncForgotBtn'),
        recoveryForm: $('syncRecoveryForm'),
        newPassword: $('syncNewPassword'),
        userEmail: $('syncUserEmail'),
        syncNow: $('syncNowBtn'),
        logout: $('syncLogoutBtn'),
        deleteData: $('syncDeleteBtn'),
        message: $('syncMessage')
    };
    if (!els.bar) return;

    const app = () => window.ComicReader;
    const finder = () => window.TelegramFinder;

    let client = null;
    let clientPromise = null;
    let user = null;
    let mode = 'signin';
    let recovering = false;
    let running = null;     // promise of the sync loop, one at a time
    let queued = null;      // options of the next cycle
    let showSyncing = false;
    let pushTimer = null;
    let retryTimer = null;
    let ticker = null;
    let failures = 0;
    let lastError = '';
    let lastPullAt = 0;
    let readerOpen = false;
    let flushing = false;   // requests started now get keepalive, so they survive closing the tab

    /* ---------------- storage ---------------- */

    function loadState() {
        try {
            return JSON.parse(localStorage.getItem(STATE_KEY) || '{}') || {};
        } catch (e) {
            return {};
        }
    }

    function saveState(patch) {
        const next = Object.assign(loadState(), patch);
        try {
            localStorage.setItem(STATE_KEY, JSON.stringify(next));
        } catch (e) {
            // storage unavailable
        }
        return next;
    }

    const persistSession = () => {
        try {
            return localStorage.getItem(PERSIST_KEY) === '1';
        } catch (e) {
            return false;
        }
    };

    // session in sessionStorage by default, localStorage only with "Stay signed in"
    const authStorage = {
        getItem(key) {
            try {
                return sessionStorage.getItem(key) ?? localStorage.getItem(key);
            } catch (e) {
                return null;
            }
        },
        setItem(key, value) {
            try {
                if (persistSession()) {
                    localStorage.setItem(key, value);
                    sessionStorage.removeItem(key);
                } else {
                    sessionStorage.setItem(key, value);
                    localStorage.removeItem(key);
                }
            } catch (e) {
                // storage unavailable
            }
        },
        removeItem(key) {
            try {
                sessionStorage.removeItem(key);
                localStorage.removeItem(key);
            } catch (e) {
                // storage unavailable
            }
        }
    };

    /* ---------------- client ---------------- */

    function loadLibrary() {
        if (window.supabase && window.supabase.createClient) return Promise.resolve(window.supabase);
        return new Promise((resolve, reject) => {
            setTimeout(() => reject(new Error('The sync library took too long to load')), LIBRARY_TIMEOUT);
            const script = document.createElement('script');
            script.src = SUPABASE_SRC;
            script.integrity = SUPABASE_SRI;
            script.crossOrigin = 'anonymous';
            script.onload = () => (window.supabase ? resolve(window.supabase) : reject(new Error('Sync library failed to start')));
            script.onerror = () => reject(new Error('Could not load the sync library'));
            document.head.appendChild(script);
        });
    }

    // every Supabase request: 20 s timeout, keepalive while the page is being hidden or closed
    function wrappedFetch(input, init) {
        const options = Object.assign({}, init);
        if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) {
            const timeout = AbortSignal.timeout(FETCH_TIMEOUT);
            if (!options.signal) {
                options.signal = timeout;
            } else if (AbortSignal.any) {
                options.signal = AbortSignal.any([options.signal, timeout]);
            }
        }
        if (flushing && typeof options.body === 'string' && options.body.length < 60000) {
            options.keepalive = true;
        }
        return fetch(input, options);
    }

    function getClient() {
        if (client) return Promise.resolve(client);
        if (!clientPromise) {
            clientPromise = loadLibrary().then((lib) => {
                client = lib.createClient(config.supabaseUrl, config.supabaseAnonKey, {
                    auth: {
                        storage: authStorage,
                        persistSession: true,
                        autoRefreshToken: true,
                        detectSessionInUrl: true
                    },
                    global: { fetch: wrappedFetch }
                });
                client.auth.onAuthStateChange((event, session) => {
                    // keep the callback synchronous; Supabase runs it inside its auth lock
                    setTimeout(() => onAuthChange(event, session), 0);
                });
                return client;
            }).finally(() => { clientPromise = null; });
        }
        return clientPromise;
    }

    function onAuthChange(event, session) {
        const previous = user && user.id;
        user = session && session.user ? session.user : null;
        if (event === 'PASSWORD_RECOVERY') {
            recovering = true;
            app() && app().showAccount();
        }
        if (user && user.id !== previous) {
            requestSync('signin', { pull: true, full: true });
            startTicker();
        }
        if (!user) {
            stopTicker();
            clearTimeout(pushTimer);
            pushTimer = null;
        }
        render();
    }

    /* ---------------- UI ---------------- */

    function showMessage(text, kind = 'info') {
        if (!text) {
            els.message.hidden = true;
            return;
        }
        els.message.textContent = text;
        els.message.dataset.kind = kind;
        els.message.hidden = false;
    }

    function formatAgo(ms) {
        if (!ms) return 'not yet';
        const seconds = Math.round((Date.now() - ms) / 1000);
        if (seconds < 60) return 'just now';
        if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
        if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
        return new Date(ms).toLocaleString();
    }

    function render() {
        els.bar.hidden = !configured;
        els.notConfigured.hidden = configured;
        if (!configured) {
            els.signedOut.hidden = true;
            els.signedIn.hidden = true;
            els.recoveryForm.hidden = true;
            els.status.textContent = 'Not set up';
            return;
        }

        els.recoveryForm.hidden = !recovering;
        els.signedOut.hidden = Boolean(user) || recovering;
        els.signedIn.hidden = !user || recovering;

        const state = loadState();
        if (user) {
            els.userEmail.textContent = user.email || '';
            let barState = 'on';
            let barText = `Synced as ${user.email}`;
            let status = `Up to date · checked ${formatAgo(state.lastSyncAt)}`;
            if (showSyncing) {
                // only manual and first syncs; background pulls stay quiet
                barText = 'Syncing…';
                status = 'Syncing…';
            } else if (navigator.onLine === false) {
                barState = 'pending';
                barText = 'Offline · changes sync when you are back online';
                status = barText;
            } else if (failures >= 2) {
                barState = 'error';
                barText = 'Sync failed';
                status = `Sync failed: ${lastError}`;
            } else if (failures === 1 || pendingAge(state) > PENDING_STALE) {
                barState = 'pending';
                barText = 'Sync paused · retrying';
                status = lastError ? `Sync paused, retrying: ${lastError}` : barText;
            }
            els.status.textContent = status;
            els.barText.textContent = barText;
            els.bar.dataset.state = barState;
            els.barBtn.textContent = 'Account';
        } else {
            els.status.textContent = 'Not signed in';
            els.barText.textContent = 'Keep your progress in sync across devices';
            els.bar.dataset.state = 'off';
            els.barBtn.textContent = 'Sign in';
        }
    }

    function setMode(next) {
        mode = next;
        els.tabs.forEach((tab) => {
            const active = tab.dataset.tab === next;
            tab.classList.toggle('active', active);
            tab.setAttribute('aria-selected', String(active));
        });
        els.submit.textContent = next === 'signup' ? 'Create account' : 'Sign in';
        els.password.autocomplete = next === 'signup' ? 'new-password' : 'current-password';
        els.passwordHint.hidden = next !== 'signup';
        els.forgot.hidden = next === 'signup';
        showMessage('');
    }

    function busy(container, on) {
        container.querySelectorAll('button, input').forEach((el) => { el.disabled = on; });
    }

    const redirectUrl = () => window.location.origin + window.location.pathname;

    els.tabs.forEach((tab) => tab.addEventListener('click', () => setMode(tab.dataset.tab)));
    els.barBtn.addEventListener('click', () => app() && app().showAccount());
    els.persist.checked = persistSession();

    els.form.addEventListener('submit', async (event) => {
        event.preventDefault();
        showMessage('');
        busy(els.form, true);
        try {
            try {
                localStorage.setItem(PERSIST_KEY, els.persist.checked ? '1' : '0');
            } catch (e) {
                // storage unavailable
            }
            const auth = (await getClient()).auth;
            const email = els.email.value.trim();
            const password = els.password.value;
            if (mode === 'signup') {
                const { data, error } = await auth.signUp({ email, password, options: { emailRedirectTo: redirectUrl() } });
                if (error) throw error;
                if (!data.session) {
                    showMessage('Account created. Open the link in the email we just sent to confirm it, then sign in here.', 'info');
                    setMode('signin');
                }
            } else {
                const { error } = await auth.signInWithPassword({ email, password });
                if (error) throw error;
            }
            els.password.value = '';
        } catch (err) {
            showMessage(err.message || String(err), 'error');
        } finally {
            busy(els.form, false);
        }
    });

    els.forgot.addEventListener('click', async () => {
        const email = els.email.value.trim();
        if (!email || !els.email.checkValidity()) {
            showMessage('Enter your email address first, then click "Forgot password?" again.', 'error');
            els.email.focus();
            return;
        }
        try {
            const { error } = await (await getClient()).auth.resetPasswordForEmail(email, { redirectTo: redirectUrl() });
            if (error) throw error;
            showMessage('If an account exists for this address, an email with a reset link is on its way.', 'info');
        } catch (err) {
            showMessage(err.message || String(err), 'error');
        }
    });

    els.recoveryForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        busy(els.recoveryForm, true);
        try {
            const { error } = await (await getClient()).auth.updateUser({ password: els.newPassword.value });
            if (error) throw error;
            els.newPassword.value = '';
            recovering = false;
            showMessage('Your new password is saved.', 'info');
        } catch (err) {
            showMessage(err.message || String(err), 'error');
        } finally {
            busy(els.recoveryForm, false);
            render();
        }
    });

    els.syncNow.addEventListener('click', () => window.CloudSync.sync());

    els.logout.addEventListener('click', async () => {
        clearTimeout(pushTimer);
        pushTimer = null;
        await Promise.race([requestSync('push'), wait(4000)]);
        try {
            await (await getClient()).auth.signOut();
        } catch (err) {
            // the local session is gone either way
        }
        user = null;
        showMessage('Logged out. Your progress stays on this device.', 'info');
        render();
    });

    els.deleteData.addEventListener('click', async () => {
        if (!user) return;
        if (!confirm('Delete your synced progress, settings and channel list from the server?\nThis device keeps its own copy. You will be logged out.')) return;
        busy(els.signedIn, true);
        try {
            const db = await getClient();
            const progress = await db.from('reading_progress').delete().eq('user_id', user.id);
            if (progress.error) throw progress.error;
            const prefs = await db.from('user_settings').delete().eq('user_id', user.id);
            if (prefs.error) throw prefs.error;
            clearTimeout(pushTimer);
            saveState({ lastSyncAt: 0 });
            await db.auth.signOut();
            user = null;
            showMessage('Your synced data was deleted from the server and you are logged out.', 'info');
        } catch (err) {
            showMessage(err.message || String(err), 'error');
        } finally {
            busy(els.signedIn, false);
            render();
        }
    });

    /* ---------------- sync ---------------- */

    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const toIso = (ms) => new Date(ms || Date.now()).toISOString();
    const parseTime = (value) => {
        const ms = Date.parse(value);
        return Number.isFinite(ms) ? ms : 0;
    };
    const localUpdated = (entry) => (entry && (entry.updated_at || entry.timestamp)) || 0;
    const isVisible = () => document.visibilityState === 'visible';
    const isOffline = () => navigator.onLine === false;
    // 42703 = the column does not exist: the SQL that adds server_updated_at has not been run
    const missingServerClock = (error) => Boolean(error) && (error.code === '42703' || /server_updated_at/.test(error.message || ''));
    const hasPending = (state) => Object.keys(state.pending || {}).length > 0 || Boolean(state.settingsPending);

    function pendingAge(state) {
        const marks = Object.values(state.pending || {});
        if (state.settingsPending) marks.push(state.settingsChangedAt || Date.now());
        return marks.length ? Date.now() - Math.min(...marks) : 0;
    }

    // newest server_updated_at of the rows (server clock), or `current` when none is newer
    function maxServerTime(current, rows) {
        let best = parseTime(current);
        rows.forEach((row) => { best = Math.max(best, parseTime(row && row.server_updated_at)); });
        return best ? new Date(best).toISOString() : null;
    }

    function rowFromEntry(fileName, entry) {
        const source = ['upload', 'folder', 'telegram'].includes(entry.source) ? entry.source : null;
        return {
            user_id: user.id,
            file_name: fileName,
            last_page: Math.max(0, entry.last_page | 0),
            total_pages: entry.total_pages > 0 ? entry.total_pages | 0 : null,
            source,
            hidden: Boolean(entry.hidden_from_recent),
            read_at: toIso(entry.timestamp),
            updated_at: toIso(localUpdated(entry))
        };
    }

    // local-only fields (thumbnail and anything else) stay as they are on this device
    function entryFromRow(row, local) {
        const entry = Object.assign({}, local, {
            last_page: row.last_page || 0,
            total_pages: row.total_pages || null,
            source: row.source || null,
            timestamp: Date.parse(row.read_at) || Date.now(),
            updated_at: Date.parse(row.updated_at) || Date.now(),
            thumbnail: (local && local.thumbnail) || null
        });
        delete entry.hidden_from_recent;
        if (row.hidden) entry.hidden_from_recent = true;
        return entry;
    }

    // whether the visible part of an entry differs (or the entry was added or removed)
    function entryDiffers(a, b) {
        if (!a || !b) return Boolean(a) !== Boolean(b);
        return (a.last_page | 0) !== (b.last_page | 0)
            || (a.total_pages || null) !== (b.total_pages || null)
            || Boolean(a.hidden_from_recent) !== Boolean(b.hidden_from_recent)
            || (a.source || null) !== (b.source || null);
    }

    async function upsertProgress(db, rows) {
        for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
            const { error } = await db.from('reading_progress').upsert(rows.slice(i, i + UPSERT_CHUNK), { onConflict: 'user_id,file_name' });
            if (error) throw error;
        }
    }

    function localSettings() {
        return {
            reader: app() ? app().getReaderSettings() : {},
            channels: finder() ? finder().getChannels() : []
        };
    }

    async function pushSettings(db, changedAt) {
        const { reader, channels } = localSettings();
        const { error } = await db.from('user_settings').upsert({
            user_id: user.id,
            reader,
            channels,
            updated_at: toIso(changedAt || Date.now())
        }, { onConflict: 'user_id' });
        if (error) throw error;
    }

    /* change tracking: works while signed out too, the next sync sends it */

    function markHistoryPending(names) {
        const history = app() ? app().getHistory() : {};
        const state = loadState();
        const pending = Object.assign({}, state.pending);
        // legacy callers without names: everything changed since the last sync
        const list = names || Object.keys(history).filter((name) => localUpdated(history[name]) > (state.lastSyncAt || 0));
        list.forEach((name) => {
            if (history[name]) pending[name] = localUpdated(history[name]);
        });
        saveState({ pending });
    }

    // drops the sent marks that were not replaced by a newer change in the meantime
    function clearPending(sent) {
        const pending = Object.assign({}, loadState().pending);
        Object.entries(sent).forEach(([name, mark]) => {
            if (pending[name] === mark) delete pending[name];
        });
        saveState({ pending });
    }

    function migrateState() {
        const state = loadState();
        if (state.pending !== undefined) return;
        const since = state.lastSyncAt || 0;
        const pending = {};
        if (state.userId && app()) {
            Object.entries(app().getHistory()).forEach(([name, entry]) => {
                if (entry && localUpdated(entry) > since) pending[name] = localUpdated(entry);
            });
        }
        const settingsPending = state.userId ? (state.settingsChangedAt || 0) > since : Boolean(state.settingsChangedAt);
        saveState({ pending, settingsPending });
    }

    /* pull */

    // count, newest updated_at and settings time; used when there is no server clock
    async function probeRemote(db) {
        const progress = await db.from('reading_progress').select('updated_at', { count: 'exact' }).order('updated_at', { ascending: false }).limit(1);
        if (progress.error) throw progress.error;
        const prefs = await db.from('user_settings').select('updated_at').maybeSingle();
        if (prefs.error) throw prefs.error;
        const newest = progress.data && progress.data[0] ? progress.data[0].updated_at : '';
        return `${progress.count || 0}|${newest}|${prefs.data ? prefs.data.updated_at : ''}`;
    }

    // `since` = the state with cursors for an incremental pull, null for a full one
    async function fetchRemote(db, useClock, since) {
        const progressSince = since && since.cursor ? new Date(parseTime(since.cursor) - CURSOR_OVERLAP).toISOString() : null;
        const settingsSince = since && since.settingsCursor ? new Date(parseTime(since.settingsCursor) - CURSOR_OVERLAP).toISOString() : null;
        const cols = useClock ? `${PROGRESS_COLS},server_updated_at` : PROGRESS_COLS;
        const rows = [];
        for (let from = 0; ; from += PAGE_SIZE) {
            let query = db.from('reading_progress').select(cols);
            if (progressSince) query = query.gt('server_updated_at', progressSince);
            const { data, error } = await query.order('file_name').range(from, from + PAGE_SIZE - 1);
            if (error) throw error;
            rows.push(...(data || []));
            if (!data || data.length < PAGE_SIZE) break;
        }
        let settingsQuery = db.from('user_settings').select(useClock ? `${SETTINGS_COLS},server_updated_at` : SETTINGS_COLS);
        if (settingsSince) settingsQuery = settingsQuery.gt('server_updated_at', settingsSince);
        const prefs = await settingsQuery.maybeSingle();
        if (prefs.error) throw prefs.error;
        // without a filter, a missing settings row really means there is none on the server
        return { rows, settingsRow: prefs.data, settingsComplete: !settingsSince };
    }

    async function pullAndMerge(db, uid, opts) {
        const state = loadState();
        const newHere = state.userId !== uid || !state.lastSyncAt;
        const capsFresh = Boolean(state.caps) && Date.now() - (state.caps.checkedAt || 0) < CAPS_TTL;
        let useClock = Boolean(opts.manual) || !capsFresh || Boolean(state.caps.serverClock);
        let full = Boolean(opts.full) || newHere || !useClock || !state.cursor || Date.now() - (state.lastFullAt || 0) > FULL_EVERY;
        let probeToken = null;

        if (!useClock) {
            probeToken = await probeRemote(db);
            const due = opts.full || newHere || Date.now() - (state.lastFullAt || 0) > FULL_EVERY;
            if (!due && probeToken === state.probeToken) return;
        }

        let remote;
        try {
            remote = await fetchRemote(db, useClock, full ? null : state);
        } catch (err) {
            if (!useClock || !missingServerClock(err)) throw err;
            saveState({ caps: { serverClock: false, checkedAt: Date.now() }, cursor: null, settingsCursor: null });
            useClock = false;
            full = true;
            probeToken = await probeRemote(db);
            remote = await fetchRemote(db, false, null);
        }
        if (useClock && !(capsFresh && state.caps.serverClock)) {
            saveState({ caps: { serverClock: true, checkedAt: Date.now() } });
        }
        if (!user || user.id !== uid) return;

        // from here to saveState: synchronous, so no local change can slip in between
        const st = loadState();
        // data on this device that was synced for another account is replaced, never merged in
        const foreignLocal = Boolean(st.userId) && st.userId !== uid;
        const firstSync = !foreignLocal && (!st.userId || !st.lastSyncAt);
        const local = app().getHistory();
        const pending = foreignLocal ? {} : Object.assign({}, st.pending);
        const merged = foreignLocal ? {} : Object.assign({}, local);
        const remoteNames = new Set();

        for (const row of remote.rows) {
            const name = row.file_name;
            remoteNames.add(name);
            const mine = foreignLocal ? null : local[name];
            // an unsent change here wins only when it is newer than the server copy
            const unsent = Boolean(mine) && (name in pending || firstSync);
            if (unsent && localUpdated(mine) > parseTime(row.updated_at)) {
                if (!(name in pending)) pending[name] = localUpdated(mine);
                continue;
            }
            merged[name] = entryFromRow(row, local[name]);
            delete pending[name];
        }

        if (full && !foreignLocal) {
            // entries this device has that the server does not
            for (const [name, entry] of Object.entries(local)) {
                if (remoteNames.has(name) || !entry) continue;
                if (name in pending) {
                    // changed here and not sent yet: kept, pushed below
                } else if (firstSync) {
                    pending[name] = localUpdated(entry); // first sync: upload this device's history
                } else {
                    // deleted on the server (e.g. "Delete my synced data"): kept here, not pushed
                }
            }
        }

        const changedNames = [...new Set([...Object.keys(local), ...Object.keys(merged)])]
            .filter((name) => entryDiffers(local[name], merged[name]));
        if (changedNames.length) app().applyRemoteHistory(merged, changedNames);

        const row = remote.settingsRow;
        const remoteChangedAt = row ? parseTime(row.updated_at) : 0;
        let settingsPending = foreignLocal ? false : Boolean(st.settingsPending);
        let settingsChangedAt = foreignLocal ? 0 : (st.settingsChangedAt || 0);
        let settingsSeenAt = foreignLocal ? 0 : (st.settingsSeenAt || 0);
        if (row && remoteChangedAt > settingsSeenAt && !(settingsPending && settingsChangedAt > remoteChangedAt)) {
            app().applyReaderSettings(row.reader || {});
            if (finder()) finder().setChannels(row.channels || []);
            settingsSeenAt = remoteChangedAt;
            settingsPending = false;
        } else if (!row && remote.settingsComplete) {
            if (foreignLocal) {
                // the previous account's channel list must not move into this one
                if (finder()) finder().setChannels([]);
            } else {
                // nothing on the server yet: upload this device's settings
                settingsPending = true;
                if (!settingsChangedAt) settingsChangedAt = Date.now();
            }
        }

        saveState({
            userId: uid,
            pending,
            settingsPending,
            settingsChangedAt,
            settingsSeenAt,
            cursor: useClock ? maxServerTime(full ? null : st.cursor, remote.rows) : null,
            settingsCursor: useClock ? maxServerTime(remote.settingsComplete ? null : st.settingsCursor, row ? [row] : []) : null,
            lastFullAt: full ? Date.now() : st.lastFullAt || 0,
            probeToken: useClock ? null : probeToken
        });
    }

    /* push: only what changed here and has not been confirmed by the server */

    async function pushPending(db, uid) {
        const state = loadState();
        if (state.userId !== uid) return; // the first merge for this account has not run yet
        const history = app().getHistory();
        const sent = Object.assign({}, state.pending);
        const rows = Object.keys(sent)
            .filter((name) => history[name])
            .map((name) => rowFromEntry(name, history[name]));
        if (rows.length) await upsertProgress(db, rows);
        if (Object.keys(sent).length) clearPending(sent);
        if (state.settingsPending) {
            await pushSettings(db, state.settingsChangedAt);
            if ((loadState().settingsChangedAt || 0) === (state.settingsChangedAt || 0)) {
                saveState({ settingsPending: false });
            }
        }
    }

    /* scheduler */

    // minimum gap between automatic pulls per reason
    const PULL_GAP = {
        pull: 5000,
        visible: 5000,
        focus: 5000,
        pageshow: 5000,
        online: 5000,
        interval: 5000,
        'reader-closed': 5000,
        'reader-opened': 3000
    };
    // automatic reasons do nothing while the page is hidden (the flush on hide is separate)
    const AUTOMATIC = new Set([...Object.keys(PULL_GAP), 'push', 'retry']);

    // reasons: signin, manual, flush, push, retry and the PULL_GAP keys
    function requestSync(reason, opts = {}) {
        if (!user || !configured) return Promise.resolve();
        if (isOffline()) {
            render();
            return running || Promise.resolve();
        }
        if (AUTOMATIC.has(reason) && !isVisible()) return running || Promise.resolve();

        const next = { pull: Boolean(opts.pull || opts.full), full: Boolean(opts.full), manual: Boolean(opts.manual) };
        if (next.pull && !next.full && PULL_GAP[reason] && Date.now() - lastPullAt < PULL_GAP[reason]) {
            next.pull = false;
        }
        if (next.pull) lastPullAt = Date.now();
        if (!next.pull && !hasPending(loadState())) return running || Promise.resolve();

        queued = queued
            ? { pull: queued.pull || next.pull, full: queued.full || next.full, manual: queued.manual || next.manual }
            : next;
        if (!running) running = runLoop();
        return running;
    }

    async function runLoop() {
        for (;;) {
            if (!queued) {
                running = null;
                return;
            }
            const opts = queued;
            queued = null;
            try {
                if (navigator.locks && navigator.locks.request) {
                    // one cycle at a time across this browser's tabs
                    await navigator.locks.request('comic-reader-sync', () => runCycle(opts));
                } else {
                    await runCycle(opts);
                }
            } catch (err) {
                console.warn('Sync failed:', err);
            }
        }
    }

    // pull (when asked or needed), merge, then push what is pending
    async function runCycle(opts) {
        if (!user || !configured) return;
        const uid = user.id;
        const state = loadState();
        const newHere = state.userId !== uid || !state.lastSyncAt;
        showSyncing = Boolean(opts.manual) || newHere;
        if (showSyncing) render();
        try {
            const db = await getClient();
            if (opts.pull || newHere) await pullAndMerge(db, uid, opts);
            if (!user || user.id !== uid) return;
            await pushPending(db, uid);
            failures = 0;
            lastError = '';
            clearTimeout(retryTimer);
            retryTimer = null;
            saveState({ lastSyncAt: Date.now() });
            if (opts.manual) showMessage('Everything is in sync.', 'info');
        } catch (err) {
            failures += 1;
            lastError = err.message || String(err);
            console.warn('Sync failed:', err);
            scheduleRetry(opts);
        } finally {
            showSyncing = false;
            render();
        }
    }

    function scheduleRetry(opts) {
        clearTimeout(retryTimer);
        const delay = BACKOFF[Math.min(failures, BACKOFF.length) - 1];
        retryTimer = setTimeout(() => {
            retryTimer = null;
            requestSync('retry', { pull: opts.pull, full: opts.full });
        }, delay);
    }

    function firePush() {
        pushTimer = null;
        requestSync('push');
    }

    // library: wait until changes settle; reader open: at most every READING_PUSH_WAIT
    function schedulePush() {
        if (!user) return;
        if (readerOpen) {
            if (!pushTimer) pushTimer = setTimeout(firePush, READING_PUSH_WAIT);
        } else {
            clearTimeout(pushTimer);
            pushTimer = setTimeout(firePush, PUSH_DELAY);
        }
    }

    // the page is being hidden or closed: send what is pending right away
    function flush() {
        clearTimeout(pushTimer);
        pushTimer = null;
        stopTicker();
        if (!user || !hasPending(loadState())) return;
        flushing = true;
        requestSync('flush').finally(() => { flushing = false; });
    }

    function tick() {
        if (!user || !isVisible()) {
            stopTicker();
            return;
        }
        render();
        if (isOffline()) return;
        const state = loadState();
        // with the server clock an incremental pull is cheap; otherwise probe once a minute
        if (!(state.caps && state.caps.serverClock) && Date.now() - lastPullAt < PROBE_EVERY - 1000) return;
        requestSync('interval', { pull: true });
    }

    function startTicker() {
        if (ticker || !user || !isVisible()) return;
        ticker = setInterval(tick, TICK);
    }

    function stopTicker() {
        clearInterval(ticker);
        ticker = null;
    }

    /* triggers */

    document.addEventListener('comicreader:history-changed', (event) => {
        const names = event.detail && Array.isArray(event.detail.names) ? event.detail.names : null;
        markHistoryPending(names);
        schedulePush();
    });
    ['comicreader:settings-changed', 'comicreader:channels-changed'].forEach((name) => {
        document.addEventListener(name, () => {
            saveState({ settingsPending: true, settingsChangedAt: Date.now() });
            schedulePush();
        });
    });

    document.addEventListener('comicreader:reader-opened', () => {
        readerOpen = true;
        // usually lands before the reader restores the last page
        requestSync('reader-opened', { pull: true });
    });
    document.addEventListener('comicreader:reader-closed', () => {
        readerOpen = false;
        clearTimeout(pushTimer);
        pushTimer = null;
        requestSync('push');
        requestSync('reader-closed', { pull: true });
    });

    // script.js registers its own listener first, so the last page is saved before this pushes
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
            flush();
            return;
        }
        startTicker();
        render();
        requestSync('visible', { pull: true });
    });
    window.addEventListener('pagehide', flush);
    window.addEventListener('pageshow', (event) => {
        if (!event.persisted) return;
        startTicker();
        requestSync('pageshow', { pull: true });
    });
    window.addEventListener('focus', () => requestSync('focus', { pull: true }));
    window.addEventListener('online', () => {
        render();
        if (configured && !client) {
            // the library or session could not load while offline
            getClient().catch((err) => {
                lastError = err.message || String(err);
                render();
            });
        }
        requestSync('online', { pull: true });
    });
    window.addEventListener('offline', render);

    window.CloudSync = {
        onShow() {
            render();
        },
        sync: () => requestSync('manual', { full: true, manual: true }),
        // a quick catch-up before a local change that should land on top of other devices' progress
        pullNow: () => Promise.race([requestSync('pull', { pull: true }), wait(3000)])
    };

    migrateState();
    render();
    if (configured) {
        // restores an existing session (or one from an email link) and syncs it
        getClient().catch((err) => {
            lastError = err.message || String(err);
            render();
        });
    }
});
