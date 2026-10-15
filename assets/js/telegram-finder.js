/*
 * "Search Telegram"
 *
 * Two backends, same result shape:
 *  - browser: GramJS (assets/js/vendor/telegram.js) talks to Telegram over
 *    WebSocket with the user's own API ID and login. Nothing to install.
 *  - helper:  tools/tg-finder/tg_finder.py on 127.0.0.1. Adds web search
 *    ("site:t.me ..."), which browsers cannot do because search engines and
 *    t.me send no CORS headers. Optional.
 *
 * Login storage: localStorage keeps only the API ID. The session and API hash
 * live in sessionStorage (gone when the tab closes). "Remember me" stores them
 * encrypted with a passphrase (PBKDF2 + AES-GCM), because every project on the
 * same <user>.github.io origin shares localStorage.
 *
 * channel = { username, title, photo, preview, source, matchedBy, files, oldestId }
 * file    = { id, name, size, sizeLabel, date, caption, url, protected, ref }
 */
document.addEventListener('DOMContentLoaded', () => {
    const FINDER_KEY = 'comic_reader_finder';
    const TG_KEY = 'comic_reader_tg';             // localStorage: { apiId }
    const TG_TAB_KEY = 'comic_reader_tg_tab';     // sessionStorage: { apiHash, session }
    const TG_VAULT_KEY = 'comic_reader_tg_vault'; // localStorage: encrypted { apiHash, session }
    const VAULT_ITERATIONS = 310000;
    const DEFAULT_HELPER = 'http://127.0.0.1:8787';
    const FILES_PER_CHANNEL = 8;
    const MAX_CHANNELS = 10;
    const PAGE_SIZE = 50;
    const COMIC_RE = /\.(cbz|cbr|cbt)$/i;

    const $ = (id) => document.getElementById(id);
    const els = {
        status: $('finderStatus'),
        form: $('finderSearchForm'),
        query: $('finderQuery'),
        account: $('finderAccount'),
        accountState: $('finderAccountState'),
        signedOut: $('tgSignedOut'),
        signedIn: $('tgSignedIn'),
        me: $('tgMe'),
        credsForm: $('tgCredsForm'),
        apiId: $('tgApiId'),
        apiHash: $('tgApiHash'),
        phone: $('tgPhone'),
        codeForm: $('tgCodeForm'),
        codeLabel: $('tgCodeLabel'),
        code: $('tgCode'),
        passwordForm: $('tgPasswordForm'),
        passwordLabel: $('tgPasswordLabel'),
        password: $('tgPassword'),
        logout: $('tgLogoutBtn'),
        unlockForm: $('tgUnlockForm'),
        unlockPass: $('tgUnlockPass'),
        forget: $('tgForgetBtn'),
        remember: $('tgRemember'),
        rememberField: $('tgRememberPassField'),
        rememberPass: $('tgRememberPass'),
        setup: $('finderSetup'),
        helperUrl: $('finderHelperUrl'),
        retry: $('finderRetryBtn'),
        channelList: $('finderChannelList'),
        channelCount: $('finderChannelCount'),
        browseInput: $('finderBrowseInput'),
        browseBtn: $('finderBrowseBtn'),
        message: $('finderMessage'),
        results: $('finderResults')
    };
    if (!els.form) return;

    const settings = loadJSON(FINDER_KEY, {});
    settings.helper = typeof settings.helper === 'string' && settings.helper ? settings.helper : DEFAULT_HELPER;
    settings.channels = Array.isArray(settings.channels) ? settings.channels.filter(isUsername) : [];

    const storedTg = loadJSON(TG_KEY, {});
    const tabTg = loadJSON(TG_TAB_KEY, {}, sessionStorage);
    const tg = { apiId: storedTg.apiId || '', apiHash: tabTg.apiHash || '', session: tabTg.session || '' };
    if (storedTg.apiHash || storedTg.session) saveJSON(TG_KEY, { apiId: tg.apiId }); // never keep secrets in plain localStorage
    const state = {
        helperOnline: false,
        helperDownloads: false,
        client: null,
        clientPromise: null,
        me: null,
        login: null,
        rememberPass: null,
        searchSeq: 0
    };
    const messageRefs = new Map();

    els.helperUrl.value = settings.helper;
    els.channelList.value = settings.channels.map((c) => '@' + c).join('\n');
    els.apiId.value = tg.apiId || '';
    els.apiHash.value = tg.apiHash || '';
    updateChannelCount();

    /* ---------------- storage ---------------- */

    function loadJSON(key, fallback, storage = localStorage) {
        try {
            return JSON.parse(storage.getItem(key) || 'null') || fallback;
        } catch (e) {
            return fallback;
        }
    }

    function saveJSON(key, value, storage = localStorage) {
        try {
            if (value === null) storage.removeItem(key);
            else storage.setItem(key, JSON.stringify(value));
        } catch (e) {
            // storage unavailable - keep in memory
        }
    }

    const saveSettings = () => saveJSON(FINDER_KEY, settings);

    function saveTg() {
        saveJSON(TG_KEY, { apiId: tg.apiId });
        saveJSON(TG_TAB_KEY, tg.session ? { apiHash: tg.apiHash, session: tg.session } : null, sessionStorage);
    }

    /* passphrase vault for "Remember me" */

    const toB64 = (buffer) => btoa(String.fromCharCode(...new Uint8Array(buffer)));
    const fromB64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
    const hasVault = () => Boolean(loadJSON(TG_VAULT_KEY, null));

    async function vaultKey(passphrase, salt) {
        const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
        return crypto.subtle.deriveKey(
            { name: 'PBKDF2', salt, iterations: VAULT_ITERATIONS, hash: 'SHA-256' },
            base,
            { name: 'AES-GCM', length: 256 },
            false,
            ['encrypt', 'decrypt']
        );
    }

    async function sealVault(passphrase, payload) {
        const salt = crypto.getRandomValues(new Uint8Array(16));
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const key = await vaultKey(passphrase, salt);
        const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(payload)));
        saveJSON(TG_VAULT_KEY, { v: 1, salt: toB64(salt), iv: toB64(iv), data: toB64(data) });
    }

    async function openVault(passphrase) {
        const vault = loadJSON(TG_VAULT_KEY, null);
        if (!vault) throw new Error('No saved login on this device.');
        const key = await vaultKey(passphrase, fromB64(vault.salt));
        try {
            const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(vault.iv) }, key, fromB64(vault.data));
            return JSON.parse(new TextDecoder().decode(plain));
        } catch (e) {
            throw new Error('Wrong passphrase.');
        }
    }

    const forgetVault = () => saveJSON(TG_VAULT_KEY, null);

    function isUsername(value) {
        return /^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(value || '');
    }

    // "@name", "name", "t.me/name", "https://t.me/s/name/123" -> "name"
    function parseChannel(value) {
        const match = String(value || '').trim().match(/^(?:https?:\/\/)?(?:www\.)?(?:t\.me\/(?:s\/)?)?@?([A-Za-z][A-Za-z0-9_]{3,31})(?:[/?#].*)?$/);
        return match ? match[1] : null;
    }

    function unique(names) {
        const seen = new Set();
        return names.filter((name) => {
            const key = String(name).toLowerCase();
            if (!isUsername(name) || seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }

    function updateChannelCount() {
        els.channelCount.textContent = settings.channels.length ? `(${settings.channels.length})` : '';
    }

    const MAX_MY_CHANNELS = 50; // matches public.valid_channel_list
    const normalizeChannels = (names) => unique(names).slice(0, MAX_MY_CHANNELS);

    // the textarea shows an older list: it changed while the user had the textarea focused
    let listStale = false;

    // never rewrites what the user is typing (unless `force`); refreshed on blur instead
    function showChannels(force = false) {
        if (!force && document.activeElement === els.channelList) {
            listStale = true;
            return;
        }
        listStale = false;
        els.channelList.value = settings.channels.map((c) => '@' + c).join('\n');
    }

    // notify=false when the list came from sync, so it is not sent back
    function setChannels(names, notify = true, force = false) {
        const next = normalizeChannels(names);
        const changed = next.join(',') !== settings.channels.join(',');
        settings.channels = next;
        saveSettings();
        updateChannelCount();
        showChannels(force);
        if (changed && notify) document.dispatchEvent(new CustomEvent('comicreader:channels-changed'));
    }

    // false when the list is full, so the caller keeps its button
    function addMyChannel(name) {
        if (settings.channels.length >= MAX_MY_CHANNELS) {
            showMessage(`My channels is full (${MAX_MY_CHANNELS}). Remove one first.`, 'error');
            return false;
        }
        setChannels([...settings.channels, name]);
        return true;
    }

    // a list from sync is stored at once (so a reload or another tab has it); while the user is
    // typing in the textarea it is shown only after the textarea loses the focus
    function applyRemoteChannels(names) {
        if (normalizeChannels(names).join(',') === settings.channels.join(',')) return;
        setChannels(names, false);
    }

    els.channelList.addEventListener('change', () => {
        // the user's own edit wins over a list that arrived while typing
        const names = els.channelList.value.split(/[\s,]+/).map(parseChannel).filter(Boolean);
        if (unique(names).length > MAX_MY_CHANNELS) {
            showMessage(`My channels keeps the first ${MAX_MY_CHANNELS} channels; the rest were left out.`, 'error');
        }
        setChannels(names, true, true);
    });

    // not edited: show the list that arrived meanwhile
    els.channelList.addEventListener('blur', () => {
        setTimeout(() => {
            if (listStale && document.activeElement !== els.channelList) showChannels();
        }, 0);
    });

    // another tab changed My channels or the helper address (or took them from sync)
    window.addEventListener('storage', (event) => {
        if (event.key !== FINDER_KEY) return;
        const stored = loadJSON(FINDER_KEY, {});
        if (typeof stored.helper === 'string' && stored.helper && stored.helper !== settings.helper) {
            settings.helper = stored.helper;
            if (document.activeElement !== els.helperUrl) els.helperUrl.value = settings.helper;
        }
        const channels = normalizeChannels(Array.isArray(stored.channels) ? stored.channels : []);
        if (channels.join(',') === settings.channels.join(',')) return;
        settings.channels = channels;
        updateChannelCount();
        showChannels();
    });

    els.helperUrl.addEventListener('change', () => {
        settings.helper = els.helperUrl.value.trim().replace(/\/+$/, '') || DEFAULT_HELPER;
        els.helperUrl.value = settings.helper;
        saveSettings();
        refreshStatus();
    });

    els.retry.addEventListener('click', () => refreshStatus());

    /* ---------------- status ---------------- */

    function setStatus(stateName, text) {
        els.status.dataset.state = stateName;
        els.status.textContent = text;
    }

    function showMessage(text, kind = 'info') {
        if (!text) {
            els.message.hidden = true;
            return;
        }
        els.message.textContent = text;
        els.message.dataset.kind = kind;
        els.message.hidden = false;
    }

    function canDownload() {
        return Boolean(state.me) || state.helperDownloads;
    }

    function renderStatus() {
        const helperNote = state.helperOnline ? ' + web search via local helper' : '';
        if (state.me) {
            setStatus('ready', `Signed in to Telegram as ${state.me}${helperNote}`);
        } else if (state.helperOnline) {
            setStatus(state.helperDownloads ? 'ready' : 'search-only',
                state.helperDownloads ? 'Local helper connected · reading in this site enabled' : 'Local helper connected · search only. Sign in below to read files here.');
        } else if (hasVault()) {
            setStatus('offline', 'Unlock your saved Telegram login below.');
        } else {
            setStatus('offline', 'Sign in to Telegram below to search and read.');
        }
        if (!state.me && !state.login) showLoginStep(hasVault() ? 'unlock' : 'creds', false);
        els.signedIn.hidden = !state.me;
        els.signedOut.hidden = Boolean(state.me);
        els.me.textContent = state.me || '';
        els.accountState.textContent = state.me ? '(signed in)' : '';
        els.results.querySelectorAll('.finder-file').forEach(updateFileActions);
    }

    async function refreshStatus() {
        setStatus('unknown', 'Checking connection…');
        await Promise.all([checkHelper(), restoreSession()]);
        if (!state.me && !state.helperOnline) els.account.open = true;
        renderStatus();
    }

    /* ---------------- local helper backend ---------------- */

    async function helperFetch(path, timeoutMs = 60000) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await fetch(settings.helper + path, { signal: controller.signal });
            if (!response.ok) {
                let message = `Helper answered ${response.status}`;
                try {
                    message = (await response.json()).error || message;
                } catch (e) {
                    // not JSON
                }
                throw new Error(message);
            }
            return response;
        } catch (err) {
            if (err.name === 'AbortError') throw new Error('The local helper did not answer in time.');
            if (err instanceof TypeError) throw new Error('The local helper is not reachable.');
            throw err;
        } finally {
            clearTimeout(timer);
        }
    }

    async function checkHelper() {
        try {
            const health = await (await helperFetch('/health', 3000)).json();
            state.helperOnline = Boolean(health.ok);
            state.helperDownloads = Boolean(health.downloads);
        } catch (err) {
            state.helperOnline = false;
            state.helperDownloads = false;
        }
    }

    /* ---------------- Telegram in the browser (GramJS) ---------------- */

    function loadGram() {
        if (window.GramJS) return Promise.resolve(window.GramJS);
        return new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = './assets/js/vendor/telegram.js';
            script.onload = () => (window.GramJS ? resolve(window.GramJS) : reject(new Error('Telegram client failed to start')));
            script.onerror = () => reject(new Error('Could not load the Telegram client'));
            document.head.appendChild(script);
        });
    }

    function getClient() {
        if (state.client) return Promise.resolve(state.client);
        if (!state.clientPromise) {
            state.clientPromise = (async () => {
                const { TelegramClient, StringSession } = await loadGram();
                const client = new TelegramClient(new StringSession(tg.session || ''), Number(tg.apiId), tg.apiHash, {
                    connectionRetries: 3,
                    useWSS: true,
                    floodSleepThreshold: 30,
                    deviceModel: 'Web Comic Reader',
                    systemVersion: 'Browser',
                    appVersion: '1.0'
                });
                if (client.setLogLevel) client.setLogLevel('error');
                await client.connect();
                state.client = client;
                return client;
            })().finally(() => { state.clientPromise = null; });
        }
        return state.clientPromise;
    }

    async function dropClient() {
        const client = state.client;
        state.client = null;
        if (client) {
            try {
                await client.disconnect();
            } catch (e) {
                // already closed
            }
        }
    }

    async function restoreSession() {
        if (state.me || !tg.session || !tg.apiId || !tg.apiHash) return;
        try {
            const client = await getClient();
            if (await client.checkAuthorization()) {
                state.me = displayName(await client.getMe());
            } else {
                tg.session = '';
                saveTg();
                await dropClient();
            }
        } catch (err) {
            console.warn('Telegram session could not be restored:', err);
        }
    }

    function displayName(user) {
        if (!user) return '';
        if (user.username) return '@' + user.username;
        return [user.firstName, user.lastName].filter(Boolean).join(' ') || 'your account';
    }

    function tgError(err) {
        const code = err && (err.errorMessage || err.message) || String(err);
        if (err && err.seconds) return `Telegram asks to wait ${err.seconds} seconds before trying again.`;
        const known = {
            API_ID_INVALID: 'API ID or API hash was not accepted. Copy both again from my.telegram.org/apps.',
            API_ID_PUBLISHED_FLOOD: 'This API ID is blocked by Telegram. Create your own at my.telegram.org/apps.',
            PHONE_NUMBER_INVALID: 'Phone number is not valid. Use the international format, e.g. +49 151 2345678.',
            PHONE_NUMBER_BANNED: 'Telegram has banned this phone number.',
            PHONE_CODE_INVALID: 'The login code is wrong.',
            PHONE_CODE_EXPIRED: 'The login code has expired. Request a new one.',
            PHONE_CODE_EMPTY: 'Enter the login code.',
            PASSWORD_HASH_INVALID: 'The two-step verification password is wrong.',
            AUTH_KEY_UNREGISTERED: 'You were logged out. Sign in again.',
            USERNAME_NOT_OCCUPIED: 'No channel with this name.',
            USERNAME_INVALID: 'No channel with this name.',
            CHANNEL_PRIVATE: 'This channel is private.',
            CHANNEL_INVALID: 'This channel is not available.'
        };
        return known[code] || code;
    }

    function num(value) {
        if (value === null || value === undefined) return 0;
        if (typeof value === 'number') return value;
        if (typeof value.toJSNumber === 'function') return value.toJSNumber();
        return Number(value.toString());
    }

    function formatSize(size) {
        if (!size) return '';
        const units = ['B', 'KB', 'MB', 'GB'];
        let value = size;
        let unit = 0;
        while (value >= 1024 && unit < units.length - 1) {
            value /= 1024;
            unit++;
        }
        return unit === 0 ? `${value} B` : `${value.toFixed(1)} ${units[unit]}`;
    }

    function fileFromMessage(message, chat, username) {
        const doc = message && message.media && message.media.document;
        if (!doc || doc.className !== 'Document') return null;
        const attr = (doc.attributes || []).find((a) => a.className === 'DocumentAttributeFilename');
        const name = attr && attr.fileName;
        if (!name || !COMIC_RE.test(name)) return null;
        const size = num(doc.size);
        const ref = `${username || num(chat && chat.id)}:${message.id}`;
        messageRefs.set(ref, message);
        return {
            id: message.id,
            name,
            size,
            sizeLabel: formatSize(size),
            date: message.date ? new Date(message.date * 1000).toISOString() : null,
            caption: (message.message || '').slice(0, 280),
            url: username ? `https://t.me/${username}/${message.id}` : null,
            protected: Boolean(message.noforwards || (chat && chat.noforwards)),
            ref
        };
    }

    async function browserChannel(username, query = '', before = null) {
        const client = await getClient();
        const { Api } = window.GramJS;
        const entity = await client.getEntity(username);
        const params = { limit: PAGE_SIZE, filter: new Api.InputMessagesFilterDocument() };
        if (query) params.search = query;
        if (before) params.maxId = before;
        const messages = await client.getMessages(entity, params);
        const files = [];
        let oldest = null;
        for (const message of messages) {
            if (!message) continue;
            oldest = oldest === null ? message.id : Math.min(oldest, message.id);
            const file = fileFromMessage(message, entity, entity.username || username);
            if (file) files.push(file);
        }
        return {
            username: entity.username || username,
            title: entity.title || username,
            photo: null,
            preview: true,
            source: 'telegram',
            files,
            oldestId: messages.length >= PAGE_SIZE ? oldest : null
        };
    }

    async function browserSearch(query, extraNames) {
        const client = await getClient();
        const { Api } = window.GramJS;
        const engines = ['telegram'];
        const errors = [];
        let names = [...settings.channels, ...extraNames];

        try {
            const found = await client.invoke(new Api.contacts.Search({ q: query, limit: 15 }));
            names = names.concat(found.chats
                .filter((chat) => chat.username && (chat.broadcast || chat.megagroup))
                .map((chat) => chat.username));
        } catch (err) {
            errors.push(`telegram search: ${tgError(err)}`);
        }

        const channels = [];
        for (const name of unique(names).slice(0, MAX_CHANNELS + settings.channels.length)) {
            try {
                let channel = await browserChannel(name, query);
                if (channel.files.length) {
                    channel.matchedBy = 'files';
                } else {
                    channel = await browserChannel(name);
                    channel.matchedBy = 'channel';
                }
                channels.push(channel);
            } catch (err) {
                errors.push(`@${name}: ${tgError(err)}`);
            }
        }

        // files in chats the user has joined (including private ones)
        try {
            const result = await client.invoke(new Api.messages.SearchGlobal({
                q: query,
                filter: new Api.InputMessagesFilterDocument(),
                minDate: 0,
                maxDate: 0,
                offsetRate: 0,
                offsetPeer: new Api.InputPeerEmpty(),
                offsetId: 0,
                limit: PAGE_SIZE
            }));
            const chats = new Map((result.chats || []).map((chat) => [String(num(chat.id)), chat]));
            const groups = new Map();
            for (const message of result.messages || []) {
                const peer = message.peerId || {};
                const chat = chats.get(String(num(peer.channelId || peer.chatId)));
                if (!chat) continue;
                const username = chat.username || null;
                if (username && channels.some((c) => c.username.toLowerCase() === username.toLowerCase())) continue;
                const file = fileFromMessage(message, chat, username);
                if (!file) continue;
                const key = username || String(num(chat.id));
                if (!groups.has(key)) {
                    groups.set(key, { username, title: chat.title || username || 'Chat', photo: null, preview: true, source: 'telegram', matchedBy: 'joined', files: [], oldestId: null });
                }
                groups.get(key).files.push(file);
            }
            channels.push(...groups.values());
        } catch (err) {
            errors.push(`your chats: ${tgError(err)}`);
        }

        channels.sort((a, b) => (b.files.length > 0) - (a.files.length > 0));
        return { query, engines, channels, errors };
    }

    async function browserDownload(file, onProgress) {
        const client = await getClient();
        let message = messageRefs.get(file.ref);
        if (!message && file.username) {
            [message] = await client.getMessages(file.username, { ids: [file.id] });
        }
        if (!message) throw new Error('This post is no longer available.');
        if (file.protected || message.noforwards) throw new Error('This channel does not allow saving its files.');
        const data = await client.downloadMedia(message, {
            progressCallback: (received, total) => {
                const all = num(total) || file.size;
                if (all) onProgress(num(received) / all);
            }
        });
        if (!data || !data.length) throw new Error('Download returned no data.');
        return new File([data], file.name, { type: 'application/octet-stream', lastModified: Date.parse(file.date) || Date.now() });
    }

    /* ---------------- sign-in ---------------- */

    function showLoginStep(step, focusField = true) {
        els.unlockForm.hidden = step !== 'unlock';
        els.credsForm.hidden = step !== 'creds';
        els.codeForm.hidden = step !== 'code';
        els.passwordForm.hidden = step !== 'password';
        const focus = { unlock: els.unlockPass, creds: els.phone, code: els.code, password: els.password }[step];
        if (focus && focusField) setTimeout(() => focus.focus(), 30);
    }

    els.remember.addEventListener('change', () => {
        els.rememberField.hidden = !els.remember.checked;
        if (els.remember.checked) setTimeout(() => els.rememberPass.focus(), 30);
    });

    els.unlockForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        showMessage('');
        busy(els.unlockForm, true);
        try {
            const saved = await openVault(els.unlockPass.value);
            els.unlockPass.value = '';
            tg.apiHash = saved.apiHash;
            tg.session = saved.session;
            saveTg();
            await dropClient();
            await restoreSession();
            if (!state.me) {
                forgetVault();
                throw new Error('The saved login is no longer valid. Sign in again.');
            }
            els.account.open = false;
            showMessage('Signed in. Search for a comic above.', 'info');
        } catch (err) {
            showMessage(tgError(err), 'error');
        } finally {
            busy(els.unlockForm, false);
            renderStatus();
        }
    });

    els.forget.addEventListener('click', () => {
        if (!confirm('Remove the saved Telegram login from this device?')) return;
        forgetVault();
        showMessage('');
        showLoginStep('creds');
        renderStatus();
    });

    function busy(form, on) {
        form.querySelectorAll('button, input').forEach((el) => { el.disabled = on; });
    }

    els.credsForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        const apiId = els.apiId.value.trim();
        const apiHash = els.apiHash.value.trim();
        const phone = els.phone.value.replace(/[^\d+]/g, '');
        if (/^\d+:[\w-]{30,}$/.test(apiId) || /^\d+:[\w-]{30,}$/.test(apiHash)) {
            showMessage('That is a bot token. This needs the API ID and API hash from my.telegram.org/apps.', 'error');
            return;
        }
        if (!/^\d{3,12}$/.test(apiId) || !/^[a-f0-9]{32}$/i.test(apiHash)) {
            showMessage('API ID is a number and API hash has 32 characters (0-9, a-f). Copy both from my.telegram.org/apps.', 'error');
            return;
        }
        if (!/^\+?\d{6,15}$/.test(phone)) {
            showMessage('Enter the phone number in international format, e.g. +49 151 2345678.', 'error');
            return;
        }
        if (els.remember.checked && els.rememberPass.value.length < 8) {
            showMessage('Choose a passphrase with at least 8 characters to remember the login, or untick "Remember me".', 'error');
            return;
        }
        state.rememberPass = els.remember.checked ? els.rememberPass.value : null;
        els.rememberPass.value = '';

        showMessage('');
        busy(els.credsForm, true);
        try {
            tg.apiId = apiId;
            tg.apiHash = apiHash;
            tg.session = '';
            saveTg();
            await dropClient(); // a login always starts from a fresh session
            const client = await getClient();
            const sent = await client.sendCode({ apiId: Number(apiId), apiHash }, phone);
            state.login = { phone, phoneCodeHash: sent.phoneCodeHash };
            els.codeLabel.textContent = sent.isCodeViaApp ? 'Login code (sent to your Telegram app)' : 'Login code (sent by SMS)';
            els.code.value = '';
            showLoginStep('code');
        } catch (err) {
            showMessage(tgError(err), 'error');
        } finally {
            busy(els.credsForm, false);
        }
    });

    els.codeForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (!state.login) return showLoginStep('creds');
        showMessage('');
        busy(els.codeForm, true);
        try {
            const client = await getClient();
            const { Api } = window.GramJS;
            const result = await client.invoke(new Api.auth.SignIn({
                phoneNumber: state.login.phone,
                phoneCodeHash: state.login.phoneCodeHash,
                phoneCode: els.code.value.trim()
            }));
            if (result && result.className === 'auth.AuthorizationSignUpRequired') {
                throw new Error('There is no Telegram account for this phone number.');
            }
            await finishSignIn(client);
        } catch (err) {
            if (err && err.errorMessage === 'SESSION_PASSWORD_NEEDED') {
                els.password.value = '';
                showLoginStep('password');
            } else {
                showMessage(tgError(err), 'error');
            }
        } finally {
            busy(els.codeForm, false);
        }
    });

    els.passwordForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        showMessage('');
        busy(els.passwordForm, true);
        try {
            const client = await getClient();
            let lastError = null;
            const password = els.password.value;
            await client.signInWithPassword({ apiId: Number(tg.apiId), apiHash: tg.apiHash }, {
                password: async () => password,
                onError: async (err) => {
                    lastError = err;
                    return true; // stop, show the error in the form
                }
            }).catch((err) => { throw lastError || err; });
            els.password.value = '';
            await finishSignIn(client);
        } catch (err) {
            showMessage(tgError(err), 'error');
        } finally {
            busy(els.passwordForm, false);
        }
    });

    document.querySelectorAll('[data-tg-cancel]').forEach((btn) => {
        btn.addEventListener('click', () => {
            state.login = null;
            state.rememberPass = null;
            showMessage('');
            showLoginStep('creds');
        });
    });

    async function finishSignIn(client) {
        tg.session = client.session.save();
        saveTg();
        if (state.rememberPass) {
            await sealVault(state.rememberPass, { apiHash: tg.apiHash, session: tg.session });
        }
        state.rememberPass = null;
        state.login = null;
        state.me = displayName(await client.getMe());
        showLoginStep('creds');
        els.account.open = false;
        showMessage('Signed in. Search for a comic above.', 'info');
        renderStatus();
    }

    els.logout.addEventListener('click', async () => {
        if (!confirm('Log out of Telegram in this browser?')) return;
        try {
            const client = await getClient();
            await client.invoke(new window.GramJS.Api.auth.LogOut());
        } catch (err) {
            // the session is removed locally either way
        }
        await dropClient();
        tg.session = '';
        tg.apiHash = '';
        saveTg();
        forgetVault();
        state.me = null;
        messageRefs.clear();
        renderStatus();
        showMessage('Logged out of Telegram.', 'info');
    });

    /* ---------------- search ---------------- */

    els.form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const query = els.query.value.trim();
        if (query.length < 2) return;
        if (!state.me && !state.helperOnline) await refreshStatus();
        if (!state.me && !state.helperOnline) {
            showMessage('Sign in to Telegram first (see "Telegram account").', 'error');
            els.account.open = true;
            return;
        }
        // counted only, without the search text
        if (window.ComicAnalytics) window.ComicAnalytics.event('telegram_search');

        const seq = ++state.searchSeq;
        showMessage('');
        els.results.innerHTML = '';
        els.results.appendChild(loadingRow(`Searching Telegram for “${query}”…`));
        const submit = els.form.querySelector('button[type="submit"]');
        submit.disabled = true;

        try {
            let data;
            if (state.me) {
                let webNames = [];
                const notes = [];
                if (state.helperOnline) {
                    try {
                        const found = await (await helperFetch('/discover?' + new URLSearchParams({ q: query }), 90000)).json();
                        webNames = found.channels || [];
                        notes.push(...(found.engines || []));
                        (found.errors || []).forEach((e) => notes.push(`!${e}`));
                    } catch (err) {
                        notes.push(`!web search: ${err.message}`);
                    }
                }
                data = await browserSearch(query, webNames);
                data.engines.push(...notes.filter((n) => !n.startsWith('!')));
                data.errors.push(...notes.filter((n) => n.startsWith('!')).map((n) => n.slice(1)));
            } else {
                const params = new URLSearchParams({ q: query });
                if (settings.channels.length) params.set('channels', settings.channels.join(','));
                data = await (await helperFetch('/search?' + params, 180000)).json();
            }
            if (seq !== state.searchSeq) return;
            renderSearch(data);
        } catch (err) {
            if (seq !== state.searchSeq) return;
            els.results.innerHTML = '';
            showMessage(state.me ? tgError(err) : err.message, 'error');
        } finally {
            if (seq === state.searchSeq) submit.disabled = false;
        }
    });

    els.browseBtn.addEventListener('click', () => browseInput());
    els.browseInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            browseInput();
        }
    });

    async function browseInput() {
        const name = parseChannel(els.browseInput.value);
        if (!name) {
            showMessage('Enter a public channel as @name or a t.me link.', 'error');
            return;
        }
        if (!state.me && !state.helperOnline) await refreshStatus();
        if (!state.me && !state.helperOnline) {
            showMessage('Sign in to Telegram first (see "Telegram account").', 'error');
            return;
        }
        showMessage('');
        els.results.innerHTML = '';
        const card = channelCard({ username: name, title: '@' + name, files: [] }, '');
        els.results.appendChild(card);
        await loadChannel(card, name, '', null, true);
    }

    function fetchChannel(username, query, before) {
        if (state.me) return browserChannel(username, query, before);
        const params = new URLSearchParams({ u: username });
        if (query) params.set('q', query);
        if (before) params.set('before', String(before));
        return helperFetch('/channel?' + params).then((r) => r.json());
    }

    function renderSearch(data) {
        els.results.innerHTML = '';
        const withFiles = data.channels.filter((c) => c.files.length);
        const notes = [];
        const engines = [...new Set(data.engines || [])];
        if (engines.length) notes.push(`Sources: ${engines.join(', ')}`);
        if (data.errors && data.errors.length) notes.push(`${data.errors.length} source(s) failed: ${data.errors.slice(0, 3).join(' · ')}`);

        if (!data.channels.length) {
            showMessage(['No channels found for this search. Try another spelling, or add channels under "My channels".', ...notes].join('\n'), 'info');
            return;
        }
        const total = withFiles.reduce((sum, c) => sum + c.files.length, 0);
        showMessage([`${total} comic file(s) in ${withFiles.length} of ${data.channels.length} channel(s).`, ...notes].join('\n'), 'info');
        data.channels.forEach((channel) => els.results.appendChild(channelCard(channel, data.query)));
    }

    /* ---------------- rendering ---------------- */

    function loadingRow(text) {
        const row = document.createElement('div');
        row.className = 'finder-loading';
        row.innerHTML = '<div class="finder-spinner"></div>';
        row.append(text);
        return row;
    }

    function channelCard(channel, query) {
        const card = document.createElement('section');
        card.className = 'finder-channel';
        card.dataset.username = channel.username || '';

        const header = document.createElement('div');
        header.className = 'finder-channel-header';

        const avatar = document.createElement('div');
        avatar.className = 'finder-avatar';
        const initial = (channel.title || channel.username || '?').slice(0, 1).toUpperCase();
        if (channel.photo && /^https:\/\//.test(channel.photo)) {
            const img = document.createElement('img');
            img.alt = '';
            img.referrerPolicy = 'no-referrer';
            img.addEventListener('error', () => { avatar.textContent = initial; }, { once: true });
            img.src = channel.photo;
            avatar.appendChild(img);
        } else {
            avatar.textContent = initial;
        }

        const titles = document.createElement('div');
        titles.className = 'finder-channel-titles';
        const title = document.createElement(channel.username ? 'a' : 'div');
        title.className = 'finder-channel-title';
        if (channel.username) {
            title.href = `https://t.me/s/${channel.username}`;
            title.target = '_blank';
            title.rel = 'noopener';
        }
        title.textContent = channel.title || channel.username;
        const sub = document.createElement('div');
        sub.className = 'finder-channel-sub';
        sub.textContent = (channel.username ? `@${channel.username}` : 'Private chat') + channelNote(channel, query);
        titles.append(title, sub);

        const actions = document.createElement('div');
        actions.className = 'finder-channel-actions';
        if (channel.username) {
            const browse = document.createElement('button');
            browse.type = 'button';
            browse.className = 'link-btn link-btn-small';
            browse.textContent = 'Latest comics';
            browse.title = 'Show the newest comic files of this channel';
            browse.addEventListener('click', () => loadChannel(card, channel.username, '', null, true));
            actions.appendChild(browse);

            if (!settings.channels.some((c) => c.toLowerCase() === channel.username.toLowerCase())) {
                const keep = document.createElement('button');
                keep.type = 'button';
                keep.className = 'link-btn link-btn-small';
                keep.textContent = 'Add to my channels';
                keep.addEventListener('click', () => {
                    if (addMyChannel(channel.username)) keep.remove();
                });
                actions.appendChild(keep);
            }
        }

        header.append(avatar, titles, actions);
        const list = document.createElement('div');
        list.className = 'finder-files';
        card.append(header, list);
        renderFiles(card, channel, true);
        return card;
    }

    function channelNote(channel, query) {
        if (channel.preview === false && channel.source !== 'telegram') return ' · web preview disabled';
        if (channel.matchedBy === 'channel' && query) return ' · channel name matches, latest comics';
        if (channel.matchedBy === 'joined') return ' · from your chats';
        return '';
    }

    function renderFiles(card, channel, replace) {
        const list = card.querySelector('.finder-files');
        if (replace) list.innerHTML = '';
        card.querySelector('.finder-more')?.remove();

        if (!channel.files.length && replace) {
            const empty = document.createElement('div');
            empty.className = 'finder-empty';
            empty.textContent = channel.preview === false && channel.source !== 'telegram'
                ? 'This channel hides its web preview. Sign in to Telegram to search it.'
                : 'No CBZ/CBR/CBT files found here.';
            list.appendChild(empty);
            return;
        }

        const sorted = [...channel.files].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
        sorted.forEach((file, index) => {
            const row = fileRow(channel.username, file);
            if (replace && index >= FILES_PER_CHANNEL) row.hidden = true;
            list.appendChild(row);
        });

        const hiddenCount = list.querySelectorAll('.finder-file[hidden]').length;
        if (hiddenCount) {
            const more = document.createElement('button');
            more.type = 'button';
            more.className = 'link-btn link-btn-small finder-more';
            more.textContent = `Show ${hiddenCount} more`;
            more.addEventListener('click', () => {
                list.querySelectorAll('.finder-file[hidden]').forEach((row) => { row.hidden = false; });
                more.remove();
                if (channel.oldestId && channel.username) renderMoreButton(card, channel);
            });
            card.appendChild(more);
        } else if (channel.oldestId && channel.username) {
            renderMoreButton(card, channel);
        }
    }

    function renderMoreButton(card, channel) {
        const more = document.createElement('button');
        more.type = 'button';
        more.className = 'link-btn link-btn-small finder-more';
        more.textContent = 'Load older posts';
        more.addEventListener('click', () => loadChannel(card, channel.username, card.dataset.query || '', channel.oldestId, false));
        card.appendChild(more);
    }

    async function loadChannel(card, username, query, before, replace) {
        const list = card.querySelector('.finder-files');
        card.dataset.query = query;
        card.querySelector('.finder-more')?.remove();
        const loading = loadingRow(before ? 'Loading older posts…' : 'Loading channel…');
        if (replace) list.innerHTML = '';
        list.appendChild(loading);
        try {
            const channel = await fetchChannel(username, query, before);
            loading.remove();
            if (replace) card.querySelector('.finder-channel-title').textContent = channel.title || username;
            if (!replace && !channel.files.length && channel.oldestId && channel.oldestId !== before) {
                renderMoreButton(card, channel);
                return;
            }
            renderFiles(card, channel, replace);
        } catch (err) {
            loading.remove();
            const error = document.createElement('div');
            error.className = 'finder-empty error';
            error.textContent = state.me ? tgError(err) : err.message;
            list.appendChild(error);
        }
    }

    function fileRow(username, file) {
        const row = document.createElement('div');
        row.className = 'finder-file';
        row.dataset.username = username || '';
        row.dataset.id = String(file.id);
        row.dataset.name = file.name;
        if (file.protected) row.dataset.protected = 'true';
        row.fileInfo = Object.assign({ username }, file);

        const ext = document.createElement('div');
        ext.className = 'finder-ext';
        ext.textContent = (file.name.split('.').pop() || '').toUpperCase();

        const info = document.createElement('div');
        info.className = 'finder-file-info';
        const name = document.createElement('div');
        name.className = 'finder-file-name';
        name.textContent = file.name;
        name.title = file.caption ? `${file.name}\n\n${file.caption}` : file.name;
        const meta = document.createElement('div');
        meta.className = 'finder-file-meta';
        meta.textContent = [file.sizeLabel, formatDate(file.date), file.protected ? 'saving disabled by channel' : '']
            .filter(Boolean).join(' · ');
        const progress = document.createElement('div');
        progress.className = 'finder-file-progress';
        progress.hidden = true;
        progress.innerHTML = '<div></div>';
        info.append(name, meta, progress);

        const actions = document.createElement('div');
        actions.className = 'finder-file-actions';

        const read = document.createElement('button');
        read.type = 'button';
        read.className = 'finder-read';
        read.textContent = 'Read';
        read.addEventListener('click', () => readFile(row));

        const save = document.createElement('button');
        save.type = 'button';
        save.className = 'finder-icon-btn finder-save';
        save.title = 'Save file to this computer';
        save.setAttribute('aria-label', `Save ${file.name}`);
        save.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v8M4.5 6.5L8 10l3.5-3.5M2.5 13.5h11"/></svg>';
        save.addEventListener('click', () => saveFile(row));
        actions.append(read, save);

        if (file.url) {
            const open = document.createElement('a');
            open.className = 'finder-icon-btn';
            open.href = file.url;
            open.target = '_blank';
            open.rel = 'noopener';
            open.title = 'Open the post in Telegram';
            open.setAttribute('aria-label', `Open ${file.name} in Telegram`);
            open.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 2.5h4.5V7M13.5 2.5L7 9M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3"/></svg>';
            actions.appendChild(open);
        }

        row.append(ext, info, actions);
        updateFileActions(row);

        if (window.ComicReader) {
            window.ComicReader.hasOfflineCopy(file.name).then((cached) => {
                if (!cached) return;
                row.dataset.cached = 'true';
                updateFileActions(row);
            });
        }
        return row;
    }

    function updateFileActions(row) {
        const read = row.querySelector('.finder-read');
        const save = row.querySelector('.finder-save');
        const cached = row.dataset.cached === 'true';
        const blocked = row.dataset.protected === 'true';
        const busyRow = row.dataset.busy === 'true';
        const downloadable = canDownload() && !blocked && (state.me || row.dataset.username);

        read.disabled = busyRow || !(cached || downloadable);
        save.disabled = busyRow || !downloadable;
        read.title = cached
            ? 'Already downloaded, opens instantly'
            : blocked
                ? 'This channel does not allow saving its files'
                : downloadable
                    ? 'Download and read here'
                    : 'Sign in to Telegram to read files here';
        row.classList.toggle('is-cached', cached);
    }

    function formatDate(iso) {
        if (!iso) return '';
        const date = new Date(iso);
        if (Number.isNaN(date.getTime())) return '';
        return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    }

    /* ---------------- downloads ---------------- */

    async function helperDownload(file, onProgress) {
        const params = new URLSearchParams({ u: file.username, id: String(file.id) });
        const response = await helperFetch('/download?' + params, 30 * 60 * 1000);
        const total = Number(response.headers.get('Content-Length')) || file.size || 0;
        const chunks = [];
        let received = 0;
        if (response.body && response.body.getReader) {
            const reader = response.body.getReader();
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                chunks.push(value);
                received += value.length;
                if (total) onProgress(received / total);
            }
        } else {
            chunks.push(new Uint8Array(await response.arrayBuffer()));
        }
        const headerName = response.headers.get('X-File-Name');
        const name = headerName ? decodeURIComponent(headerName) : file.name;
        return new File(chunks, name, { type: 'application/octet-stream', lastModified: Date.parse(file.date) || Date.now() });
    }

    async function downloadFile(row) {
        const file = row.fileInfo;
        const progress = row.querySelector('.finder-file-progress');
        const fill = progress.firstElementChild;
        const onProgress = (ratio) => { fill.style.width = `${Math.min(100, Math.round(ratio * 100))}%`; };
        row.dataset.busy = 'true';
        updateFileActions(row);
        progress.hidden = false;
        onProgress(0);
        try {
            const result = state.me ? await browserDownload(file, onProgress) : await helperDownload(file, onProgress);
            onProgress(1);
            return result;
        } finally {
            row.dataset.busy = 'false';
            setTimeout(() => { progress.hidden = true; }, 600);
            updateFileActions(row);
        }
    }

    async function readFile(row) {
        const file = row.fileInfo;
        try {
            if (row.dataset.cached === 'true' && window.ComicReader) {
                await window.ComicReader.openRecent(file.name);
                return;
            }
            const downloaded = await downloadFile(row);
            row.dataset.cached = 'true';
            updateFileActions(row);
            window.ComicReader.openFile(downloaded, 'telegram');
        } catch (err) {
            showMessage(`${file.name}: ${state.me ? tgError(err) : err.message}`, 'error');
        }
    }

    async function saveFile(row) {
        const file = row.fileInfo;
        try {
            const downloaded = await downloadFile(row);
            const url = URL.createObjectURL(downloaded);
            const link = document.createElement('a');
            link.href = url;
            link.download = downloaded.name;
            document.body.appendChild(link);
            link.click();
            link.remove();
            setTimeout(() => URL.revokeObjectURL(url), 10000);
        } catch (err) {
            showMessage(`${file.name}: ${state.me ? tgError(err) : err.message}`, 'error');
        }
    }

    /* ---------------- public ---------------- */

    window.TelegramFinder = {
        getChannels: () => [...settings.channels],
        setChannels: (names) => applyRemoteChannels(names),
        onShow() {
            refreshStatus();
            setTimeout(() => els.query.focus(), 50);
        }
    };
});
