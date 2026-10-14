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
 * there. A confirmation or email-change link only says that it worked; a reset
 * link shows the new-password form, and that session ends once it is saved.
 * Text in the URL is never shown, only fixed messages chosen by its codes.
 *
 * The account view also changes the password or email address, resends the
 * confirmation email, signs out every device and deletes the account (the
 * delete_my_account() function in schema.sql).
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
    // the first of the two links of a secure email change lands on "#message=Confirmation link accepted…"
    const LINK_NOTICES = {
        email_change_partial: 'One confirmation link is accepted. Open the link sent to your other email address to finish the change.'
    };
    const MIN_PASSWORD = 8;
    // fixed texts for Supabase Auth error codes; other errors show the server's own message
    const AUTH_ERRORS = {
        email_not_confirmed: 'This email address is not confirmed yet. Open the link in the confirmation email, or send a new one below.',
        over_email_send_rate_limit: 'Too many emails were sent recently. Wait a while (up to an hour), then try again.',
        over_request_rate_limit: 'Too many attempts. Wait a few minutes, then try again.',
        weak_password: 'This password is too weak. Choose a longer one with a mix of letters, digits and symbols.',
        same_password: 'The new password must be different from your current one.',
        reauthentication_needed: 'For your security, log out and sign in again, then change your password.',
        current_password_required: 'Enter your current password.',
        current_password_invalid: 'Your current password is not correct.',
        invalid_credentials: 'Wrong email address or password.',
        email_exists: 'Another account already uses this email address.',
        email_address_invalid: 'This email address cannot be used. Check it for typos.',
        signup_disabled: 'New accounts cannot be created right now.',
        user_banned: 'This account is blocked.',
        session_not_found: 'Your session has ended. Sign in again.'
    };
    const PWNED_PASSWORD = 'This password appears in known data leaks. Choose a different one.';
    const OFFLINE_TEXT = 'Could not reach the server. Check your connection and try again.';
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
        confirmField: $('syncConfirmField'),
        passwordConfirm: $('syncPasswordConfirm'),
        persist: $('syncPersist'),
        submit: $('syncAuthSubmit'),
        forgot: $('syncForgotBtn'),
        resendRow: $('syncResendRow'),
        resend: $('syncResendBtn'),
        recoveryForm: $('syncRecoveryForm'),
        newPassword: $('syncNewPassword'),
        newPasswordConfirm: $('syncNewPasswordConfirm'),
        userEmail: $('syncUserEmail'),
        syncNow: $('syncNowBtn'),
        logout: $('syncLogoutBtn'),
        passwordSection: $('syncPasswordSection'),
        changePasswordForm: $('syncChangePasswordForm'),
        currentPassword: $('syncCurrentPassword'),
        changePassword: $('syncChangePassword'),
        changePasswordConfirm: $('syncChangePasswordConfirm'),
        passwordMessage: $('syncPasswordMessage'),
        emailSection: $('syncEmailSection'),
        changeEmailForm: $('syncChangeEmailForm'),
        newEmail: $('syncNewEmail'),
        emailMessage: $('syncEmailMessage'),
        logoutAll: $('syncLogoutAllBtn'),
        deleteData: $('syncDeleteBtn'),
        deleteAccountForm: $('syncDeleteAccountForm'),
        deleteConfirm: $('syncDeleteConfirm'),
        heading: document.querySelector('#accountView h1'),
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
    let emailChanged = false; // an email-change link was opened: a session of this tab shows the old address
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
     * What an email link left in the URL: { error: code } for a failed one, { session, type, token }
     * for one with tokens, { notice: key } for a message (key '' = nothing to show). Only reset
     * links (type=recovery) are handed to the library; the URL's own text is only compared, never shown.
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
        if (params.access_token) {
            const type = params.type === 'recovery' || params.type === 'email_change' ? params.type : 'other';
            return { session: type === 'recovery' ? 'recovery' : 'other', type, token: params.access_token };
        }
        if (params.message !== undefined) {
            return { notice: /^Confirmation link accepted\b/.test(params.message) ? 'email_change_partial' : '' };
        }
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
                        // only a reset link opened in this tab (handleEmailLink runs first and takes every
                        // other link out of the URL); supabase-js 2.117 does not call a function here
                        detectSessionInUrl: linkTab
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
            // nor anything typed into its forms
            resetSignedIn();
        }
        // the session of a reset link never syncs (the account may not even be the user's own)
        if (user && !recovering && syncUserId !== uid) {
            syncUserId = uid;
            requestSync('signin', { pull: true, full: true });
            startTicker();
        }
        if (emailChanged) {
            emailChanged = false;
            // a session kept in this tab still holds the old address; a refresh brings the new one
            if (user && !recovering) getClient().then((db) => db.auth.refreshSession()).catch(() => {});
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

    // ends the session in this browser only (scope 'global': every session of the account). This
    // browser is signed out either way; false when the server could not be told
    async function signOutHere(scope = 'local') {
        let error = null;
        try {
            ({ error } = await (await getClient()).auth.signOut({ scope }));
        } catch (err) {
            error = err;
        }
        if (error) removeAuthKeys();
        return !error;
    }

    /* ---------------- UI ---------------- */

    // `target`: the view's message below everything (default) or the one of a section
    function showMessage(text, kind = 'info', target = els.message) {
        if (!text) {
            target.hidden = true;
            return;
        }
        target.textContent = text;
        target.dataset.kind = kind;
        target.hidden = false;
    }

    function clearMessages() {
        [els.message, els.passwordMessage, els.emailMessage].forEach((box) => { box.hidden = true; });
        els.resendRow.hidden = true;
    }

    // a fixed text for the Auth errors people run into. `email`: the request sends an email,
    // `signup`: a new account (the Before User Created hook answers 403 while sign-ups are closed)
    function authErrorText(err, { email = false, signup = false } = {}) {
        if (!err) return '';
        const code = err.code || '';
        if (code === 'weak_password' && Array.isArray(err.reasons) && err.reasons.includes('pwned')) return PWNED_PASSWORD;
        if (AUTH_ERRORS[code]) return AUTH_ERRORS[code];
        if (err.status === 429) return email ? AUTH_ERRORS.over_email_send_rate_limit : AUTH_ERRORS.over_request_rate_limit;
        if (signup && err.status === 403) return AUTH_ERRORS.signup_disabled;
        if (err.name === 'AuthRetryableFetchError' || err.status === 0) return OFFLINE_TEXT;
        return err.message || String(err);
    }

    const codeError = (code) => Object.assign(new Error(AUTH_ERRORS[code] || code), { code });

    // the error of a new password and its confirmation, '' when both are fine
    function newPasswordProblem(password, confirmation) {
        if (password.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters for the new password.`;
        if (password !== confirmation) return 'The two passwords do not match.';
        return '';
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
        if (user || recovering) els.resendRow.hidden = true;

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

    /* show/hide buttons of the password fields; the name stays "Show password", aria-pressed tells the state */

    const EYE_ICONS = '<svg class="icon-show" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5z"/><circle cx="8" cy="8" r="2"/></svg>'
        + '<svg class="icon-hide" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M2 2l12 12"/><path d="M6.5 3.2A6.8 6.8 0 0 1 8 3c4.5 0 7 5 7 5a12 12 0 0 1-1.9 2.6M4.3 4.3C2.2 5.6 1 8 1 8s2.5 5 7 5a6.6 6.6 0 0 0 3.7-1.1"/><path d="M6.6 6.6a2 2 0 0 0 2.8 2.8"/></svg>';

    function setPasswordShown(button, input, shown) {
        input.type = shown ? 'text' : 'password';
        button.setAttribute('aria-pressed', String(shown));
        button.title = shown ? 'Hide password' : 'Show password';
    }

    function addPasswordToggle(input) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'password-toggle';
        button.setAttribute('aria-controls', input.id);
        button.setAttribute('aria-label', 'Show password');
        button.innerHTML = EYE_ICONS;
        setPasswordShown(button, input, false);
        button.addEventListener('click', () => setPasswordShown(button, input, input.type === 'password'));
        input.after(button);
    }

    // after a form is sent or left: its passwords are hidden again
    function hidePasswords(container) {
        container.querySelectorAll('.password-toggle').forEach((button) => {
            const input = $(button.getAttribute('aria-controls'));
            if (input) setPasswordShown(button, input, false);
        });
    }

    function setMode(next) {
        mode = next;
        const signup = next === 'signup';
        els.tabs.forEach((tab) => {
            const active = tab.dataset.tab === next;
            tab.classList.toggle('active', active);
            tab.setAttribute('aria-selected', String(active));
        });
        els.submit.textContent = signup ? 'Create account' : 'Sign in';
        els.password.autocomplete = signup ? 'new-password' : 'current-password';
        // the minimum is for new passwords; an existing one may be shorter
        if (signup) {
            els.password.minLength = MIN_PASSWORD;
            els.password.setAttribute('aria-describedby', 'syncPasswordHint');
        } else {
            els.password.removeAttribute('minlength');
            els.password.removeAttribute('aria-describedby');
            els.passwordConfirm.value = '';
        }
        els.passwordHint.hidden = !signup;
        els.confirmField.hidden = !signup;
        els.passwordConfirm.required = signup;
        els.forgot.hidden = signup;
        hidePasswords(els.form);
        clearMessages();
    }

    function busy(container, on) {
        container.querySelectorAll('button, input').forEach((el) => { el.disabled = on; });
    }

    // the signed-in part is empty and closed again for the next account
    function resetSignedIn() {
        els.signedIn.querySelectorAll('input').forEach((input) => { input.value = ''; });
        els.signedIn.querySelectorAll('details').forEach((section) => { section.open = false; });
        hidePasswords(els.signedIn);
        els.passwordMessage.hidden = true;
        els.emailMessage.hidden = true;
    }

    // logged out, signed out everywhere or deleted: the button that was used is gone, so the focus
    // moves to the heading (the message below is announced)
    function afterSignOut(text, kind) {
        resetSignedIn();
        render();
        showMessage(text, kind);
        const active = document.activeElement;
        if ((!active || active === document.body || els.signedIn.contains(active)) && els.heading && els.heading.getClientRects().length) {
            els.heading.focus();
        }
    }

    const redirectUrl = () => window.location.origin + window.location.pathname;

    els.tabs.forEach((tab) => tab.addEventListener('click', () => setMode(tab.dataset.tab)));
    els.barBtn.addEventListener('click', () => app() && app().showAccount());
    els.persist.checked = persistSession();
    document.querySelectorAll('#accountView .password-field input').forEach(addPasswordToggle);

    els.form.addEventListener('submit', async (event) => {
        event.preventDefault();
        clearMessages();
        const signup = mode === 'signup';
        const email = els.email.value.trim();
        const password = els.password.value;
        if (signup) {
            const problem = newPasswordProblem(password, els.passwordConfirm.value);
            if (problem) {
                showMessage(problem, 'error');
                (password.length < MIN_PASSWORD ? els.password : els.passwordConfirm).focus();
                return;
            }
        }
        busy(els.form, true);
        try {
            try {
                localStorage.setItem(PERSIST_KEY, els.persist.checked ? '1' : '0');
            } catch (e) {
                // storage unavailable
            }
            const auth = (await getClient()).auth;
            if (signup) {
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
                    els.resendRow.hidden = false;
                }
            } else {
                const { error } = await auth.signInWithPassword({ email, password });
                if (error) throw error;
            }
            els.password.value = '';
            els.passwordConfirm.value = '';
            hidePasswords(els.form);
        } catch (err) {
            showMessage(authErrorText(err, { email: signup, signup }), 'error');
            if (err && err.code === 'email_not_confirmed') els.resendRow.hidden = false;
        } finally {
            busy(els.form, false);
        }
    });

    els.resend.addEventListener('click', async () => {
        const email = els.email.value.trim();
        if (!email || !els.email.checkValidity()) {
            showMessage('Enter your email address first, then click "Resend confirmation email" again.', 'error');
            els.email.focus();
            return;
        }
        els.resend.disabled = true;
        try {
            const { error } = await (await getClient()).auth.resend({ type: 'signup', email, options: { emailRedirectTo: redirectUrl() } });
            if (error) throw error;
            showMessage('If this address has an account that is not confirmed yet, a new confirmation email is on its way.', 'info');
        } catch (err) {
            showMessage(authErrorText(err, { email: true }), 'error');
        } finally {
            els.resend.disabled = false;
        }
    });

    els.forgot.addEventListener('click', async () => {
        const email = els.email.value.trim();
        if (!email || !els.email.checkValidity()) {
            showMessage('Enter your email address first, then click "Forgot password?" again.', 'error');
            els.email.focus();
            return;
        }
        clearMessages();
        try {
            const { error } = await (await getClient()).auth.resetPasswordForEmail(email, { redirectTo: redirectUrl() });
            if (error) throw error;
            showMessage('If an account exists for this address, an email with a reset link is on its way.', 'info');
        } catch (err) {
            showMessage(authErrorText(err, { email: true }), 'error');
        }
    });

    els.recoveryForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        clearMessages();
        const password = els.newPassword.value;
        const problem = newPasswordProblem(password, els.newPasswordConfirm.value);
        if (problem) {
            showMessage(problem, 'error');
            (password.length < MIN_PASSWORD ? els.newPassword : els.newPasswordConfirm).focus();
            return;
        }
        let saved = false;
        busy(els.recoveryForm, true);
        try {
            const { error } = await (await getClient()).auth.updateUser({ password });
            if (error) throw error;
            els.newPassword.value = '';
            els.newPasswordConfirm.value = '';
            hidePasswords(els.recoveryForm);
            // the link's session ends here (still no sync); the user signs in with the new password
            await signOutHere();
            user = null;
            endRecovery();
            stripLink();
            setMode('signin');
            showMessage('Your new password is saved. Sign in with it below.', 'info');
            saved = true;
        } catch (err) {
            showMessage(authErrorText(err), 'error');
        } finally {
            busy(els.recoveryForm, false);
            render();
            // the form is gone: the sign-in form takes the focus
            if (saved && els.email.getClientRects().length) els.email.focus();
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
            afterSignOut('Logged out. Your progress stays on this device.', 'info');
        }
    });

    // every session of the account ends (Supabase revokes all its refresh tokens); local cleanup as Log out
    els.logoutAll.addEventListener('click', async () => {
        if (!user || deleting) return;
        if (!confirm('Sign out of all devices?\nEvery session of this account ends, here and on your other devices. Each device keeps its own copy of your progress.')) return;
        busy(els.signedIn, true);
        stopTimers();
        let reached = false;
        try {
            await Promise.race([requestSync('push'), wait(4000)]);
            reached = await signOutHere('global');
        } finally {
            releaseHeartbeat(user && user.id);
            user = null;
            failures = 0;
            lastError = '';
            busy(els.signedIn, false);
            if (reached) {
                afterSignOut('Signed out of all devices. Your progress stays on this device.', 'info');
            } else {
                afterSignOut('Logged out here, but the server could not be reached, so your other devices may still be signed in. Sign in and try again when you are online.', 'error');
            }
        }
    });

    els.changePasswordForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (!user || !user.email) return;
        const target = els.passwordMessage;
        clearMessages();
        const current = els.currentPassword.value;
        const next = els.changePassword.value;
        const problem = newPasswordProblem(next, els.changePasswordConfirm.value) || (next === current ? AUTH_ERRORS.same_password : '');
        if (problem) {
            showMessage(problem, 'error', target);
            (next.length < MIN_PASSWORD || next === current ? els.changePassword : els.changePasswordConfirm).focus();
            return;
        }
        let wrongCurrent = false;
        busy(els.changePasswordForm, true);
        try {
            const auth = (await getClient()).auth;
            // proves the current password; the fresh session also satisfies "Secure password change"
            const check = await auth.signInWithPassword({ email: user.email, password: current });
            if (check.error) throw check.error.code === 'invalid_credentials' ? codeError('current_password_invalid') : check.error;
            // current_password too, for projects that require it
            const { error } = await auth.updateUser({ password: next, current_password: current });
            if (error) throw error;
            [els.currentPassword, els.changePassword, els.changePasswordConfirm].forEach((input) => { input.value = ''; });
            hidePasswords(els.changePasswordForm);
            showMessage('Your password is changed. Your other devices are signed out; sign in there with the new password.', 'info', target);
        } catch (err) {
            showMessage(authErrorText(err), 'error', target);
            wrongCurrent = Boolean(err) && (err.code === 'current_password_invalid' || err.code === 'current_password_required');
        } finally {
            busy(els.changePasswordForm, false);
            // after the fields are enabled again
            if (wrongCurrent) els.currentPassword.focus();
        }
    });

    // secure email change (the Supabase default): links go to the current and the new address
    els.changeEmailForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (!user) return;
        const target = els.emailMessage;
        clearMessages();
        const email = els.newEmail.value.trim();
        const currentEmail = user.email || '';
        if (!email || !els.newEmail.checkValidity()) {
            showMessage('Enter the new email address.', 'error', target);
            els.newEmail.focus();
            return;
        }
        if (email.toLowerCase() === currentEmail.toLowerCase()) {
            showMessage('This is already your email address.', 'error', target);
            els.newEmail.focus();
            return;
        }
        busy(els.changeEmailForm, true);
        try {
            const { error } = await (await getClient()).auth.updateUser({ email }, { emailRedirectTo: redirectUrl() });
            if (error) throw error;
            els.newEmail.value = '';
            showMessage(`Confirmation links are on their way to ${currentEmail} and to ${email}. Open both to finish the change; until then you sign in with ${currentEmail}.`, 'info', target);
        } catch (err) {
            showMessage(authErrorText(err, { email: true }), 'error', target);
        } finally {
            busy(els.changeEmailForm, false);
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
        let done = false;
        try {
            // a running cycle stops before its next write; then nothing can re-insert rows meanwhile
            if (running) await running;
            await withSyncLock(async () => {
                const db = await getClient();
                const progress = await db.from('reading_progress').delete().eq('user_id', uid);
                if (progress.error) throw progress.error;
                const prefs = await db.from('user_settings').delete().eq('user_id', uid);
                if (prefs.error) throw prefs.error;
                forgetServerCopy(uid);
            });
            await signOutHere();
            releaseHeartbeat(uid);
            user = null;
            failures = 0;
            lastError = '';
            done = true;
        } catch (err) {
            showMessage(err.message || String(err), 'error');
        } finally {
            deleting = false;
            busy(els.signedIn, false);
            if (user) startTicker();
            if (done) afterSignOut('Your synced data was deleted from the server and you are logged out.', 'info');
            else render();
        }
    });

    // not a first sync next time: this device's copy is not uploaded again at the next sign-in
    function forgetServerCopy(uid) {
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
    }

    // delete_my_account() (schema.sql) removes the auth user; its rows go with it (on delete cascade)
    els.deleteAccountForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (!user || deleting) return;
        const email = user.email || '';
        clearMessages();
        if (!email || els.deleteConfirm.value.trim().toLowerCase() !== email.toLowerCase()) {
            showMessage('To confirm, type your email address exactly as it is shown above.', 'error');
            els.deleteConfirm.focus();
            return;
        }
        if (!confirm(`Delete the account ${email} for good?\nIts synced progress, settings and channel list are deleted from the server and you are logged out on every device. This cannot be undone. This device keeps its own copy of your progress.`)) return;
        const uid = user.id;
        deleting = true;
        busy(els.signedIn, true);
        stopTimers();
        queued = null;
        let done = false;
        try {
            if (running) await running;
            await withSyncLock(async () => {
                const res = await (await getClient()).rpc('delete_my_account');
                if (res.error) {
                    // before the owner ran the SQL: no such function (404, PGRST202)
                    if (res.status === 404 || res.error.code === 'PGRST202') {
                        throw new Error('Deleting accounts is not available yet: the site owner has to update the server first.');
                    }
                    throw res.error;
                }
                forgetServerCopy(uid);
            });
            // the server session went with the account; this removes the copy kept here
            await signOutHere();
            releaseHeartbeat(uid);
            user = null;
            failures = 0;
            lastError = '';
            done = true;
        } catch (err) {
            showMessage(authErrorText(err), 'error');
        } finally {
            deleting = false;
            busy(els.signedIn, false);
            if (user) startTicker();
            if (done) afterSignOut('Your account and its synced data were deleted. This device keeps its own copy of your progress.', 'info');
            else render();
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
        // mark 1 = a comic opened but never read (stamped just after 1970 so it loses every merge): not late
        const marks = Object.values(state.pending || {}).filter((mark) => mark > 1);
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
            // a confirmation, email-change (or any other) link: it worked, its session is not used
            tokens.push(link.token);
            stripLink();
            if (link.type === 'email_change') {
                emailChanged = true;
                notice = ['Email address changed. Sign in with your new address.', 'info'];
            } else {
                notice = ['Email confirmed. Sign in with your password.', 'info'];
            }
        } else if (link && link.notice !== undefined) {
            stripLink();
            if (LINK_NOTICES[link.notice]) notice = [LINK_NOTICES[link.notice], 'info'];
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
