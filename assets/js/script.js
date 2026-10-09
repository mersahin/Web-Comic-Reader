document.addEventListener('DOMContentLoaded', () => {

    const outputElement = document.getElementById('output');
    const progressTextElement = document.querySelector('.progress-text');
    const sePreConElement = document.querySelector('.se-pre-con');
    const currYearElement = document.getElementById('currYear');
    const selectFolderBtn = document.getElementById('selectFolderBtn');
    const quickReadBtn = document.getElementById('quickReadBtn');
    const toggleUploadBtn = document.getElementById('toggleUploadBtn');
    const backToLibraryBtn = document.getElementById('backToLibraryBtn');
    const recentComicsEl = document.getElementById('recentComics');
    const recentComicsListEl = document.getElementById('recentComicsList');
    const clearRecentBtn = document.getElementById('clearRecentBtn');
    const allComicsEl = document.getElementById('allComics');
    const allComicsListEl = document.getElementById('allComicsList');
    const dividerOrEl = document.getElementById('dividerOr');
    const initialViewEl = document.getElementById('initialView');
    const libraryViewEl = document.getElementById('libraryView');
    const quickReadViewEl = document.getElementById('quickReadView');
    const browserNoticeEl = document.getElementById('browserNotice');
    const changeFolderBtn = document.getElementById('changeFolderBtn');
    const currentFolderNameEl = document.getElementById('currentFolderName');

    // reader chrome
    const readerBarEl = document.getElementById('readerBar');
    const readerTitleEl = document.getElementById('readerTitle');
    const readerPageEl = document.getElementById('readerPage');
    const readerCloseBtn = document.getElementById('readerCloseBtn');
    const modeButtons = document.querySelectorAll('#readerBar [data-mode]');
    const readerWidthBtn = document.getElementById('readerWidthBtn');
    const readerFullscreenBtn = document.getElementById('readerFullscreenBtn');
    const readerProgressEl = document.getElementById('readerProgress');
    const readerProgressFillEl = readerProgressEl.querySelector('.reader-progress-fill');
    const resumeToastEl = document.getElementById('resumeToast');
    const resumeToastTextEl = document.getElementById('resumeToastText');
    const resumeStartOverBtn = document.getElementById('resumeStartOverBtn');

    const HISTORY_KEY = 'comic_reader_userpref';
    const SETTINGS_KEY = 'comic_reader_settings';
    const PROJECT_START_YEAR = 2026;

    const STRIP_WIDTHS = [
        { key: 'narrow', label: 'S', px: 640, name: 'Narrow' },
        { key: 'medium', label: 'M', px: 820, name: 'Medium' },
        { key: 'wide', label: 'L', px: 1100, name: 'Wide' },
        { key: 'full', label: 'Full', px: null, name: 'Full width' }
    ];

    const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'avif']);
    const pageNameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

    let comicsDirectoryHandle = null;
    let isLibraryMode = false;

    const settings = loadSettings();

    // reader state; `token` invalidates async work of a previously opened comic
    const reader = {
        open: false,
        token: 0,
        filename: '',
        pages: [],
        urls: [],
        current: 0,
        tracking: false,
        saveTimer: null,
        lastScrollY: 0,
        barHidden: false,
        toastTimer: null,
        scrollRaf: 0
    };

    // current year
    const currYear = (new Date()).getFullYear();
    currYearElement.textContent = currYear > PROJECT_START_YEAR
        ? `${PROJECT_START_YEAR} – ${currYear}`
        : String(PROJECT_START_YEAR);

    // check if File System Access API is supported
    const supportsFileSystemAccess = 'showDirectoryPicker' in window;

    if (supportsFileSystemAccess) {
        selectFolderBtn.style.display = 'flex';
        dividerOrEl.style.display = 'block';
    } else {
        // when API not supported, show notice and make quick read button primary
        browserNoticeEl.style.display = 'block';
        quickReadBtn.classList.remove('folder-btn-secondary');
        quickReadBtn.classList.add('folder-btn-primary');
    }

    if (!document.fullscreenEnabled) {
        readerFullscreenBtn.hidden = true;
    }

    // Load all the archive formats
    loadArchiveFormats(['rar', 'zip', 'tar']);

    // select comics folder
    if (selectFolderBtn) {
        selectFolderBtn.addEventListener('click', async () => {
            try {
                // if we already have a handle, try to request permission first
                if (comicsDirectoryHandle) {
                    const permission = await comicsDirectoryHandle.requestPermission({ mode: 'read' });
                    if (permission === 'granted') {
                        await showLibraryMode();
                        return;
                    }
                }

                // show directory picker
                const dirHandle = await window.showDirectoryPicker({
                    mode: 'read'
                });

                // explicitly request persistent permission
                const permission = await dirHandle.requestPermission({ mode: 'read' });
                if (permission !== 'granted') {
                    console.error('Permission not granted');
                    return;
                }

                comicsDirectoryHandle = dirHandle;
                await saveDirectoryHandle(dirHandle);
                await showLibraryMode();
            } catch (err) {
                if (err.name !== 'AbortError') {
                    console.error('Error selecting folder:', err);
                }
            }
        });
    }

    // quick read button
    if (quickReadBtn) {
        quickReadBtn.addEventListener('click', () => {
            showQuickReadMode();
        });
    }

    // toggle upload button
    if (toggleUploadBtn) {
        toggleUploadBtn.addEventListener('click', () => {
            showQuickReadMode();
        });
    }

    // back to library button
    if (backToLibraryBtn) {
        backToLibraryBtn.addEventListener('click', async () => {
            if (comicsDirectoryHandle) {
                const permission = await comicsDirectoryHandle.queryPermission({ mode: 'read' });
                if (permission === 'granted') {
                    await showLibraryMode();
                } else {
                    // need to request permission with user gesture
                    try {
                        const newPermission = await comicsDirectoryHandle.requestPermission({ mode: 'read' });
                        if (newPermission === 'granted') {
                            await showLibraryMode();
                        } else {
                            showReconnectButton();
                        }
                    } catch (err) {
                        console.error('Failed to request permission:', err);
                        showReconnectButton();
                    }
                }
            }
        });
    }

    // change folder button
    if (changeFolderBtn) {
        changeFolderBtn.addEventListener('click', async () => {
            try {
                // always show directory picker to select a new folder
                const dirHandle = await window.showDirectoryPicker({
                    mode: 'read'
                });

                // explicitly request persistent permission
                const permission = await dirHandle.requestPermission({ mode: 'read' });
                if (permission !== 'granted') {
                    console.error('Permission not granted');
                    return;
                }

                comicsDirectoryHandle = dirHandle;
                await saveDirectoryHandle(dirHandle);
                await showLibraryMode();
            } catch (err) {
                if (err.name !== 'AbortError') {
                    console.error('Error selecting folder:', err);
                }
            }
        });
    }

    // clear the "Recently Read" list (progress and thumbnails are kept)
    if (clearRecentBtn) {
        clearRecentBtn.addEventListener('click', async () => {
            if (!confirm('Clear the Recently Read list?\nYour reading progress is kept.')) return;
            hideFromRecent(null);
            await loadRecentComics();
        });
    }

    // load directory handle on startup
    if (supportsFileSystemAccess) {
        loadDirectoryHandle().then(async (result) => {
            if (result.handle && result.hasPermission) {
                comicsDirectoryHandle = result.handle;
                await showLibraryMode();
            } else if (result.handle && !result.hasPermission) {
                // we have a handle but need permission - show button to re-grant
                comicsDirectoryHandle = result.handle;
                showReconnectButton();
            }
        });
    }

    function showReconnectButton() {
        // show initial view with modified button text
        initialViewEl.style.display = 'block';
        libraryViewEl.style.display = 'none';
        quickReadViewEl.style.display = 'none';

        // change button text to indicate reconnection
        const titleEl = selectFolderBtn.querySelector('.btn-title');
        const subtitleEl = selectFolderBtn.querySelector('.btn-subtitle');
        if (titleEl && subtitleEl) {
            titleEl.textContent = 'Reconnect to Comics Folder';
            subtitleEl.textContent = 'Click to restore access to your library';
        }
    }

    async function showLibraryMode() {
        if (!comicsDirectoryHandle) return;

        isLibraryMode = true;
        initialViewEl.style.display = 'none';
        libraryViewEl.style.display = 'block';
        quickReadViewEl.style.display = 'none';

        // display current folder name
        if (currentFolderNameEl && comicsDirectoryHandle.name) {
            currentFolderNameEl.innerHTML = `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M1.75 1A1.75 1.75 0 000 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0016 13.25v-8.5A1.75 1.75 0 0014.25 3H7.5a.25.25 0 01-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75z"/></svg>`;
            currentFolderNameEl.append(comicsDirectoryHandle.name);
        }

        // reset button text in case it was changed
        const titleEl = selectFolderBtn.querySelector('.btn-title');
        const subtitleEl = selectFolderBtn.querySelector('.btn-subtitle');
        if (titleEl && subtitleEl) {
            titleEl.textContent = 'Select Comics Folder';
            subtitleEl.textContent = 'Auto-track progress, browse all comics';
        }

        await loadRecentComics();
        await loadAllComics();

        allComicsEl.style.display = 'block';
    }

    function showQuickReadMode() {
        isLibraryMode = false;
        initialViewEl.style.display = 'none';
        libraryViewEl.style.display = 'none';
        quickReadViewEl.style.display = 'block';

        // reset button text in case it was changed
        const titleEl = selectFolderBtn.querySelector('.btn-title');
        const subtitleEl = selectFolderBtn.querySelector('.btn-subtitle');
        if (titleEl && subtitleEl) {
            titleEl.textContent = 'Select Comics Folder';
            subtitleEl.textContent = 'Auto-track progress, browse all comics';
        }

        // show back to library button only if we have a directory handle
        if (backToLibraryBtn) {
            backToLibraryBtn.style.display = comicsDirectoryHandle ? 'block' : 'none';
        }
    }

    // re-show the panel after the reader was closed
    async function showPanel() {
        if (isLibraryMode && comicsDirectoryHandle) {
            // check permission again when returning
            const permission = await comicsDirectoryHandle.queryPermission({ mode: 'read' });
            if (permission === 'granted') {
                await showLibraryMode();
            } else {
                showReconnectButton();
            }
        } else if (!isLibraryMode) {
            showQuickReadMode();
        }
    }

    async function loadAllComics() {
        if (!comicsDirectoryHandle) return;

        try {
            // check permission before accessing
            const permission = await comicsDirectoryHandle.queryPermission({ mode: 'read' });
            if (permission !== 'granted') {
                allComicsListEl.innerHTML = '<div style="text-align: center; color: var(--muted); padding: 20px; font-size: 14px;">Permission required to access folder</div>';
                return;
            }

            allComicsListEl.innerHTML = '<div style="text-align: center; padding: 20px;"><div class="spinner" style="margin: 0 auto;"></div><div style="margin-top: 12px; color: var(--muted); font-size: 14px;">Scanning folder...</div></div>';

            const comics = [];
            const validExtensions = ['.cbr', '.cbz', '.cbt'];

            for await (const entry of comicsDirectoryHandle.values()) {
                if (entry.kind === 'file') {
                    const ext = '.' + entry.name.split('.').pop().toLowerCase();
                    if (validExtensions.includes(ext)) {
                        comics.push(entry.name);
                    }
                }
            }

            allComicsListEl.innerHTML = '';

            if (comics.length === 0) {
                allComicsListEl.innerHTML = '<div style="text-align: center; color: var(--muted); padding: 20px; font-size: 14px;">No comics found in this folder. Make sure your comics have .cbr, .cbz, or .cbt extension.</div>';
                return;
            }

            comics.sort(pageNameCollator.compare);

            // get reading history for thumbnails
            const readingHistory = readHistory();

            for (const filename of comics) {
                const item = createComicItem(filename, readingHistory[filename], null);
                item.addEventListener('click', () => openComicFromFolder(filename));
                allComicsListEl.appendChild(item);
            }
        } catch (err) {
            console.error('Failed to load all comics:', err);

            if (err.name === 'NotFoundError') {
                const folderName = comicsDirectoryHandle ? comicsDirectoryHandle.name : 'directory';

                allComicsListEl.innerHTML = '';

                const errorWrapper = document.createElement('div');
                errorWrapper.style.textAlign = 'center';
                errorWrapper.style.padding = '40px 20px';

                errorWrapper.innerHTML = `
                    <div style="margin-bottom: 10px; color: var(--text);">Failed to load comics from "<strong></strong>"</div>
                    <div style="margin-bottom: 25px; color: var(--muted); font-size: 14px;">The folder might have been moved, renamed, or deleted.</div>
                `;
                errorWrapper.querySelector('strong').textContent = folderName;

                // Clone the main select button to reuse its exact style
                if (selectFolderBtn) {
                    const btnClone = selectFolderBtn.cloneNode(true);
                    btnClone.id = ''; // Remove ID
                    btnClone.style.display = 'inline-flex';
                    btnClone.style.margin = '0 auto';

                    // Re-attach click handler to trigger original button
                    btnClone.addEventListener('click', () => {
                        selectFolderBtn.click();
                    });

                    errorWrapper.appendChild(btnClone);
                }

                allComicsListEl.appendChild(errorWrapper);

                // Clear the invalid handle from memory
                comicsDirectoryHandle = null;
            } else {
                allComicsListEl.innerHTML = '<div style="text-align: center; color: var(--muted); padding: 20px; font-size: 14px;">Error loading comics from folder</div>';
            }
        }
    }

    // builds a list row; `meta` is optional secondary text
    function createComicItem(filename, data, meta) {
        const item = document.createElement('div');
        item.className = 'recent-comic-item';

        const icon = document.createElement('div');
        icon.className = 'recent-comic-icon';
        if (data?.thumbnail) {
            const img = document.createElement('img');
            img.src = data.thumbnail;
            img.alt = '';
            icon.appendChild(img);
        } else {
            icon.innerHTML = `<svg viewBox="0 0 16 16">
                <path d="M3.5 2a1.5 1.5 0 0 0-1.5 1.5v9A1.5 1.5 0 0 0 3.5 14h9a1.5 1.5 0 0 0 1.5-1.5v-9A1.5 1.5 0 0 0 12.5 2h-9zm6.854 6.146a.5.5 0 0 1 0 .708l-3 3a.5.5 0 0 1-.708-.708L8.793 9H5.5a.5.5 0 0 1 0-1h3.293L6.646 5.854a.5.5 0 1 1 .708-.708l3 3z"/>
            </svg>`;
        }

        const info = document.createElement('div');
        info.className = 'recent-comic-info';
        const name = document.createElement('div');
        name.className = 'recent-comic-name';
        name.textContent = filename;
        name.title = filename;
        info.appendChild(name);
        if (meta) {
            const metaEl = document.createElement('div');
            metaEl.className = 'recent-comic-meta';
            metaEl.textContent = meta;
            info.appendChild(metaEl);
        }

        item.append(icon, info);
        return item;
    }

    // Dropzone configuration
    if (window.Dropzone) Dropzone.autoDiscover = false;
    let dropzone = new Dropzone("#dropzone", {
        url: '#',
        acceptedFiles: '.cbr,.cbz,.cbt',
        createImageThumbnails: false,
        autoProcessQueue: false,
        previewsContainer: false,
        maxFiles: 1,
        maxfilesexceeded: function(file) {
            this.removeAllFiles();
        },
        init: function () {
            this.on('addedfile', function (file) {
                openComic(file);
            });
        }
    });

    /* ------------------------------------------------------------------
     * Reader
     * ------------------------------------------------------------------ */

    function openComic(file) {
        resetReaderContent();
        const token = reader.token;

        reader.open = true;
        reader.filename = file.name;

        document.body.classList.add('reader-open');
        readerBarEl.hidden = false;
        readerProgressEl.hidden = false;
        readerTitleEl.textContent = file.name;
        readerTitleEl.title = file.name;
        applyMode(settings.mode, false);
        showBar();
        updatePageIndicator();
        updateProgress();
        window.scrollTo(0, 0);
        reader.lastScrollY = 0;

        progressTextElement.textContent = 'Opening archive...';
        sePreConElement.style.display = 'block';

        // Open the file as an archive
        archiveOpenFile(file, (archive, err) => {
            if (token !== reader.token) return;
            if (!archive) {
                showReaderError(err);
                return;
            }
            renderArchive(archive, token).catch((e) => {
                if (token === reader.token) showReaderError(e);
            });
        });
    }

    async function renderArchive(archive, token) {
        const entries = archive.entries
            .filter(isPageEntry)
            .sort((a, b) => pageNameCollator.compare(a.name, b.name));

        if (entries.length === 0) {
            throw new Error('No images found in this archive.');
        }

        const header = document.createElement('div');
        header.className = 'output-header';
        header.innerHTML = '<b></b><br><i>Click on an image to enlarge</i>';
        header.querySelector('b').textContent = archive.file_name;
        outputElement.appendChild(header);

        // create all page slots up front so the order never depends on extraction timing
        const fragment = document.createDocumentFragment();
        reader.pages = entries.map((entry, i) => {
            const a = document.createElement('a');
            a.className = 'comic-page';
            a.dataset.index = String(i);

            const img = document.createElement('img');
            img.className = 'imgUrl';
            img.alt = `Page ${i + 1}`;
            img.decoding = 'async';
            img.draggable = false;

            a.appendChild(img);
            fragment.appendChild(a);
            return a;
        });
        outputElement.appendChild(fragment);
        outputElement.appendChild(createStripEnd());
        updatePageIndicator();

        for (let i = 0; i < entries.length; i++) {
            progressTextElement.textContent = `Reading ${i + 1}/${entries.length} pages`;
            const data = await readEntryData(entries[i]);
            if (token !== reader.token) return;

            const page = reader.pages[i];
            if (!data) {
                page.classList.add('page-error');
                continue;
            }
            const url = URL.createObjectURL(new Blob([data], { type: getMIME(entries[i].name) }));
            reader.urls.push(url);
            page.href = url;
            page.firstChild.src = url;
        }

        archiveClose(archive);
        sePreConElement.style.display = 'none';

        generateThumbnail(token);
        await restorePosition(token);
    }

    function readEntryData(entry) {
        return new Promise((resolve) => {
            try {
                entry.readData((data, err) => {
                    if (err) console.warn('Failed to read', entry.name, err);
                    resolve(data || null);
                });
            } catch (e) {
                console.warn('Failed to read', entry.name, e);
                resolve(null);
            }
        });
    }

    function isPageEntry(entry) {
        if (entry.is_file === false) return false;
        const parts = entry.name.split(/[\\/]/);
        if (parts.includes('__MACOSX')) return false;
        const base = parts[parts.length - 1];
        if (!base || base.startsWith('.')) return false;
        return IMAGE_EXTENSIONS.has(getExt(base).toLowerCase());
    }

    function createStripEnd() {
        const end = document.createElement('div');
        end.className = 'strip-end';
        end.innerHTML = '<div class="strip-end-title">End of comic</div>';
        const closeBtn = document.createElement('button');
        closeBtn.className = 'folder-btn folder-btn-primary strip-end-btn';
        closeBtn.textContent = isLibraryMode ? 'Back to library' : 'Close';
        closeBtn.addEventListener('click', closeReader);
        end.appendChild(closeBtn);
        return end;
    }

    function showReaderError(err) {
        sePreConElement.style.display = 'none';
        outputElement.innerHTML = '';
        reader.pages = [];
        const box = document.createElement('div');
        box.className = 'reader-error';
        box.textContent = String(err?.message || err || 'Could not open this file.');
        outputElement.appendChild(box);
        updatePageIndicator();
    }

    // drops everything belonging to the current comic and invalidates pending async work
    function resetReaderContent() {
        flushSave();
        reader.token++;
        destroyGallery();
        reader.urls.forEach((url) => URL.revokeObjectURL(url));
        reader.urls = [];
        reader.pages = [];
        reader.current = 0;
        reader.tracking = false;
        outputElement.innerHTML = '';
        hideToast();
    }

    async function closeReader() {
        if (!reader.open) return;
        resetReaderContent();
        reader.open = false;
        reader.filename = '';
        sePreConElement.style.display = 'none';
        document.body.classList.remove('reader-open', 'reader-strip', 'reader-grid');
        readerBarEl.hidden = true;
        readerProgressEl.hidden = true;
        if (document.fullscreenElement) {
            document.exitFullscreen().catch(() => {});
        }
        window.scrollTo(0, 0);
        await showPanel();
    }

    async function restorePosition(token) {
        const lastPage = Math.min(getLastPageRead(reader.filename), reader.pages.length - 1);

        if (lastPage > 0) {
            reader.current = lastPage;
            if (settings.mode === 'strip') {
                // pages above the target must have their real height before we can jump
                await waitForImages(reader.pages.slice(0, lastPage + 1));
                if (token !== reader.token) return;
                scrollToPage(lastPage);
            } else {
                markLastRead(lastPage);
                setTimeout(() => {
                    if (token === reader.token) {
                        reader.pages[lastPage].scrollIntoView({ behavior: 'smooth', block: 'center' });
                    }
                }, 200);
            }
            showToast(`Resumed at page ${lastPage + 1}`);
        }

        reader.tracking = true;
        updatePageIndicator();
        updateProgress();
    }

    function waitForImages(pages) {
        const waits = pages.map((page) => {
            const img = page.firstChild;
            if (!img.src || img.complete) return Promise.resolve();
            return new Promise((resolve) => {
                img.addEventListener('load', resolve, { once: true });
                img.addEventListener('error', resolve, { once: true });
            });
        });
        const timeout = new Promise((resolve) => setTimeout(resolve, 8000));
        return Promise.race([Promise.all(waits), timeout]);
    }

    function scrollToPage(index) {
        const page = reader.pages[index];
        if (!page) return;
        const top = page.getBoundingClientRect().top + window.scrollY;
        window.scrollTo({ top, behavior: 'auto' });
    }

    // index of the page crossing the reading line (40% of the viewport height)
    function pageAtViewport() {
        const pages = reader.pages;
        if (pages.length === 0) return 0;
        const atBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;
        const lastRect = pages[pages.length - 1].getBoundingClientRect();
        if (atBottom && lastRect.top < window.innerHeight) return pages.length - 1;

        const probe = window.innerHeight * 0.4;
        let lo = 0;
        let hi = pages.length - 1;
        let found = 0;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (pages[mid].getBoundingClientRect().top <= probe) {
                found = mid;
                lo = mid + 1;
            } else {
                hi = mid - 1;
            }
        }
        return found;
    }

    function goToPage(index) {
        if (reader.pages.length === 0) return;
        scrollToPage(Math.max(0, Math.min(index, reader.pages.length - 1)));
    }

    function goToPreviousPage() {
        const current = pageAtViewport();
        const rect = reader.pages[current]?.getBoundingClientRect();
        // mid-page: go back to the top of the current page first
        if (rect && rect.top < -8) {
            goToPage(current);
        } else {
            goToPage(current - 1);
        }
    }

    // keeps the reading position stable across layout changes (e.g. page width)
    function preservePosition(change) {
        if (settings.mode !== 'strip' || reader.pages.length === 0) {
            change();
            return;
        }
        const index = pageAtViewport();
        const probe = window.innerHeight * 0.4;
        const before = reader.pages[index].getBoundingClientRect();
        const ratio = before.height ? (probe - before.top) / before.height : 0;
        change();
        const after = reader.pages[index].getBoundingClientRect();
        window.scrollTo(0, window.scrollY + after.top + ratio * after.height - probe);
    }

    function setCurrentPage(index) {
        if (index === reader.current) return;
        reader.current = index;
        updatePageIndicator();
        scheduleSave();
    }

    function updatePageIndicator() {
        const total = reader.pages.length;
        readerPageEl.textContent = `${total ? reader.current + 1 : 0} / ${total}`;
    }

    function updateProgress() {
        let ratio = 0;
        if (settings.mode === 'strip') {
            const max = document.documentElement.scrollHeight - window.innerHeight;
            ratio = max > 0 ? window.scrollY / max : (reader.pages.length ? 1 : 0);
        } else if (reader.pages.length) {
            ratio = (reader.current + 1) / reader.pages.length;
        }
        readerProgressFillEl.style.transform = `scaleX(${Math.max(0, Math.min(1, ratio))})`;
    }

    function scheduleSave() {
        if (!reader.tracking || !reader.filename) return;
        clearTimeout(reader.saveTimer);
        reader.saveTimer = setTimeout(flushSave, 400);
    }

    function flushSave() {
        if (!reader.saveTimer) return;
        clearTimeout(reader.saveTimer);
        reader.saveTimer = null;
        if (reader.tracking && reader.filename) {
            saveLastPageRead(reader.filename, reader.current);
        }
    }

    /* view modes */

    function applyMode(mode, keepPosition = true) {
        const index = reader.current;
        if (mode === 'strip') destroyGallery();

        settings.mode = mode;
        saveSettings();

        outputElement.classList.toggle('mode-strip', mode === 'strip');
        outputElement.classList.toggle('mode-grid', mode === 'grid');
        document.body.classList.toggle('reader-strip', reader.open && mode === 'strip');
        document.body.classList.toggle('reader-grid', reader.open && mode === 'grid');
        modeButtons.forEach((btn) => {
            const active = btn.dataset.mode === mode;
            btn.classList.toggle('active', active);
            btn.setAttribute('aria-pressed', String(active));
        });
        readerWidthBtn.hidden = mode !== 'strip';
        applyWidth();
        showBar();

        if (keepPosition && reader.tracking && reader.pages.length) {
            if (mode === 'strip') {
                scrollToPage(index);
            } else {
                markLastRead(index);
                reader.pages[index].scrollIntoView({ block: 'center' });
            }
            reader.current = index;
            updatePageIndicator();
        }
        updateProgress();
    }

    function toggleMode() {
        applyMode(settings.mode === 'strip' ? 'grid' : 'strip');
    }

    function applyWidth() {
        const width = STRIP_WIDTHS.find((w) => w.key === settings.width) || STRIP_WIDTHS[1];
        outputElement.style.setProperty('--strip-width', width.px ? `${width.px}px` : '100%');
        readerWidthBtn.textContent = width.label;
        readerWidthBtn.title = `Page width: ${width.name} (W)`;
    }

    function cycleWidth(step = 1) {
        const index = Math.max(0, STRIP_WIDTHS.findIndex((w) => w.key === settings.width));
        const next = STRIP_WIDTHS[(index + step + STRIP_WIDTHS.length) % STRIP_WIDTHS.length];
        preservePosition(() => {
            settings.width = next.key;
            saveSettings();
            applyWidth();
        });
    }

    function toggleFullscreen() {
        if (!document.fullscreenEnabled) return;
        if (document.fullscreenElement) {
            document.exitFullscreen().catch(() => {});
        } else {
            document.documentElement.requestFullscreen().catch(() => {});
        }
    }

    /* toolbar visibility */

    function showBar() {
        reader.barHidden = false;
        readerBarEl.classList.remove('rb-hidden');
    }

    function hideBar() {
        if (settings.mode !== 'strip') return;
        reader.barHidden = true;
        readerBarEl.classList.add('rb-hidden');
    }

    function showToast(text) {
        resumeToastTextEl.textContent = text;
        resumeToastEl.hidden = false;
        clearTimeout(reader.toastTimer);
        reader.toastTimer = setTimeout(hideToast, 6000);
    }

    function hideToast() {
        clearTimeout(reader.toastTimer);
        resumeToastEl.hidden = true;
    }

    /* grid mode gallery (lightGallery v1 does not return an instance) */

    function initGallery() {
        lightGallery(outputElement, {
            selector: '.comic-page',
            zoom: true,
            fullScreen: true,
            download: false,
            enableTouch: true,
            thumbnail: true,
            animateThumb: true,
            showThumbByDefault: true,
            autoplay: false,
            autoplayControls: true,
            rotate: true
        });
    }

    function destroyGallery() {
        const uid = outputElement.getAttribute('lg-uid');
        if (uid && window.lgData && window.lgData[uid]) {
            const scrollY = window.scrollY;
            window.lgData[uid].destroy(true);
            // destroy() restores a stale scroll position; keep the current one
            window.scrollTo(0, scrollY);
        }
    }

    function markLastRead(index) {
        outputElement.querySelectorAll('.comic-page.last-read').forEach((a) => a.classList.remove('last-read'));
        reader.pages[index]?.classList.add('last-read');
    }

    // track page changes inside the gallery
    outputElement.addEventListener('onAfterSlide', (event) => {
        const index = event.detail.index;
        markLastRead(index);
        setCurrentPage(index);
        updateProgress();
    });

    outputElement.addEventListener('click', (event) => {
        const page = event.target.closest('.comic-page');

        if (settings.mode === 'strip') {
            if (!page) return;
            event.preventDefault();
            if (reader.barHidden) showBar(); else hideBar();
            return;
        }

        if (!page || !page.getAttribute('href')) return;
        if (!outputElement.getAttribute('lg-uid')) {
            // init the gallery on first click, then replay the click so it opens on this page.
            // dispatchEvent instead of click(): click() is ignored while this element's click is in progress
            event.preventDefault();
            initGallery();
            page.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        }
    });

    /* reader events */

    readerCloseBtn.addEventListener('click', closeReader);
    readerWidthBtn.addEventListener('click', () => cycleWidth(1));
    readerFullscreenBtn.addEventListener('click', toggleFullscreen);
    modeButtons.forEach((btn) => {
        btn.addEventListener('click', () => {
            if (btn.dataset.mode !== settings.mode) applyMode(btn.dataset.mode);
        });
    });
    resumeStartOverBtn.addEventListener('click', () => {
        hideToast();
        if (settings.mode === 'strip') {
            window.scrollTo({ top: 0, behavior: 'auto' });
        } else {
            markLastRead(0);
            setCurrentPage(0);
            window.scrollTo({ top: 0, behavior: 'smooth' });
        }
        showBar();
    });

    document.addEventListener('fullscreenchange', () => {
        readerFullscreenBtn.classList.toggle('active', Boolean(document.fullscreenElement));
    });

    window.addEventListener('scroll', () => {
        if (!reader.open || reader.scrollRaf) return;
        reader.scrollRaf = requestAnimationFrame(onReaderScroll);
    }, { passive: true });

    window.addEventListener('resize', () => {
        if (reader.open) updateProgress();
    });

    function onReaderScroll() {
        reader.scrollRaf = 0;
        const y = window.scrollY;

        if (settings.mode === 'strip') {
            const delta = y - reader.lastScrollY;
            if (y < 40) {
                showBar();
                reader.lastScrollY = y;
            } else if (Math.abs(delta) > 12) {
                if (delta > 0) hideBar(); else showBar();
                reader.lastScrollY = y;
            }
            if (reader.pages.length) setCurrentPage(pageAtViewport());
        }
        updateProgress();
    }

    // reveal the toolbar when the pointer reaches the top edge
    document.addEventListener('mousemove', (event) => {
        if (reader.open && reader.barHidden && event.clientY < 56) showBar();
    }, { passive: true });

    document.addEventListener('keydown', (event) => {
        if (!reader.open || document.body.classList.contains('lg-on')) return;
        if (event.altKey || event.ctrlKey || event.metaKey) return;
        if (event.target.closest && event.target.closest('input, textarea, select, [contenteditable="true"]')) return;

        const strip = settings.mode === 'strip';
        switch (event.key) {
            case 'ArrowRight':
            case 'd':
            case 'n':
                if (!strip) return;
                event.preventDefault();
                goToPage(pageAtViewport() + 1);
                break;
            case 'ArrowLeft':
            case 'a':
            case 'p':
                if (!strip) return;
                event.preventDefault();
                goToPreviousPage();
                break;
            case 'm':
            case 'M':
                toggleMode();
                break;
            case 'w':
            case 'W':
                if (strip) cycleWidth(event.shiftKey ? -1 : 1);
                break;
            case 'f':
            case 'F':
                toggleFullscreen();
                break;
            case 'Escape':
                if (!document.fullscreenElement) closeReader();
                break;
            default:
                return;
        }
    });

    /* helpers */

    function getExt(filename) {
        const ext = filename.split('.').pop();
        return (ext === filename) ? '' : ext;
    }

    function getMIME(filename) {
        const ext = getExt(filename).toLowerCase();
        const mimeTypes = {
            'jpg': 'image/jpeg',
            'jpeg': 'image/jpeg',
            'png': 'image/png',
            'gif': 'image/gif',
            'bmp': 'image/bmp',
            'webp': 'image/webp',
            'avif': 'image/avif'
        };
        return mimeTypes[ext] || 'image/jpeg';
    }

    function loadSettings() {
        const defaults = { mode: 'strip', width: 'medium' };
        try {
            const stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
            return {
                mode: stored.mode === 'grid' ? 'grid' : defaults.mode,
                width: STRIP_WIDTHS.some((w) => w.key === stored.width) ? stored.width : defaults.width
            };
        } catch (e) {
            return defaults;
        }
    }

    function saveSettings() {
        try {
            localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
        } catch (e) {
            // storage unavailable (private mode etc.) - settings stay in memory
        }
    }

    function readHistory() {
        try {
            return JSON.parse(localStorage.getItem(HISTORY_KEY) || '{}') || {};
        } catch (e) {
            console.error('Failed to read reading history:', e);
            return {};
        }
    }

    function writeHistory(history) {
        try {
            localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
        } catch (e) {
            console.error('Failed to save reading history:', e);
        }
    }

    function generateThumbnail(token) {
        const img = reader.pages[0]?.firstChild;
        if (!img || !img.src) return;

        const run = () => {
            if (token !== reader.token || !img.naturalWidth) return;
            try {
                const canvas = document.createElement('canvas');
                const ctx = canvas.getContext('2d');
                const maxWidth = 100;
                const scale = maxWidth / img.naturalWidth;
                canvas.width = maxWidth;
                canvas.height = Math.round(img.naturalHeight * scale);

                ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                const thumbnail = canvas.toDataURL('image/jpeg', 0.7);

                // keep the stored last_page; only the thumbnail is new
                const existing = readHistory()[reader.filename] || {};
                saveLastPageRead(reader.filename, existing.last_page || 0, thumbnail);
            } catch (e) {
                console.error('Failed to create thumbnail:', e);
            }
        };

        if (img.complete && img.naturalWidth) {
            run();
        } else {
            img.addEventListener('load', run, { once: true });
        }
    }

    function saveLastPageRead(filename, pageIndex, thumbnail = null) {
        const readingHistory = readHistory();
        const existing = readingHistory[filename] || {};
        const finalThumbnail = thumbnail || existing.thumbnail || null;

        // reading a comic again brings it back into "Recently Read"
        readingHistory[filename] = {
            last_page: pageIndex,
            timestamp: Date.now(),
            thumbnail: finalThumbnail
        };
        writeHistory(readingHistory);
    }

    function getLastPageRead(filename) {
        return readHistory()[filename]?.last_page || 0;
    }

    // hides one comic (or all when filename is null) from "Recently Read" without losing progress
    function hideFromRecent(filename) {
        const readingHistory = readHistory();
        const names = filename === null ? Object.keys(readingHistory) : [filename];
        names.forEach((name) => {
            if (readingHistory[name]) readingHistory[name].hidden_from_recent = true;
        });
        writeHistory(readingHistory);
    }

    // IndexedDB functions for storing directory handle
    function openDB() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open('ComicReaderDB', 1);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve(request.result);
            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains('directories')) {
                    db.createObjectStore('directories');
                }
            };
        });
    }

    async function saveDirectoryHandle(dirHandle) {
        try {
            const db = await openDB();
            const tx = db.transaction('directories', 'readwrite');
            const store = tx.objectStore('directories');
            store.put(dirHandle, 'comicsFolder');
            await tx.complete;
        } catch (err) {
            console.error('Failed to save directory handle:', err);
        }
    }

    async function loadDirectoryHandle() {
        try {
            const db = await openDB();
            const tx = db.transaction('directories', 'readonly');
            const store = tx.objectStore('directories');
            const handle = await new Promise((resolve, reject) => {
                const request = store.get('comicsFolder');
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
            });

            if (handle) {
                // verify we still have permission
                const permission = await handle.queryPermission({ mode: 'read' });
                if (permission === 'granted') {
                    return { handle, hasPermission: true };
                } else {
                    // permission is 'prompt' or 'denied' - need user interaction
                    return { handle, hasPermission: false };
                }
            }
            return { handle: null, hasPermission: false };
        } catch (err) {
            console.error('Failed to load directory handle:', err);
            return { handle: null, hasPermission: false };
        }
    }

    async function loadRecentComics() {
        try {
            const recentComics = Object.entries(readHistory())
                .filter(([, data]) => data && !data.hidden_from_recent)
                .sort((a, b) => b[1].timestamp - a[1].timestamp)
                .slice(0, 5);

            recentComicsListEl.innerHTML = '';

            for (const [filename, data] of recentComics) {
                const item = createComicItem(
                    filename,
                    data,
                    `Page ${(data.last_page || 0) + 1} • ${formatTimestamp(data.timestamp)}`
                );

                const removeBtn = document.createElement('button');
                removeBtn.className = 'recent-remove-btn';
                removeBtn.title = 'Remove from Recently Read';
                removeBtn.setAttribute('aria-label', `Remove ${filename} from Recently Read`);
                removeBtn.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>';
                removeBtn.addEventListener('click', async (event) => {
                    event.stopPropagation();
                    hideFromRecent(filename);
                    await loadRecentComics();
                });
                item.appendChild(removeBtn);

                item.addEventListener('click', () => openComicFromFolder(filename));
                recentComicsListEl.appendChild(item);
            }

            recentComicsEl.style.display = recentComicsListEl.children.length > 0 ? 'block' : 'none';
        } catch (err) {
            console.error('Failed to load recent comics:', err);
        }
    }

    async function removeComicFromHistory(filename) {
        const readingHistory = readHistory();
        if (readingHistory[filename]) {
            delete readingHistory[filename];
            writeHistory(readingHistory);

            // Refresh UI (hides the section when the list becomes empty)
            await loadRecentComics();
        }
    }

    async function openComicFromFolder(filename) {
        try {
            if (!comicsDirectoryHandle) {
                throw new Error('Directory handle not available');
            }

            // check permission before accessing files
            const permission = await comicsDirectoryHandle.queryPermission({ mode: 'read' });
            if (permission !== 'granted') {
                // try to request permission
                const newPermission = await comicsDirectoryHandle.requestPermission({ mode: 'read' });
                if (newPermission !== 'granted') {
                    showReconnectButton();
                    return;
                }
            }

            const fileHandle = await comicsDirectoryHandle.getFileHandle(filename);
            const file = await fileHandle.getFile();
            openComic(file);
        } catch (err) {
            console.error('Failed to open comic:', err);
            if (err.name === 'NotAllowedError') {
                showReconnectButton();
            } else {
                alert('Could not find this comic in the selected folder. Please re-upload it or select a different folder.');
                await removeComicFromHistory(filename);
            }
        }
    }

    function formatTimestamp(timestamp) {
        const now = Date.now();
        const diff = now - timestamp;
        const seconds = Math.floor(diff / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);
        const days = Math.floor(hours / 24);

        if (days > 0) return `${days}d ago`;
        if (hours > 0) return `${hours}h ago`;
        if (minutes > 0) return `${minutes}m ago`;
        return 'Just now';
    }
});
