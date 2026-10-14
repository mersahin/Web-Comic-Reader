/*
 * Sync across devices: reading progress, Recently Read, reader settings and
 * "My channels", stored per user in Supabase (see supabase/schema.sql).
 *
 * Sync runs by itself: on sign-in, on a timer while the page is visible, when
 * the tab comes back, when a comic is opened or closed and when the network
 * returns. Local changes are remembered in `pending` and pushed within seconds.
 *
 * Merge rule: the server copy wins unless this device has an unsent change
 * that is newer (per comic, and for the settings as a whole). A change made
 * here is always stamped after the version it was made on, so device clocks
 * that run ahead or behind cannot make it lose. Comic files and Telegram
 * logins never leave the device.
 *
 * The auth session lives in sessionStorage unless "Stay signed in" is ticked,
 * because every project on the same <user>.github.io origin shares localStorage.
 *
 * A session that arrives in the URL never syncs: anyone can send a link with
 * the tokens of their own account, and this device's history would upload
 * there. A confirmation link only says that the email is confirmed; a reset
 * link shows the new-password form, and that session ends once it is saved.
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
     *   caps: { serverClock, checkedAt }, lastFullAt,
     *   activeUserId, activeAt (heartbeat: the account a tab synced last, and when) }
     */
    const STATE_KEY = 'comic_sync_state';
    const PERSIST_KEY = 'comic_sync_persist'; // '1' = keep the session in localStorage
    const LINK_KEY = 'comic_sync_reset';      // sessionStorage: this tab holds a session from a reset link
    const OTHER_ACCOUNT_WAIT = 2 * 60 * 1000; // another account synced this recently in another tab: wait
    const PUSH_DELAY = 1500;                  // library: wait for changes to settle
    const READING_PUSH_WAIT = 10 * 1000;      // reader open: push at most this late
    const TICK = 30 * 1000;                   // incremental pull (and status refresh)
    const FULL_PULL_EVERY = 60 * 1000;        // timer pulls when the server clock is missing (full pulls)
    const FULL_EVERY = 15 * 60 * 1000;
    const CAPS_TTL = 24 * 60 * 60 * 1000;
    const CURSOR_OVERLAP = 10 * 1000;         // transactions can commit out of order with now()
    const PAGE_SIZE = 1000;                   // Supabase default max rows per request
    const FETCH_TIMEOUT = 20 * 1000;
    const LIBRARY_TIMEOUT = 15 * 1000;
    const PENDING_STALE = 15 * 1000;          // longer than one reading push interval
    const BACKOFF = [15, 30, 60, 120, 300].map((s) => s * 1000);
    const UPSERT_CHUNK = 200;
    const LOOKUP_CHUNK = 100;                 // file names per .in() lookup
    const LOOKUP_URL_MAX = 6000;              // and at most this many URL characters
    const PROGRESS_COLS = 'file_name,last_page,total_pages,source,hidden,read_at,updated_at';
    const SETTINGS_COLS = 'reader,channels,updated_at';
    // Postgres refuses the row itself: check constraint, NUL or bad text, value too long
    const ROW_ERRORS = ['23514', '22P05', '22P02', '22021', '22001'];
    const ABORTED = 'sync-aborted';
    // supabase-js's default storage key for this project's session
    const AUTH_KEY = (() => {
        try {
            return `sb-${new URL(config.supabaseUrl).hostname.split('.')[0]}-auth-token`;
        } catch (e) {
            return '';
        }
    })();
    // fixed texts for the error codes an email link can bring; text from the URL itself is never shown
    const LINK_ERRORS = {
        otp_expired: 'This email link has expired or was already used. Request a new one below.'
    };
    const LINK_ERROR = 'This email link is invalid or has expired. Request a new one below.';
    const link = readEmailLink();

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
    let deleting = false;   // "Delete my synced data" is running: no sync cycles
    let authSeq = 0;        // only the newest auth event sets `user`
    let syncUserId = null;  // the account whose sync was started in this tab
    let otherAccount = false; // another account is syncing in another tab: this tab waits
    let leaving = false;    // the page is being closed: its heartbeat no longer counts
    // this tab holds (or held) a session from a reset link: it stays in this tab's sessionStorage
    let linkTab = false;
    const skippedNames = new Set(); // names the server cannot store, reported once

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

    // session in sessionStorage by default, localStorage only with "Stay signed in". A session from a
    // reset link never touches localStorage, so other tabs keep theirs and never see it
    const authStorage = {
        getItem(key) {
            try {
                return linkTab ? sessionStorage.getItem(key) : sessionStorage.getItem(key) ?? localStorage.getItem(key);
            } catch (e) {
                return null;
            }
        },
        setItem(key, value) {
            try {
                if (linkTab) {
                    sessionStorage.setItem(key, value);
                } else if (persistSession()) {
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
                if (!linkTab) localStorage.removeItem(key);
            } catch (e) {
                // storage unavailable
            }
        }
    };

    /*
     * What an email link left in the URL: { error: code } for a failed one, { session: type } for
     * one with tokens. Only reset links (type=recovery) are handed to the library.
     */
    function readEmailLink() {
        const params = {};
        try {
            new URLSearchParams(window.location.search).forEach((value, key) => { params[key] = value; });
            new URLSearchParams(window.location.hash.slice(1)).forEach((value, key) => { params[key] = value; });
        } catch (e) {
            return null;
        }
        if (params.error || params.error_code || params.error_description) return { error: params.error_code || '' };
        if (params.access_token) return { session: params.type === 'recovery' ? 'recovery' : 'other', token: params.access_token };
        return null;
    }

    const stripLink = () => history.replaceState(history.state, '', redirectUrl());

    function readLinkMark() {
        try {
            return sessionStorage.getItem(LINK_KEY) === '1';
        } catch (e) {
            return false;
        }
    }

    function setLinkMark(on) {
        try {
            if (on) sessionStorage.setItem(LINK_KEY, '1');
            else sessionStorage.removeItem(LINK_KEY);
        } catch (e) {
            // storage unavailable
        }
    }

    // the access token of this tab's own stored session (sessionStorage only)
    function tabSessionToken() {
        try {
            const stored = JSON.parse(sessionStorage.getItem(AUTH_KEY) || 'null');
            return (stored && stored.access_token) || '';
        } catch (e) {
            return '';
        }
    }

    // ends a link's session on the server without storing it here; errors (an expired token) do not matter
    async function revokeToken(token) {
        if (!token) return;
        try {
            const auth = (await getClient()).auth;
            if (auth.admin && auth.admin.signOut) await auth.admin.signOut(token, 'local');
        } catch (err) {
            // offline or already invalid: the session expires by itself
        }
    }

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
                        // only a reset link opened in this tab; every other link was taken out of the URL already
                        detectSessionInUrl: (url, params) => linkTab && params.type === 'recovery' && Boolean(params.access_token)
                    },
                    global: { fetch: wrappedFetch }
                });
                client.auth.onAuthStateChange((event) => {
                    // keep the callback synchronous; Supabase runs it inside its auth lock
                    setTimeout(() => onAuthChange(event), 0);
                });
                client.auth.initialize().then(({ error }) => {
                    if (!recovering || !error) return;
                    // the reset link could not be used (expired or already used): the tab's own session counts again
                    endRecovery();
                    stripLink();
                    app() && app().showAccount();
                    showMessage(LINK_ERROR, 'error');
                    onAuthChange('INITIAL_SESSION');
                });
                return client;
            }).finally(() => { clientPromise = null; });
        }
        return clientPromise;
    }

    /*
     * Events can come from other tabs (supabase-js relays them over a
     * BroadcastChannel together with that tab's session), so `user` is always
     * read from this tab's own session.
     */
    async function onAuthChange() {
        const seq = ++authSeq;
        let session = null;
        try {
            const { data, error } = await (await getClient()).auth.getSession();
            session = data && data.session;
            // a refresh failed offline and the library kept the session: nothing changed yet
            if (error && !session && hasStoredSession()) return;
        } catch (err) {
            return;
        }
        if (seq !== authSeq) return;

        const previous = user ? user.id : null;
        user = session && session.user ? session.user : null;
        const uid = user ? user.id : null;
        if (uid !== previous) {
            // the previous account's timers, errors, backoff and heartbeat do not carry over
            stopTimers();
            failures = 0;
            lastError = '';
            otherAccount = false;
            syncUserId = null;
            releaseHeartbeat(previous);
        }
        // the session of a reset link never syncs (the account may not even be the user's own)
        if (user && !recovering && syncUserId !== uid) {
            syncUserId = uid;
            requestSync('signin', { pull: true, full: true });
            startTicker();
        }
        render();
    }

    // the reset is over (password saved, or the link could not be used)
    function endRecovery() {
        recovering = false;
        linkTab = false;
        setLinkMark(false);
    }

    // this tab stops syncing `uid` (signed out or switched): other accounts need not wait for it
    function releaseHeartbeat(uid) {
        if (uid && loadState().activeUserId === uid) saveState({ activeAt: 0 });
    }

    const hasStoredSession = () => Boolean(AUTH_KEY) && authStorage.getItem(AUTH_KEY) !== null;

    // what signOut removes; done by hand when the library could not finish (offline, expired token)
    function removeAuthKeys() {
        if (!AUTH_KEY) return;
        ['', '-user', '-code-verifier', '-flows-code-verifier'].forEach((suffix) => authStorage.removeItem(AUTH_KEY + suffix));
    }

    // ends the session in this browser only; the user's other devices stay signed in
    async function signOutHere() {
        let error = null;
        try {
            ({ error } = await (await getClient()).auth.signOut({ scope: 'local' }));
        } catch (err) {
            error = err;
        }
        if (error) removeAuthKeys();
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
        if (recovering) {
            els.status.textContent = 'Choose a new password';
            els.barText.textContent = 'Choose a new password to finish the reset';
            els.bar.dataset.state = 'off';
            els.barBtn.textContent = 'Account';
        } else if (user) {
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
            } else if (otherAccount) {
                barState = 'pending';
                barText = 'Another account is syncing in another tab';
                status = `${barText}. Sync resumes here when that tab logs out, closes or stays hidden for 2 minutes.`;
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
                // setMode clears the message, so it goes first
                if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
                    // with email confirmation on, Supabase answers a registered address like a new one and sends nothing
                    setMode('signin');
                    showMessage('An account with this email already exists. Sign in or use "Forgot password?".', 'error');
                } else if (!data.session) {
                    setMode('signin');
                    showMessage('Account created. Open the link in the email we just sent to confirm it, then sign in here.', 'info');
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
            // the link's session ends here (still no sync); the user signs in with the new password
            await signOutHere();
            user = null;
            endRecovery();
            stripLink();
            setMode('signin');
            showMessage('Your new password is saved. Sign in with it below.', 'info');
        } catch (err) {
            showMessage(err.message || String(err), 'error');
        } finally {
            busy(els.recoveryForm, false);
            render();
        }
    });

    els.syncNow.addEventListener('click', () => window.CloudSync.sync());

    els.logout.addEventListener('click', async () => {
        if (!user) return;
        busy(els.signedIn, true);
        stopTimers();
        try {
            // send what is still pending, but never wait long for it
            await Promise.race([requestSync('push'), wait(4000)]);
            await signOutHere();
        } finally {
            releaseHeartbeat(user && user.id);
            user = null;
            failures = 0;
            lastError = '';
            busy(els.signedIn, false);
            showMessage('Logged out. Your progress stays on this device.', 'info');
            render();
        }
    });

    els.deleteData.addEventListener('click', async () => {
        if (!user || deleting) return;
        if (!confirm('Delete your synced progress, settings and channel list from the server?\nThis device keeps its own copy. You will be logged out.')) return;
        const uid = user.id;
        deleting = true;
        busy(els.signedIn, true);
        stopTimers();
        queued = null;
        try {
            // a running cycle stops before its next write; then nothing can re-insert rows meanwhile
            if (running) await running;
            await withSyncLock(async () => {
                const db = await getClient();
                const progress = await db.from('reading_progress').delete().eq('user_id', uid);
                if (progress.error) throw progress.error;
                const prefs = await db.from('user_settings').delete().eq('user_id', uid);
                if (prefs.error) throw prefs.error;
                // not a first sync next time: this device's copy is not uploaded again at the next sign-in
                saveState({
                    userId: uid,
                    lastSyncAt: Date.now(),
                    pending: {},
                    settingsPending: false,
                    cursor: null,
                    settingsCursor: null,
                    settingsSeenAt: 0,
                    lastFullAt: 0
                });
            });
            await signOutHere();
            releaseHeartbeat(uid);
            user = null;
            failures = 0;
            lastError = '';
            showMessage('Your synced data was deleted from the server and you are logged out.', 'info');
        } catch (err) {
            showMessage(err.message || String(err), 'error');
        } finally {
            deleting = false;
            busy(els.signedIn, false);
            if (user) startTicker();
            render();
        }
    });

    /* ---------------- sync ---------------- */

    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    // a missing, broken or out-of-range time becomes now, so toISOString never throws
    const safeMs = (v) => (Number.isFinite(v) && v > 0 && v < 8.64e15 ? v : Date.now());
    const toIso = (ms) => new Date(safeMs(ms)).toISOString();
    const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?:^|[^\ud800-\udbff])[\udc00-\udfff]/;
    // what reading_progress.file_name accepts: 1 to 512 characters, no NUL, valid Unicode
    const validName = (name) => typeof name === 'string'
        && name.length >= 1
        && (name.length <= 512 || Array.from(name).length <= 512) // char_length counts code points
        && !name.includes('\u0000')
        && (typeof name.isWellFormed === 'function' ? name.isWellFormed() : !LONE_SURROGATE.test(name));
    const isRowError = (error) => Boolean(error) && ROW_ERRORS.includes(error.code);
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

    // a cycle stops before its next write when the account changed or its data is being deleted
    function checkUser(uid) {
        if (user && user.id === uid && !deleting && !recovering) return;
        const err = new Error('Sync stopped because the account changed');
        err.code = ABORTED;
        throw err;
    }

    function skipName(name, reason) {
        if (skippedNames.has(name)) return;
        skippedNames.add(name);
        console.warn(`Sync skips "${String(name).slice(0, 80)}" (kept on this device only): ${reason}`);
    }

    function rowFromEntry(uid, fileName, entry) {
        const source = ['upload', 'folder', 'telegram'].includes(entry.source) ? entry.source : null;
        return {
            user_id: uid,
            file_name: fileName,
            last_page: Math.max(0, entry.last_page | 0),
            total_pages: entry.total_pages > 0 ? entry.total_pages | 0 : null,
            source,
            hidden: Boolean(entry.hidden_from_recent),
            read_at: toIso(entry.timestamp),
            updated_at: toIso(localUpdated(entry))
        };
    }

    // local-only fields (thumbnail and anything else) stay as they are on this device. Opening a comic
    // is not synced as a change, so the page count and the newer last read time found here are kept
    function entryFromRow(row, local) {
        const entry = Object.assign({}, local, {
            last_page: row.last_page || 0,
            total_pages: row.total_pages || (local && local.total_pages) || null,
            source: row.source || null,
            timestamp: Math.max(Date.parse(row.read_at) || 0, (local && local.timestamp) || 0) || Date.now(),
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

    /*
     * refused: names the database cannot store; one such row never blocks the others.
     * skipped: names it did not store because it keeps a newer copy (sync_stamp_row in
     * schema.sql answers without an error and leaves them out of the returned rows).
     */
    async function upsertProgress(db, uid, rows) {
        const upsert = (list) => db.from('reading_progress').upsert(list, { onConflict: 'user_id,file_name' }).select('file_name');
        const refused = [];
        const skipped = [];
        const noteSkipped = (list, data) => {
            if (!Array.isArray(data)) return;
            const stored = new Set(data.map((row) => row && row.file_name));
            list.forEach((row) => { if (!stored.has(row.file_name)) skipped.push(row.file_name); });
        };
        for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
            const chunk = rows.slice(i, i + UPSERT_CHUNK);
            checkUser(uid);
            const { data, error } = await upsert(chunk);
            if (!error) {
                noteSkipped(chunk, data);
                continue;
            }
            if (!isRowError(error)) throw error;
            // find the refused rows one by one and send the rest
            for (const row of chunk) {
                checkUser(uid);
                const single = await upsert([row]);
                if (!single.error) {
                    noteSkipped([row], single.data);
                    continue;
                }
                if (!isRowError(single.error)) throw single.error;
                skipName(row.file_name, single.error.message);
                refused.push(row.file_name);
            }
        }
        return { refused, skipped };
    }

    function localSettings() {
        return {
            reader: app() ? app().getReaderSettings() : {},
            channels: finder() ? finder().getChannels() : []
        };
    }

    // false when the server kept newer settings instead (no row comes back, see upsertProgress)
    async function pushSettings(db, uid, changedAt) {
        const { reader, channels } = localSettings();
        checkUser(uid);
        const { data, error } = await db.from('user_settings').upsert({
            user_id: uid,
            reader,
            channels,
            updated_at: toIso(changedAt)
        }, { onConflict: 'user_id' }).select('updated_at');
        if (error) throw error;
        return !(Array.isArray(data) && data.length === 0);
    }

    /* change tracking: works while signed out too, the next sync sends it */

    // the sync state belongs to another account (synced in another tab, or not merged here yet): a
    // change made here must not be sent into that account
    const foreignTab = (state) => Boolean(syncUserId) && Boolean(state.userId) && state.userId !== syncUserId;

    function markHistoryPending(names) {
        const history = app() ? app().getHistory() : {};
        const state = loadState();
        if (foreignTab(state)) return;
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

    // names the server can never store: retrying them would only fail again
    function dropPending(names) {
        if (!names.length) return;
        const pending = Object.assign({}, loadState().pending);
        names.forEach((name) => { delete pending[name]; });
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

    // groups of names for .in() lookups, small enough for the request URL
    function lookupChunks(names) {
        const chunks = [];
        let chunk = [];
        let size = 0;
        names.forEach((name) => {
            const length = encodeURIComponent(name).length + 3;
            if (chunk.length && (chunk.length >= LOOKUP_CHUNK || size + length > LOOKUP_URL_MAX)) {
                chunks.push(chunk);
                chunk = [];
                size = 0;
            }
            chunk.push(name);
            size += length;
        });
        if (chunk.length) chunks.push(chunk);
        return chunks;
    }

    // the server rows of these names, and the settings row when `withSettings`
    async function fetchNamed(db, names, withSettings) {
        // a quote or backslash does not survive the .in() list syntax: those fetch everything instead
        if (names.some((name) => /["\\]/.test(name)) || names.length > 20 * LOOKUP_CHUNK) {
            const all = await fetchRemote(db, false, null);
            return withSettings ? all : { rows: all.rows, settingsRow: null, settingsComplete: false };
        }
        const rows = [];
        for (const chunk of lookupChunks(names)) {
            const { data, error } = await db.from('reading_progress').select(PROGRESS_COLS).in('file_name', chunk);
            if (error) throw error;
            rows.push(...(data || []));
        }
        let settingsRow = null;
        if (withSettings) {
            const prefs = await db.from('user_settings').select(SETTINGS_COLS).maybeSingle();
            if (prefs.error) throw prefs.error;
            settingsRow = prefs.data;
        }
        return { rows, settingsRow, settingsComplete: Boolean(withSettings) };
    }

    async function pullAndMerge(db, uid, opts) {
        const state = loadState();
        const newHere = state.userId !== uid || !state.lastSyncAt;
        const capsFresh = Boolean(state.caps) && Date.now() - (state.caps.checkedAt || 0) < CAPS_TTL;
        let useClock = Boolean(opts.manual) || !capsFresh || Boolean(state.caps.serverClock);
        // without the server clock every pull is a full one: nothing cheaper sees every change
        let full = Boolean(opts.full) || newHere || !useClock || !state.cursor || Date.now() - (state.lastFullAt || 0) > FULL_EVERY;

        let remote;
        try {
            remote = await fetchRemote(db, useClock, full ? null : state);
        } catch (err) {
            if (!useClock || !missingServerClock(err)) throw err;
            saveState({ caps: { serverClock: false, checkedAt: Date.now() }, cursor: null, settingsCursor: null });
            useClock = false;
            full = true;
            remote = await fetchRemote(db, false, null);
        }
        if (useClock && !(capsFresh && state.caps.serverClock)) {
            saveState({ caps: { serverClock: true, checkedAt: Date.now() } });
        }
        checkUser(uid);
        mergeRemote(uid, remote, { full, useClock, pull: true });
        return full;
    }

    /*
     * Merges server rows into this device's data. opts.full: `remote` holds every row, so local
     * entries missing there are known. opts.pull: a pull (cursors and lastFullAt move on).
     * opts.adopt: { name: pending mark } the server refused because it keeps a newer copy, and
     * opts.adoptSettings the same for the settings: the server copy is taken unless the change
     * here was replaced by a newer one meanwhile.
     */
    function mergeRemote(uid, remote, opts = {}) {
        const adopt = opts.adopt || {};
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
            const refused = name in adopt && pending[name] === adopt[name];
            if (unsent && !refused && localUpdated(mine) > parseTime(row.updated_at)) {
                if (!(name in pending)) pending[name] = localUpdated(mine);
                continue;
            }
            merged[name] = entryFromRow(row, local[name]);
            delete pending[name];
        }

        if (opts.full && !foreignLocal) {
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
        const settingsRefused = opts.adoptSettings !== undefined && settingsPending && settingsChangedAt === opts.adoptSettings;
        if (row && (settingsRefused || (remoteChangedAt > settingsSeenAt && !(settingsPending && settingsChangedAt > remoteChangedAt)))) {
            app().applyReaderSettings(row.reader || {});
            if (finder()) finder().setChannels(row.channels || []);
            settingsSeenAt = Math.max(settingsSeenAt, remoteChangedAt);
            settingsPending = false;
        } else if (!row && remote.settingsComplete) {
            if (foreignLocal) {
                // the previous account's channel list must not move into this one
                if (finder()) finder().setChannels([]);
            } else if (firstSync) {
                // nothing on the server yet: upload this device's settings
                settingsPending = true;
                if (!settingsChangedAt) settingsChangedAt = Date.now();
            }
            // otherwise deleted on the server ("Delete my synced data"): kept here, sent only after a new change
        }

        const patch = { userId: uid, pending, settingsPending, settingsChangedAt, settingsSeenAt };
        if (opts.pull) {
            const full = Boolean(opts.full);
            Object.assign(patch, {
                cursor: opts.useClock ? maxServerTime(full ? null : st.cursor, remote.rows) : null,
                settingsCursor: opts.useClock ? maxServerTime(remote.settingsComplete ? null : st.settingsCursor, row ? [row] : []) : null,
                lastFullAt: full ? Date.now() : st.lastFullAt || 0,
                probeToken: undefined // no longer used
            });
        }
        saveState(patch);
    }

    /* push: only what changed here and has not been confirmed by the server */

    // without the server clock nothing on the server keeps a newer row from being overwritten, so
    // the server copies of the pending names are merged first (`checked`: this cycle just did a full pull)
    function needsLookup(state, checked) {
        if (checked || (state.caps && state.caps.serverClock)) return false;
        if (!flushing) return true;
        // closing the tab leaves no time for a lookup: changes made since the last good sync go straight out
        const since = state.lastSyncAt || 0;
        const marks = Object.values(state.pending || {});
        if (state.settingsPending) marks.push(state.settingsChangedAt || 0);
        return failures > 0 || marks.some((mark) => mark <= since);
    }

    async function pushPending(db, uid, { checked = false } = {}) {
        let state = loadState();
        if (state.userId !== uid) return; // the first merge for this account has not run yet
        // e.g. a Telegram file name longer than 512 characters: stays on this device
        const invalid = Object.keys(state.pending || {}).filter((name) => !validName(name));
        invalid.forEach((name) => skipName(name, 'the file name cannot be stored on the server'));
        dropPending(invalid);
        state = loadState();
        if (!hasPending(state)) return;

        if (needsLookup(state, checked)) {
            const remote = await fetchNamed(db, Object.keys(state.pending || {}), Boolean(state.settingsPending));
            checkUser(uid);
            mergeRemote(uid, remote);
            state = loadState();
        }

        const history = app().getHistory();
        const sent = Object.assign({}, state.pending);
        const rows = Object.keys(sent)
            .filter((name) => history[name])
            .map((name) => rowFromEntry(uid, name, history[name]));
        const { refused, skipped } = rows.length ? await upsertProgress(db, uid, rows) : { refused: [], skipped: [] };
        if (skipped.length) {
            // not saved: the server has a newer copy, which this device takes now
            const adopt = {};
            skipped.forEach((name) => { adopt[name] = sent[name]; delete sent[name]; });
            const remote = await fetchNamed(db, skipped, false);
            checkUser(uid);
            mergeRemote(uid, remote, { adopt });
        }
        if (Object.keys(sent).length) clearPending(sent);
        dropPending(refused);
        if (state.settingsPending) {
            const changedAt = state.settingsChangedAt || 0;
            let stored = true;
            try {
                stored = await pushSettings(db, uid, changedAt);
            } catch (err) {
                if (!isRowError(err)) throw err;
                // refused settings must not block the sync; the next settings change tries again
                console.warn('Sync skips the settings the server refused:', err.message);
            }
            if (!stored) {
                const remote = await fetchNamed(db, [], true);
                checkUser(uid);
                mergeRemote(uid, remote, { adoptSettings: changedAt });
            }
            if ((loadState().settingsChangedAt || 0) === changedAt) {
                saveState({ settingsPending: false });
            }
        }
    }

    /* scheduler */

    // minimum gap between automatic pulls per reason
    const PULL_GAP = {
        pull: 1000, // pullNow: before opening a comic, Clear or Remove
        visible: 5000,
        focus: 5000,
        pageshow: 5000,
        online: 5000,
        interval: 5000,
        'reader-closed': 5000
    };
    // automatic reasons do nothing while the page is hidden (the flush on hide is separate)
    const AUTOMATIC = new Set([...Object.keys(PULL_GAP), 'push', 'retry']);

    // reasons: signin, manual, flush, push, retry and the PULL_GAP keys
    function requestSync(reason, opts = {}) {
        if (!user || !configured || deleting || recovering) return Promise.resolve();
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
                await withSyncLock(() => runCycle(opts));
            } catch (err) {
                console.warn('Sync failed:', err);
            }
        }
    }

    // one sync cycle (or the deletion of the synced data) at a time across this browser's tabs
    function withSyncLock(fn) {
        return navigator.locks && navigator.locks.request ? navigator.locks.request('comic-reader-sync', fn) : fn();
    }

    // pull (when asked or needed), merge, then push what is pending
    async function runCycle(opts) {
        if (!user || !configured || deleting || recovering) return;
        const uid = user.id;
        const state = loadState();
        // two accounts in two tabs share this device's history: the one that synced first keeps it
        // while it is active, and the other waits instead of replacing it
        if (state.activeUserId && state.activeUserId !== uid && Date.now() - (state.activeAt || 0) < OTHER_ACCOUNT_WAIT) {
            otherAccount = true;
            if (opts.manual) showMessage('Another account is syncing in another tab. Log out there first.', 'error');
            render();
            return;
        }
        otherAccount = false;
        if (!leaving) saveState({ activeUserId: uid, activeAt: Date.now() });
        const newHere = state.userId !== uid || !state.lastSyncAt;
        showSyncing = Boolean(opts.manual) || newHere;
        if (showSyncing) render();
        try {
            const db = await getClient();
            const checked = opts.pull || newHere ? await pullAndMerge(db, uid, opts) : false;
            await pushPending(db, uid, { checked });
            checkUser(uid);
            failures = 0;
            lastError = '';
            clearTimeout(retryTimer);
            retryTimer = null;
            saveState({ lastSyncAt: Date.now() });
            if (opts.manual) showMessage('Everything is in sync.', 'info');
        } catch (err) {
            // the account changed or its data is being deleted: not a failure
            if (err && err.code === ABORTED) return;
            failures += 1;
            lastError = err.message || String(err);
            console.warn('Sync failed:', err);
            if (opts.manual) showMessage(lastError, 'error');
            scheduleRetry(opts);
        } finally {
            showSyncing = false;
            render();
        }
    }

    // the retry keeps the pull option; without the server clock pushPending looks up the server copies first
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
        // with the server clock an incremental pull is cheap; otherwise a full pull every other tick
        // (at most FULL_PULL_EVERY after the last pull of any kind)
        if (!(state.caps && state.caps.serverClock) && Date.now() - lastPullAt < FULL_PULL_EVERY - TICK / 2) return;
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

    function stopTimers() {
        clearTimeout(pushTimer);
        pushTimer = null;
        clearTimeout(retryTimer);
        retryTimer = null;
        stopTicker();
    }

    /* triggers */

    document.addEventListener('comicreader:history-changed', (event) => {
        const names = event.detail && Array.isArray(event.detail.names) ? event.detail.names : null;
        markHistoryPending(names);
        schedulePush();
    });
    ['comicreader:settings-changed', 'comicreader:channels-changed'].forEach((name) => {
        document.addEventListener(name, () => {
            // after the settings version it was made on, whatever the device clocks say
            const state = loadState();
            if (foreignTab(state)) return;
            const changedAt = Math.max(Date.now(), (state.settingsSeenAt || 0) + 1, (state.settingsChangedAt || 0) + 1);
            saveState({ settingsPending: true, settingsChangedAt: changedAt });
            schedulePush();
        });
    });

    // the reader itself waits for pullNow before it restores the last page
    document.addEventListener('comicreader:reader-opened', () => {
        readerOpen = true;
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
    window.addEventListener('pagehide', () => {
        flush();
        // the last cycle may still run, but another account in another tab need not wait for this one
        leaving = true;
        releaseHeartbeat(user && user.id);
    });
    window.addEventListener('pageshow', (event) => {
        if (!event.persisted) return;
        leaving = false;
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
        // a quick catch-up before opening a comic or a local change that should land on top of
        // other devices' progress; resolves at once when signed out, offline or hidden
        pullNow: () => Promise.race([requestSync('pull', { pull: true }), wait(3000)])
    };

    // before the client exists, so the library never sees a link other than a reset link of this tab
    function handleEmailLink() {
        let notice = null;
        const tokens = [];
        if (link && link.session === 'recovery') {
            // only the new-password form until it is saved; no sync meanwhile
            linkTab = true;
            recovering = true;
            setLinkMark(true);
            notice = ['', 'info'];
        } else if (readLinkMark()) {
            // reloaded (or reopened) before the new password was saved: that session is dropped
            linkTab = true;
            tokens.push(tabSessionToken());
            removeAuthKeys();
            linkTab = false;
            setLinkMark(false);
            if (!link) notice = ['The password reset was not finished. Request a new link below.', 'error'];
        }
        if (link && link.error !== undefined) {
            stripLink();
            notice = [LINK_ERRORS[link.error] || LINK_ERROR, 'error'];
        } else if (link && link.session === 'other') {
            // a confirmation (or any other) link: the email is confirmed, its session is not used
            tokens.push(link.token);
            stripLink();
            notice = ['Email confirmed. Sign in with your password.', 'info'];
        }
        tokens.forEach(revokeToken);
        if (!notice) return;
        setMode('signin');
        showMessage(notice[0], notice[1]);
        app() && app().showAccount();
    }

    migrateState();
    if (configured) handleEmailLink();
    render();
    if (configured) {
        // restores an existing session (a reset link's one only in this tab) and syncs it
        getClient().catch((err) => {
            lastError = err.message || String(err);
            render();
        });
    }
});
