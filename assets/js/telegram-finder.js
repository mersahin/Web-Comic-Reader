/*
 * Telegram search UI.
 *
 * Browsers cannot read t.me or search-engine pages from another site (no CORS),
 * so the work is done by tools/tg-finder/tg_finder.py running on the user's own
 * computer. This file only talks to that local helper.
 */
document.addEventListener('DOMContentLoaded', () => {
    const SETTINGS_KEY = 'comic_reader_finder';
    const DEFAULT_HELPER = 'http://127.0.0.1:8787';
    const FILES_PER_CHANNEL = 8;

    const $ = (id) => document.getElementById(id);
    const els = {
        status: $('finderStatus'),
        form: $('finderSearchForm'),
        query: $('finderQuery'),
        setup: $('finderSetup'),
        helperUrl: $('finderHelperUrl'),
        retry: $('finderRetryBtn'),
        channelsBox: $('finderChannels'),
        channelList: $('finderChannelList'),
        channelCount: $('finderChannelCount'),
        browseInput: $('finderBrowseInput'),
        browseBtn: $('finderBrowseBtn'),
        message: $('finderMessage'),
        results: $('finderResults')
    };
    if (!els.form) return;

    const settings = loadSettings();
    const state = { online: false, downloads: false, checked: false, searchSeq: 0 };

    els.helperUrl.value = settings.helper;
    els.channelList.value = settings.channels.map((c) => '@' + c).join('\n');
    updateChannelCount();

    /* ---------------- settings ---------------- */

    function loadSettings() {
        try {
            const stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
            return {
                helper: typeof stored.helper === 'string' && stored.helper ? stored.helper : DEFAULT_HELPER,
                channels: Array.isArray(stored.channels) ? stored.channels.filter(isUsername) : []
            };
        } catch (e) {
            return { helper: DEFAULT_HELPER, channels: [] };
        }
    }

    function saveSettings() {
        try {
            localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
        } catch (e) {
            // storage unavailable - keep in memory
        }
    }

    function isUsername(value) {
        return /^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(value || '');
    }

    // "@name", "name", "t.me/name", "https://t.me/s/name/123" -> "name"
    function parseChannel(value) {
        const match = String(value || '').trim().match(/^(?:https?:\/\/)?(?:www\.)?(?:t\.me\/(?:s\/)?)?@?([A-Za-z][A-Za-z0-9_]{3,31})(?:[/?#].*)?$/);
        return match ? match[1] : null;
    }

    function updateChannelCount() {
        els.channelCount.textContent = settings.channels.length ? `(${settings.channels.length})` : '';
    }

    els.channelList.addEventListener('change', () => {
        const names = els.channelList.value.split(/[\s,]+/).map(parseChannel).filter(Boolean);
        settings.channels = [...new Set(names)].slice(0, 20);
        els.channelList.value = settings.channels.map((c) => '@' + c).join('\n');
        saveSettings();
        updateChannelCount();
    });

    els.helperUrl.addEventListener('change', () => {
        settings.helper = els.helperUrl.value.trim().replace(/\/+$/, '') || DEFAULT_HELPER;
        els.helperUrl.value = settings.helper;
        saveSettings();
        checkHelper();
    });

    els.retry.addEventListener('click', () => checkHelper());

    /* ---------------- helper connection ---------------- */

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
            if (err instanceof TypeError) throw new Error('The local helper is not reachable. Is tg_finder.py running?');
            throw err;
        } finally {
            clearTimeout(timer);
        }
    }

    async function checkHelper() {
        setStatus('unknown', 'Checking local helper…');
        try {
            const health = await (await helperFetch('/health', 4000)).json();
            state.online = Boolean(health.ok);
            state.downloads = Boolean(health.downloads);
        } catch (err) {
            state.online = false;
            state.downloads = false;
        }
        state.checked = true;
        if (!state.online) {
            setStatus('offline', 'Local helper not running. See setup below.');
            els.setup.open = true;
        } else if (state.downloads) {
            setStatus('ready', 'Local helper connected · reading in this site enabled');
        } else {
            setStatus('search-only', 'Local helper connected · search only (downloads off)');
        }
        // refresh buttons of results that are already on screen
        els.results.querySelectorAll('.finder-file').forEach(updateFileActions);
    }

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

    /* ---------------- search ---------------- */

    els.form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const query = els.query.value.trim();
        if (query.length < 2) return;
        if (!state.online) await checkHelper();
        if (!state.online) {
            showMessage('Start the local helper first (see "Local helper setup").', 'error');
            return;
        }

        const seq = ++state.searchSeq;
        showMessage('');
        els.results.innerHTML = '';
        els.results.appendChild(loadingRow(`Searching Telegram channels for “${query}”…`));
        const submit = els.form.querySelector('button[type="submit"]');
        submit.disabled = true;

        try {
            const params = new URLSearchParams({ q: query });
            if (settings.channels.length) params.set('channels', settings.channels.join(','));
            const data = await (await helperFetch('/search?' + params, 180000)).json();
            if (seq !== state.searchSeq) return;
            renderSearch(data);
        } catch (err) {
            if (seq !== state.searchSeq) return;
            els.results.innerHTML = '';
            showMessage(err.message, 'error');
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
        if (!state.online) await checkHelper();
        if (!state.online) {
            showMessage('Start the local helper first (see "Local helper setup").', 'error');
            return;
        }
        showMessage('');
        els.results.innerHTML = '';
        const card = channelCard({ username: name, title: '@' + name, files: [] }, { query: '' });
        els.results.appendChild(card);
        await loadChannel(card, name, '', null, true);
    }

    function renderSearch(data) {
        els.results.innerHTML = '';
        const withFiles = data.channels.filter((c) => c.files.length);
        const notes = [];
        if (data.engines && data.engines.length) notes.push(`Sources: ${data.engines.join(', ')}`);
        if (data.errors && data.errors.length) notes.push(`${data.errors.length} source(s) failed: ${data.errors.slice(0, 3).join(' · ')}`);

        if (!data.channels.length) {
            showMessage(['No public channels found for this search. Try another spelling, or add channels under "My channels".', ...notes].join('\n'), 'info');
            return;
        }
        const total = withFiles.reduce((sum, c) => sum + c.files.length, 0);
        showMessage([`${total} comic file(s) in ${withFiles.length} of ${data.channels.length} channel(s).`, ...notes].join('\n'), 'info');

        data.channels.forEach((channel) => {
            els.results.appendChild(channelCard(channel, { query: data.query }));
        });
    }

    /* ---------------- rendering ---------------- */

    function loadingRow(text) {
        const row = document.createElement('div');
        row.className = 'finder-loading';
        row.innerHTML = '<div class="finder-spinner"></div>';
        row.append(text);
        return row;
    }

    function channelCard(channel, { query }) {
        const card = document.createElement('section');
        card.className = 'finder-channel';
        card.dataset.username = channel.username;

        const header = document.createElement('div');
        header.className = 'finder-channel-header';

        const avatar = document.createElement('div');
        avatar.className = 'finder-avatar';
        const initial = (channel.title || channel.username).slice(0, 1).toUpperCase();
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
        const title = document.createElement('a');
        title.className = 'finder-channel-title';
        title.href = `https://t.me/s/${channel.username}`;
        title.target = '_blank';
        title.rel = 'noopener';
        title.textContent = channel.title || channel.username;
        const sub = document.createElement('div');
        sub.className = 'finder-channel-sub';
        sub.textContent = `@${channel.username}` + channelNote(channel, query);
        titles.append(title, sub);

        const actions = document.createElement('div');
        actions.className = 'finder-channel-actions';
        const browse = document.createElement('button');
        browse.type = 'button';
        browse.className = 'link-btn link-btn-small';
        browse.textContent = 'Latest comics';
        browse.title = 'Show the newest comic files of this channel';
        browse.addEventListener('click', () => loadChannel(card, channel.username, '', null, true));
        actions.appendChild(browse);

        if (!settings.channels.includes(channel.username)) {
            const keep = document.createElement('button');
            keep.type = 'button';
            keep.className = 'link-btn link-btn-small';
            keep.textContent = 'Add to my channels';
            keep.addEventListener('click', () => {
                settings.channels = [...new Set([...settings.channels, channel.username])].slice(0, 20);
                els.channelList.value = settings.channels.map((c) => '@' + c).join('\n');
                saveSettings();
                updateChannelCount();
                keep.remove();
            });
            actions.appendChild(keep);
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
                ? 'This channel hides its web preview. Start the helper with --api-id to search it.'
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
        if (hiddenCount || channel.oldestId) {
            const more = document.createElement('button');
            more.type = 'button';
            more.className = 'link-btn link-btn-small finder-more';
            more.textContent = hiddenCount ? `Show ${hiddenCount} more` : 'Load older posts';
            more.addEventListener('click', () => {
                if (hiddenCount) {
                    list.querySelectorAll('.finder-file[hidden]').forEach((row) => { row.hidden = false; });
                    more.remove();
                    if (channel.oldestId) renderMoreButton(card, channel);
                } else {
                    loadChannel(card, channel.username, card.dataset.query || '', channel.oldestId, false);
                }
            });
            card.appendChild(more);
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
            const params = new URLSearchParams({ u: username });
            if (query) params.set('q', query);
            if (before) params.set('before', String(before));
            const channel = await (await helperFetch('/channel?' + params)).json();
            loading.remove();
            if (replace) {
                card.querySelector('.finder-channel-title').textContent = channel.title || username;
            }
            if (!replace && !channel.files.length && channel.oldestId && channel.oldestId !== before) {
                // older page had no comics: offer to keep going
                renderMoreButton(card, channel);
                return;
            }
            renderFiles(card, channel, replace);
        } catch (err) {
            loading.remove();
            const error = document.createElement('div');
            error.className = 'finder-empty error';
            error.textContent = err.message;
            list.appendChild(error);
        }
    }

    function fileRow(username, file) {
        const row = document.createElement('div');
        row.className = 'finder-file';
        row.dataset.username = username;
        row.dataset.id = String(file.id);
        row.dataset.name = file.name;
        if (file.protected) row.dataset.protected = 'true';

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
        read.addEventListener('click', () => readFile(row, file));

        const save = document.createElement('button');
        save.type = 'button';
        save.className = 'finder-icon-btn finder-save';
        save.title = 'Save file to this computer';
        save.setAttribute('aria-label', `Save ${file.name}`);
        save.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v8M4.5 6.5L8 10l3.5-3.5M2.5 13.5h11"/></svg>';
        save.addEventListener('click', () => saveFile(row, file));

        const open = document.createElement('a');
        open.className = 'finder-icon-btn';
        open.href = file.url;
        open.target = '_blank';
        open.rel = 'noopener';
        open.title = 'Open the post in Telegram';
        open.setAttribute('aria-label', `Open ${file.name} in Telegram`);
        open.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 2.5h4.5V7M13.5 2.5L7 9M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3"/></svg>';

        actions.append(read, save, open);
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
        const canDownload = state.downloads && !blocked;

        read.disabled = !(cached || canDownload) || row.dataset.busy === 'true';
        save.disabled = !canDownload || row.dataset.busy === 'true';
        read.title = cached
            ? 'Already downloaded, opens instantly'
            : blocked
                ? 'This channel does not allow saving its files'
                : state.downloads
                    ? 'Download and read here'
                    : 'Start the helper with --api-id/--api-hash to read files here, or open the post in Telegram';
        row.classList.toggle('is-cached', cached);
    }

    function formatDate(iso) {
        if (!iso) return '';
        const date = new Date(iso);
        if (Number.isNaN(date.getTime())) return '';
        return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    }

    /* ---------------- downloads ---------------- */

    async function downloadFile(row, file) {
        const progress = row.querySelector('.finder-file-progress');
        const fill = progress.firstElementChild;
        row.dataset.busy = 'true';
        updateFileActions(row);
        progress.hidden = false;
        fill.style.width = '0%';
        try {
            const params = new URLSearchParams({ u: row.dataset.username, id: row.dataset.id });
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
                    if (total) fill.style.width = `${Math.min(100, Math.round((received / total) * 100))}%`;
                }
            } else {
                chunks.push(new Uint8Array(await response.arrayBuffer()));
            }
            fill.style.width = '100%';
            const headerName = response.headers.get('X-File-Name');
            const name = headerName ? decodeURIComponent(headerName) : file.name;
            return new File(chunks, name, { type: 'application/octet-stream', lastModified: Date.parse(file.date) || Date.now() });
        } finally {
            row.dataset.busy = 'false';
            setTimeout(() => { progress.hidden = true; }, 600);
            updateFileActions(row);
        }
    }

    async function readFile(row, file) {
        try {
            if (row.dataset.cached === 'true' && window.ComicReader) {
                await window.ComicReader.openRecent(file.name);
                return;
            }
            const downloaded = await downloadFile(row, file);
            row.dataset.cached = 'true';
            updateFileActions(row);
            window.ComicReader.openFile(downloaded, 'telegram');
        } catch (err) {
            showMessage(`${file.name}: ${err.message}`, 'error');
        }
    }

    async function saveFile(row, file) {
        try {
            const downloaded = await downloadFile(row, file);
            const url = URL.createObjectURL(downloaded);
            const link = document.createElement('a');
            link.href = url;
            link.download = downloaded.name;
            document.body.appendChild(link);
            link.click();
            link.remove();
            setTimeout(() => URL.revokeObjectURL(url), 10000);
        } catch (err) {
            showMessage(`${file.name}: ${err.message}`, 'error');
        }
    }

    /* ---------------- public ---------------- */

    window.TelegramFinder = {
        onShow() {
            checkHelper();
            setTimeout(() => els.query.focus(), 50);
        }
    };
});
