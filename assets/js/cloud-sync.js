/*
 * Sync across devices: reading progress, Recently Read, reader settings and
 * "My channels", stored per user in Supabase (see supabase/schema.sql).
 *
 * Merge rule: for each comic (and for the settings as a whole) the version
 * changed last wins. Comic files and Telegram logins never leave the device.
 *
 * The auth session lives in sessionStorage unless "Stay signed in" is ticked,
 * because every project on the same <user>.github.io origin shares localStorage.
 */
document.addEventListener('DOMContentLoaded', () => {
    const config = window.COMIC_SYNC_CONFIG || {};
    const configured = /^https:\/\/.+/.test(config.supabaseUrl || '') && Boolean(config.supabaseAnonKey);

    const SUPABASE_SRC = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/dist/umd/supabase.js';
    const SUPABASE_SRI = 'sha384-Rj26LVGvoeRVR6+mwQmFfcR3QOBEwT+ZmuCWpuiqeTzJpCs0ER4ITAWGb4Hiy3Ok';
    const STATE_KEY = 'comic_sync_state';     // { userId, lastSyncAt, settingsChangedAt }
    const PERSIST_KEY = 'comic_sync_persist'; // '1' = keep the session in localStorage
    const PUSH_DELAY = 1500;
    const PULL_INTERVAL = 60 * 1000;
    const UPSERT_CHUNK = 200;

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
    let syncing = null;
    let isSyncing = false;
    let pushTimer = null;
    let lastError = '';

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
            const script = document.createElement('script');
            script.src = SUPABASE_SRC;
            script.integrity = SUPABASE_SRI;
            script.crossOrigin = 'anonymous';
            script.onload = () => (window.supabase ? resolve(window.supabase) : reject(new Error('Sync library failed to start')));
            script.onerror = () => reject(new Error('Could not load the sync library'));
            document.head.appendChild(script);
        });
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
                    }
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
            fullSync();
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
            const status = isSyncing ? 'Syncing…' : lastError ? `Sync failed: ${lastError}` : `Synced ${formatAgo(state.lastSyncAt)}`;
            els.status.textContent = status;
            els.barText.textContent = isSyncing ? 'Syncing…' : lastError ? 'Sync failed' : `Synced as ${user.email}`;
            els.bar.dataset.state = lastError ? 'error' : 'on';
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

    els.syncNow.addEventListener('click', () => fullSync(true));

    els.logout.addEventListener('click', async () => {
        clearTimeout(pushTimer);
        await pushChanges();
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

    const toIso = (ms) => new Date(ms || Date.now()).toISOString();
    const localUpdated = (entry) => (entry && (entry.updated_at || entry.timestamp)) || 0;

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

    function entryFromRow(row, local) {
        const entry = {
            last_page: row.last_page || 0,
            total_pages: row.total_pages || null,
            source: row.source || null,
            timestamp: Date.parse(row.read_at) || Date.now(),
            updated_at: Date.parse(row.updated_at) || Date.now(),
            thumbnail: (local && local.thumbnail) || null // thumbnails stay on the device
        };
        if (row.hidden) entry.hidden_from_recent = true;
        return entry;
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

    async function pushSettings(db) {
        const state = loadState();
        const { reader, channels } = localSettings();
        const { error } = await db.from('user_settings').upsert({
            user_id: user.id,
            reader,
            channels,
            updated_at: toIso(state.settingsChangedAt || Date.now())
        }, { onConflict: 'user_id' });
        if (error) throw error;
    }

    // pulls everything, merges with this device, pushes what is newer here
    function fullSync(manual = false) {
        if (!user || !configured) return Promise.resolve();
        if (syncing) return syncing;
        isSyncing = true;
        render();
        syncing = (async () => {
            const startedAt = Date.now();
            const db = await getClient();
            const state = loadState();
            // data on this device that was synced for another account is replaced, never merged in
            const foreignLocal = Boolean(state.userId) && state.userId !== user.id;

            const progress = await db.from('reading_progress').select('file_name,last_page,total_pages,source,hidden,read_at,updated_at');
            if (progress.error) throw progress.error;
            const remoteSettings = await db.from('user_settings').select('reader,channels,updated_at').maybeSingle();
            if (remoteSettings.error) throw remoteSettings.error;

            const local = app().getHistory();
            const merged = {};
            const toPush = [];
            const remoteNames = new Set();
            for (const row of progress.data || []) {
                remoteNames.add(row.file_name);
                const mine = local[row.file_name];
                if (!foreignLocal && mine && localUpdated(mine) > (Date.parse(row.updated_at) || 0)) {
                    merged[row.file_name] = mine;
                    toPush.push(rowFromEntry(row.file_name, mine));
                } else {
                    merged[row.file_name] = entryFromRow(row, mine);
                }
            }
            if (!foreignLocal) {
                for (const [name, entry] of Object.entries(local)) {
                    if (remoteNames.has(name) || !entry) continue;
                    merged[name] = entry;
                    toPush.push(rowFromEntry(name, entry));
                }
            }
            app().replaceHistory(merged);
            await upsertProgress(db, toPush);

            const row = remoteSettings.data;
            const remoteChangedAt = row ? Date.parse(row.updated_at) || 0 : 0;
            const localChangedAt = foreignLocal ? 0 : (state.settingsChangedAt || 0);
            if (row && remoteChangedAt >= localChangedAt) {
                app().applyReaderSettings(row.reader || {});
                if (finder()) finder().setChannels(row.channels || []);
                saveState({ settingsChangedAt: remoteChangedAt });
            } else if (foreignLocal) {
                // the previous account's channel list must not move into this one
                if (finder()) finder().setChannels([]);
                saveState({ settingsChangedAt: 0 });
            } else {
                if (!state.settingsChangedAt) saveState({ settingsChangedAt: Date.now() });
                await pushSettings(db);
            }

            lastError = '';
            saveState({ userId: user.id, lastSyncAt: startedAt });
            if (manual) showMessage('Everything is in sync.', 'info');
        })().catch((err) => {
            lastError = err.message || String(err);
            console.warn('Sync failed:', err);
        }).finally(() => {
            syncing = null;
            isSyncing = false;
            render();
        });
        return syncing;
    }

    // sends entries changed on this device since the last sync
    async function pushChanges() {
        if (!user || !configured) return;
        if (syncing) await syncing;
        const state = loadState();
        if (state.userId !== user.id) return fullSync();
        const since = state.lastSyncAt || 0;
        const startedAt = Date.now();
        try {
            const db = await getClient();
            const rows = Object.entries(app().getHistory())
                .filter(([, entry]) => entry && localUpdated(entry) > since)
                .map(([name, entry]) => rowFromEntry(name, entry));
            await upsertProgress(db, rows);
            if ((state.settingsChangedAt || 0) > since) await pushSettings(db);
            lastError = '';
            saveState({ lastSyncAt: startedAt });
        } catch (err) {
            lastError = err.message || String(err);
            console.warn('Sync push failed:', err);
        }
        render();
    }

    function schedulePush() {
        if (!user) return;
        clearTimeout(pushTimer);
        pushTimer = setTimeout(pushChanges, PUSH_DELAY);
    }

    document.addEventListener('comicreader:history-changed', schedulePush);
    ['comicreader:settings-changed', 'comicreader:channels-changed'].forEach((name) => {
        document.addEventListener(name, () => {
            saveState({ settingsChangedAt: Date.now() });
            schedulePush();
        });
    });

    // catch up with other devices when this tab comes back
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible' || !user) return;
        if (Date.now() - (loadState().lastSyncAt || 0) > PULL_INTERVAL) fullSync();
    });
    window.addEventListener('pagehide', () => {
        if (pushTimer) pushChanges();
    });

    window.CloudSync = {
        onShow() {
            render();
        },
        sync: () => fullSync(true)
    };

    render();
    if (configured) {
        // restores an existing session (or one from an email link) and syncs it
        getClient().catch((err) => {
            lastError = err.message || String(err);
            render();
        });
    }
});
