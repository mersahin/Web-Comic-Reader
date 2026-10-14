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
    const searchViewEl = document.getElementById('searchView');
    const accountViewEl = document.getElementById('accountView');
    const accountBackBtn = document.getElementById('accountBackBtn');
    const searchTelegramBtn = document.getElementById('searchTelegramBtn');
    const librarySearchBtn = document.getElementById('librarySearchBtn');
    const searchBackBtn = document.getElementById('searchBackBtn');
    const reopenNoticeEl = document.getElementById('reopenNotice');
    const dropzoneEl = document.getElementById('dropzone');
    const quickReadInputEl = document.getElementById('quickReadInput');
    const browserNoticeEl = document.getElementById('browserNotice');
    const changeFolderBtn = document.getElementById('changeFolderBtn');
    const currentFolderNameEl = document.getElementById('currentFolderName');

    // reader chrome
    const readerBarEl = document.getElementById('readerBar');
    const readerTitleEl = document.getElementById('readerTitle');
    const readerPageEl = document.getElementById('readerPage');
    const pageJumpEl = document.getElementById('pageJump');
    const pageJumpRangeEl = document.getElementById('pageJumpRange');
    const pageJumpNumberEl = document.getElementById('pageJumpNumber');
    const pageJumpTotalEl = document.getElementById('pageJumpTotal');
    const pageJumpGoBtn = document.getElementById('pageJumpGo');
    const readerCloseBtn = document.getElementById('readerCloseBtn');
    const modeButtons = document.querySelectorAll('#readerBar [data-mode]');
    const readerWidthBtn = document.getElementById('readerWidthBtn');
    const readerFullscreenBtn = document.getElementById('readerFullscreenBtn');
    const readerProgressEl = document.getElementById('readerProgress');
    const readerProgressFillEl = readerProgressEl.querySelector('.reader-progress-fill');
    const resumeToastEl = document.getElementById('resumeToast');
    const resumeToastTextEl = document.getElementById('resumeToastText');
    const resumeStartOverBtn = document.getElementById('resumeStartOverBtn');
    const loadingCancelBtn = document.getElementById('loadingCancelBtn');

    const HISTORY_KEY = 'comic_reader_userpref';
    const SETTINGS_KEY = 'comic_reader_settings';
    const PROJECT_START_YEAR = 2026;
    // recently opened comics are kept in IndexedDB (least recently read dropped first) so "Recently Read" reopens them in one click
    const FILE_CACHE_LIMIT = 1024 * 1024 * 1024;
    const RECENT_LIMIT = 20;
    // cover thumbnails live in the shared localStorage quota, so they are kept small (tall pages are cropped)
    const THUMB_WIDTH = 100;
    const THUMB_MAX_HEIGHT = 150;

    const STRIP_WIDTHS = [
        { key: 'narrow', label: 'S', px: 640, name: 'Narrow' },
        { key: 'medium', label: 'M', px: 820, name: 'Medium' },
        { key: 'wide', label: 'L', px: 1100, name: 'Wide' },
        { key: 'full', label: 'Full', px: null, name: 'Full width' }
    ];

    const COMIC_FILE_PATTERN = /\.(cbr|cbz|cbt)$/i;
    const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'avif']);
    const pageNameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    // rar/tar pages that never call back are given up after this long
    const PAGE_READ_TIMEOUT = 30000;
    // updated_at of a history entry that was never changed here (1 ms after 1970): it is synced,
    // but any copy from another device is newer
    const NEVER_CHANGED = 1;
    // the keep-the-screen-on lock is let go after this long without turning a page or scrolling
    const WAKE_LOCK_IDLE = 10 * 60 * 1000;
    // shown (and opened in the gallery) in place of a page that could not be extracted
    const PAGE_ERROR_SRC = 'data:image/svg+xml,' + encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="600" viewBox="0 0 400 600">'
        + '<rect width="400" height="600" fill="#1a1c20"/>'
        + '<g fill="none" stroke="#6b7280" stroke-width="8" stroke-linecap="round" stroke-linejoin="round">'
        + '<rect x="150" y="190" width="100" height="130" rx="10"/><path d="M178 233l44 44M222 233l-44 44"/></g>'
        + '<text x="200" y="380" fill="#9ca3af" font-family="system-ui, sans-serif" font-size="22" text-anchor="middle">Page could not be read</text>'
        + '</svg>'
    );

    let comicsDirectoryHandle = null;
    let currentView = 'initial';
    let viewBeforeSearch = 'initial';
    let viewBeforeAccount = 'initial';
    let dbPromise = null;
    // sorted file names of the last library folder scan
    let libraryFiles = [];
    // the "storage is full" message is shown once per page load, not on every page turn
    let storageFullNoticeShown = false;

    const settings = loadSettings();
    let lastSavedSettings = JSON.stringify(settings);
    let applyingRemoteSettings = false;
    // a view mode that arrived from sync while reading; applied when the reader closes
    let pendingRemoteMode = null;
    // layout width the strip pages were last sized for (see keepAnchorAfterResize)
    let lastWidth = document.documentElement.clientWidth;
    // smooth scrolling is skipped when the system asks for less motion
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

    // reader state; `token` invalidates async work of a previously opened comic
    const reader = {
        open: false,
        token: 0,
        filename: '',
        source: 'upload',
        // the opened File, cached once it turns out to be a readable comic
        file: null,
        // true when the File is the offline copy itself, so it is not written again
        fromCache: false,
        pages: [],
        // { done, total } while pages are still being extracted
        loading: null,
        urls: [],
        current: 0,
        tracking: false,
        saveTimer: null,
        lastScrollY: 0,
        barHidden: false,
        toastTimer: null,
        toastAction: null,
        scrollRaf: 0,
        resizeRaf: 0,
        // strip mode: the spot under the reading line, { index, ratio of the page height }
        anchor: null,
        // a Close is waiting for history.back() to reach popstate
        closing: false,
        // counts go-to-page requests, so a jump still waiting for its page gives way to a newer one
        jumpRequest: 0,
        // text of the "Loading page N…" toast while a jump waits for its page
        jumpToast: '',
        // where the focus goes back to when Escape closes the go-to-page panel
        pageJumpReturn: null,
        // the page was loaded (reload, discarded tab) on the entry of a comic that is no longer open
        staleEntry: isReaderEntry(),
        wakeLock: null,
        wakeLockPending: false,
        wakeTimer: null,
        // where the focus goes back to when the reader closes (see focusOrigin)
        returnFocus: null
    };

    // small API used by telegram-finder.js and cloud-sync.js. Assigned before any setup code runs
    // (the functions are hoisted), so a later failure in this handler cannot take the API away.
    window.ComicReader = {
        openFile(file, source = 'telegram') {
            openComic(file, { source });
        },
        async hasOfflineCopy(name) {
            try {
                return (await fileStore('readonly', (store) => store.getKey(name))) !== undefined;
            } catch (err) {
                return false;
            }
        },
        openRecent,

        // used by cloud-sync.js
        showAccount: showAccountView,
        getHistory: readHistory,
        applyRemoteHistory,
        replaceHistory: (history) => applyRemoteHistory(history, Object.keys(history)),
        getReaderSettings: storedSettings,
        applyReaderSettings
    };

    // settings from sync or from another tab. They are stored at once (so a reload or another tab
    // sees them); only the view mode of an open comic waits until it is closed
    function applyReaderSettings(remote) {
        if (!remote) return;
        const width = STRIP_WIDTHS.some((w) => w.key === remote.width) ? remote.width : settings.width;
        const mode = remote.mode === 'grid' || remote.mode === 'strip' ? remote.mode : settings.mode;
        if (width === settings.width && mode === (pendingRemoteMode || settings.mode)) return;
        applyingRemoteSettings = true;
        try {
            if (width !== settings.width) {
                // the width keeps the page in place
                const change = () => {
                    settings.width = width;
                    applyWidth();
                };
                if (reader.open) preservePosition(change);
                else change();
            }
            if (reader.open) {
                // never switch the mode under an open comic
                pendingRemoteMode = mode !== settings.mode ? mode : null;
            } else {
                settings.mode = mode;
                pendingRemoteMode = null;
            }
            saveSettings();
        } finally {
            applyingRemoteSettings = false;
        }
    }

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
            if (!comicsDirectoryHandle) {
                showInitialView();
                return;
            }
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
            const hadFocus = document.activeElement === clearRecentBtn;
            // fetch other devices' progress first, so the hidden flags go out on top of it
            await window.CloudSync?.pullNow?.();
            hideFromRecent(null);
            await loadRecentComics();
            // the emptied list is hidden together with this button
            if (hadFocus && !isFocusable(clearRecentBtn)) visibleHeading()?.focus();
        });
    }

    // Telegram search entry points
    [searchTelegramBtn, librarySearchBtn].forEach((btn) => {
        if (!btn) return;
        btn.addEventListener('click', () => {
            viewBeforeSearch = currentView;
            showSearchView();
        });
    });

    if (accountBackBtn) {
        accountBackBtn.addEventListener('click', () => returnFromAccount());
    }

    if (searchBackBtn) {
        searchBackBtn.addEventListener('click', async () => {
            if (viewBeforeSearch === 'library' && comicsDirectoryHandle) {
                await showLibraryMode();
            } else if (viewBeforeSearch === 'quick') {
                showQuickReadMode();
            } else {
                showInitialView();
            }
        });
    }

    loadRecentComics();

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

    function showOnly(viewEl) {
        [initialViewEl, libraryViewEl, quickReadViewEl, searchViewEl, accountViewEl].forEach((el) => {
            if (el) el.style.display = el === viewEl ? 'block' : 'none';
        });
    }

    function showInitialView() {
        currentView = 'initial';
        showOnly(initialViewEl);
    }

    function showAccountView() {
        if (currentView !== 'account') viewBeforeAccount = currentView;
        currentView = 'account';
        showOnly(accountViewEl);
        if (window.CloudSync) window.CloudSync.onShow();
    }

    async function returnFromAccount() {
        if (viewBeforeAccount === 'library' && comicsDirectoryHandle) {
            await showLibraryMode();
        } else if (viewBeforeAccount === 'search') {
            showSearchView();
        } else if (viewBeforeAccount === 'quick') {
            showQuickReadMode();
        } else {
            showInitialView();
        }
    }

    function showSearchView() {
        currentView = 'search';
        showOnly(searchViewEl);
        if (window.TelegramFinder) window.TelegramFinder.onShow();
    }

    function showReconnectButton() {
        // show initial view with modified button text
        showInitialView();

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

        currentView = 'library';
        showOnly(libraryViewEl);

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
        currentView = 'quick';
        showOnly(quickReadViewEl);

        // reset button text in case it was changed
        const titleEl = selectFolderBtn.querySelector('.btn-title');
        const subtitleEl = selectFolderBtn.querySelector('.btn-subtitle');
        if (titleEl && subtitleEl) {
            titleEl.textContent = 'Select Comics Folder';
            subtitleEl.textContent = 'Auto-track progress, browse all comics';
        }

        // back goes to the library when there is one, otherwise to the start screen
        if (backToLibraryBtn) {
            backToLibraryBtn.style.display = 'block';
            backToLibraryBtn.textContent = comicsDirectoryHandle ? 'Back to library' : 'Back';
        }
    }

    // re-show the view the comic was opened from after the reader was closed
    async function showPanel() {
        if (currentView === 'library' && comicsDirectoryHandle) {
            // check permission again when returning
            const permission = await comicsDirectoryHandle.queryPermission({ mode: 'read' });
            if (permission === 'granted') {
                await showLibraryMode();
            } else {
                showReconnectButton();
            }
        } else if (currentView === 'search') {
            showSearchView();
        } else if (currentView === 'account') {
            showAccountView();
        } else if (currentView === 'quick') {
            showQuickReadMode();
        } else {
            showInitialView();
        }
        await loadRecentComics();
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

            comics.sort(pageNameCollator.compare);
            libraryFiles = comics;

            if (comics.length === 0) {
                allComicsListEl.innerHTML = '<div style="text-align: center; color: var(--muted); padding: 20px; font-size: 14px;">No comics found in this folder. Make sure your comics have .cbr, .cbz, or .cbt extension.</div>';
                return;
            }

            renderAllComics();
        } catch (err) {
            console.error('Failed to load all comics:', err);
            libraryFiles = [];

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

    // renders "All Comics" from the last folder scan and the current history, without rescanning
    function renderAllComics() {
        if (libraryFiles.length === 0) return;
        const readingHistory = readHistory();
        allComicsListEl.innerHTML = '';
        for (const filename of libraryFiles) {
            const data = readingHistory[filename];
            const progress = data ? progressInfo(data) : null;
            const item = createComicItem(filename, data, progress?.label, progress?.ratio, () => openComicFromFolder(filename));
            allComicsListEl.appendChild(item);
        }
    }

    // builds a list row; `meta` is optional secondary text, `ratio` (0..1) adds a progress bar.
    // Cover and text form one button that calls `onOpen`; other row buttons are appended next to it
    function createComicItem(filename, data, meta, ratio = null, onOpen = null) {
        const item = document.createElement('div');
        item.className = 'recent-comic-item';
        item.dataset.filename = filename;

        const openBtn = document.createElement('button');
        openBtn.type = 'button';
        openBtn.className = 'recent-comic-open';
        openBtn.setAttribute('aria-label', meta ? `Open ${filename}, ${meta}` : `Open ${filename}`);
        if (onOpen) openBtn.addEventListener('click', onOpen);

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
        if (ratio !== null && ratio !== undefined) {
            const bar = document.createElement('div');
            bar.className = 'comic-progress';
            bar.setAttribute('role', 'progressbar');
            bar.setAttribute('aria-label', 'Reading progress');
            bar.setAttribute('aria-valuemin', '0');
            bar.setAttribute('aria-valuemax', '100');
            bar.setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
            const fill = document.createElement('div');
            fill.className = 'comic-progress-fill' + (ratio >= 1 ? ' done' : '');
            fill.style.width = `${Math.round(ratio * 100)}%`;
            bar.appendChild(fill);
            info.appendChild(bar);
        }

        openBtn.append(icon, info);
        item.appendChild(openBtn);
        return item;
    }

    /* Quick Read: native file input plus drag and drop on the same box */

    if (quickReadInputEl) {
        quickReadInputEl.addEventListener('change', () => {
            const file = quickReadInputEl.files[0];
            // reset so picking the same file again fires 'change' again
            quickReadInputEl.value = '';
            if (file) openQuickFile(file);
        });
    }

    if (dropzoneEl) {
        const onDragOver = (event) => {
            if (!hasDraggedFiles(event)) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = 'copy';
            dropzoneEl.classList.add('dz-drag-hover');
        };
        dropzoneEl.addEventListener('dragenter', onDragOver);
        dropzoneEl.addEventListener('dragover', onDragOver);
        dropzoneEl.addEventListener('dragleave', (event) => {
            // moving between the box and its label also fires dragleave
            if (!dropzoneEl.contains(event.relatedTarget)) dropzoneEl.classList.remove('dz-drag-hover');
        });
        dropzoneEl.addEventListener('drop', (event) => {
            event.preventDefault();
            dropzoneEl.classList.remove('dz-drag-hover');
            const files = [...(event.dataTransfer?.files || [])];
            const file = files.find((f) => COMIC_FILE_PATTERN.test(f.name));
            if (!file) {
                showQuickNotice('Only .cbr, .cbz and .cbt files can be opened.', 'error');
                return;
            }
            openQuickFile(file);
            if (files.length > 1) {
                const others = files.length - 1;
                // shown when the reader is closed again
                showQuickNotice(`Opened "${file.name}". ${others} other ${others === 1 ? 'file was' : 'files were'} ignored: Quick Read opens one comic at a time.`);
            }
        });
    }

    // a file dropped next to the box would make the browser leave the page to show it;
    // dropEffect 'none' shows the no-drop cursor there instead
    ['dragover', 'drop'].forEach((type) => {
        document.addEventListener(type, (event) => {
            if (currentView !== 'quick' || reader.open || !hasDraggedFiles(event)) return;
            if (dropzoneEl && dropzoneEl.contains(event.target)) return;
            event.preventDefault();
            if (type === 'dragover') event.dataTransfer.dropEffect = 'none';
        });
    });

    // only `types` is readable while dragging; the file list itself arrives with 'drop'
    function hasDraggedFiles(event) {
        return Boolean(event.dataTransfer) && Array.prototype.includes.call(event.dataTransfer.types || [], 'Files');
    }

    function openQuickFile(file) {
        openComic(file);
    }

    // `kind` 'error' uses the red notice style
    function showQuickNotice(text, kind = '') {
        if (!reopenNoticeEl) return;
        reopenNoticeEl.textContent = text;
        if (kind) reopenNoticeEl.dataset.kind = kind; else delete reopenNoticeEl.dataset.kind;
        reopenNoticeEl.hidden = false;
    }

    /* ------------------------------------------------------------------
     * Reader
     * ------------------------------------------------------------------ */

    function openComic(file, options = {}) {
        // a comic opened from inside the reader (next issue) keeps the panel's focus origin
        if (!reader.open) reader.returnFocus = focusOrigin();
        resetReaderContent();
        const token = reader.token;

        reader.open = true;
        reader.filename = file.name;
        reader.source = options.source || 'upload';
        reader.file = file;
        reader.fromCache = Boolean(options.fromCache);
        // one history entry (same URL) per reading session, so Back closes the comic;
        // a comic opened from inside the reader, or right after a reload while reading, reuses it
        if (!isReaderEntry()) pushReaderEntry();
        reader.staleEntry = false;
        keepScreenOn();
        document.dispatchEvent(new CustomEvent('comicreader:reader-opened', { detail: { filename: file.name } }));
        if (reopenNoticeEl) reopenNoticeEl.hidden = true;

        document.body.classList.add('reader-open');
        readerBarEl.hidden = false;
        readerProgressEl.hidden = false;
        readerTitleEl.textContent = file.name;
        readerTitleEl.title = file.name;
        applyMode(settings.mode, false);
        showBar();
        // the panel holding the focus is hidden now. The title takes it rather than the Close button,
        // so Space keeps scrolling the comic; Shift+Tab reaches Close, Tab the rest of the toolbar
        readerTitleEl.focus({ preventScroll: true });
        updatePageIndicator();
        updateProgress();
        window.scrollTo(0, 0);
        reader.lastScrollY = 0;

        progressTextElement.textContent = 'Opening archive...';
        sePreConElement.style.display = 'block';

        loadArchive(file, token);
    }

    // every failure (unreadable file, not an archive, no pages) ends in the reader error
    async function loadArchive(file, token) {
        // other devices' newest progress is merged before the resume page is chosen
        // (gives up after a few seconds; at once when signed out or offline)
        const caughtUp = Promise.resolve(window.CloudSync?.pullNow?.()).catch(() => {});
        let archive;
        try {
            const buffer = await file.arrayBuffer();
            if (token !== reader.token) return;
            archive = archiveOpenArrayBuffer(file.name, buffer);
        } catch (err) {
            if (token === reader.token) showReaderError(err);
            return;
        }
        await caughtUp;
        if (token !== reader.token) {
            archiveClose(archive);
            return;
        }
        try {
            await renderArchive(archive, token);
        } catch (err) {
            if (token === reader.token) showReaderError(err);
        }
    }

    async function renderArchive(archive, token) {
        try {
            const entries = archive.entries
                .filter(isPageEntry)
                .sort((a, b) => pageNameCollator.compare(a.name, b.name));

            if (entries.length === 0) {
                throw new Error('No images found in this archive.');
            }

            if (reader.file && reader.source !== 'folder' && !reader.fromCache) {
                // library files can be reopened from the folder; everything else gets a local copy.
                // A comic opened from its offline copy is not written again: pruning orders copies by
                // the reading history, so the copy needs no fresh lastOpened
                cacheComicFile(reader.file, reader.source);
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
                a.tabIndex = pageTabIndex(settings.mode);

                const img = document.createElement('img');
                img.className = 'imgUrl';
                img.alt = `Page ${i + 1}`;
                img.decoding = 'async';
                img.draggable = false;
                // bytes that are not a decodable image (e.g. a damaged stored entry) get the same placeholder
                img.addEventListener('error', () => markPageError(a, i));

                a.appendChild(img);
                fragment.appendChild(a);
                return a;
            });
            outputElement.appendChild(fragment);
            outputElement.appendChild(createStripEnd());
            reader.loading = { done: 0, total: entries.length };
            updatePageIndicator();

            let revealed = false;
            for (let i = 0; i < entries.length; i++) {
                if (!revealed) progressTextElement.textContent = `Reading ${i + 1}/${entries.length} pages`;
                const data = await readEntryData(entries[i], archive);
                if (token !== reader.token) return;

                const page = reader.pages[i];
                if (data) {
                    const url = URL.createObjectURL(new Blob([data], { type: getMIME(entries[i].name) }));
                    reader.urls.push(url);
                    page.href = url;
                    page.firstChild.src = url;
                } else {
                    markPageError(page, i);
                }
                reader.loading.done = i + 1;
                updatePageIndicator();

                // show the comic once every page up to the resume page is there; the target is
                // read again each time so a sync pull that lands meanwhile is honoured
                if (!revealed && i >= Math.min(getLastPageRead(reader.filename), entries.length - 1)) {
                    revealed = true;
                    revealComic(token);
                }
            }

            reader.loading = null;
            updatePageIndicator();
        } finally {
            archiveClose(archive);
        }
    }

    // the placeholder is also the gallery item, so gallery indices stay equal to page indices
    function markPageError(page, index) {
        if (page.classList.contains('page-error')) return;
        page.classList.add('page-error');
        page.href = PAGE_ERROR_SRC;
        page.firstChild.src = PAGE_ERROR_SRC;
        page.firstChild.alt = `Page ${index + 1} could not be read`;
    }

    // hides the overlay and jumps to the saved page while the remaining pages keep loading
    function revealComic(token) {
        sePreConElement.style.display = 'none';
        generateThumbnail(token);
        restorePosition(token).then(() => {
            if (token !== reader.token) return;
            // records the page count so "Recently Read" can show a percentage right away;
            // the restored page is not a new change, so it never outranks another device's progress
            saveLastPageRead(reader.filename, reader.current, { restore: true });
            // a sync pull that landed while the position was restored: offer its page
            offerRemotePage(readHistory()[reader.filename]);
        }).catch((err) => console.warn('Could not restore the reading position:', err));
    }

    // always settles: zip pages are read synchronously, other formats race a watchdog
    async function readEntryData(entry, archive) {
        if (archive.archive_type === 'zip') {
            let data = null;
            try {
                // JSZip inflates here and throws on corrupt data
                data = archive.handle.zip.files[entry.name].asArrayBuffer();
            } catch (e) {
                console.warn('Failed to read', entry.name, e);
            }
            // let the page (and the progress) render before the next one is inflated
            await new Promise((resolve) => setTimeout(resolve, 0));
            return data && data.byteLength ? data : null;
        }

        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                console.warn('Gave up reading', entry.name, `after ${PAGE_READ_TIMEOUT / 1000} s`);
                resolve(null);
            }, PAGE_READ_TIMEOUT);
            const finish = (data) => {
                clearTimeout(timer);
                resolve(data && data.byteLength ? data : null);
            };
            try {
                entry.readData((data, err) => {
                    if (err) console.warn('Failed to read', entry.name, err);
                    finish(data);
                });
            } catch (e) {
                console.warn('Failed to read', entry.name, e);
                finish(null);
            }
        });
    }

    function isPageEntry(entry) {
        if (entry.is_file === false) return false;
        // empty entries are never a page, and libunrar never calls back for them
        if (entry.size_uncompressed === 0) return false;
        const parts = entry.name.split(/[\\/]/);
        if (parts.includes('__MACOSX')) return false;
        const base = parts[parts.length - 1];
        if (!base || base.startsWith('.')) return false;
        return IMAGE_EXTENSIONS.has(getExt(base).toLowerCase());
    }

    // shown after the last page in both view modes; a comic from the library folder offers the next file
    function createStripEnd() {
        const end = document.createElement('div');
        end.className = 'strip-end';
        end.innerHTML = '<div class="strip-end-title">End of comic</div>';

        const next = libraryNeighbour(1);
        if (next) {
            const nextBtn = document.createElement('button');
            nextBtn.type = 'button';
            nextBtn.className = 'folder-btn folder-btn-primary strip-end-btn strip-end-next';
            nextBtn.title = 'Next comic in the folder (])';
            const text = document.createElement('div');
            const title = document.createElement('div');
            title.className = 'btn-title';
            title.textContent = `Next: ${next}`;
            text.appendChild(title);
            const data = readHistory()[next];
            if (data) {
                const meta = document.createElement('div');
                meta.className = 'btn-subtitle';
                meta.textContent = progressInfo(data).label;
                text.appendChild(meta);
            }
            nextBtn.appendChild(text);
            nextBtn.addEventListener('click', () => openComicFromFolder(next));
            end.appendChild(nextBtn);
        }

        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.className = next ? 'link-btn strip-end-back' : 'folder-btn folder-btn-primary strip-end-btn';
        closeBtn.textContent = currentView === 'library' ? 'Back to library' : 'Close';
        closeBtn.addEventListener('click', requestClose);
        end.appendChild(closeBtn);
        return end;
    }

    // the file before (-1) or after (1) the open comic in the last library folder scan, when it was opened from there
    function libraryNeighbour(step) {
        if (!reader.open || reader.source !== 'folder' || !comicsDirectoryHandle) return null;
        const index = libraryFiles.indexOf(reader.filename);
        if (index === -1) return null;
        return libraryFiles[index + step] || null;
    }

    // '[' and ']': the previous or next comic of the library folder
    function openNeighbourComic(step) {
        if (reader.source !== 'folder') return;
        const name = libraryNeighbour(step);
        if (name) {
            openComicFromFolder(name);
        } else if (comicsDirectoryHandle && libraryFiles.includes(reader.filename)) {
            showToast(step > 0 ? 'This is the last comic in the folder' : 'This is the first comic in the folder', false);
        }
    }

    function showReaderError(err) {
        sePreConElement.style.display = 'none';
        outputElement.innerHTML = '';
        reader.pages = [];
        reader.loading = null;
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
        reader.loading = null;
        reader.file = null;
        reader.fromCache = false;
        reader.current = 0;
        reader.tracking = false;
        reader.anchor = null;
        reader.closing = false;
        closePageJump();
        outputElement.innerHTML = '';
        hideToast();
        reader.jumpToast = '';
    }

    // closes through the reader's history entry when there is one, so Back afterwards leaves the site
    // instead of landing on a dead entry; popstate does the actual closing
    function requestClose() {
        if (!reader.open || reader.closing) return;
        if (!isReaderEntry()) {
            closeReader();
            return;
        }
        // a second Close before popstate would go back one entry too far
        reader.closing = true;
        const token = reader.token;
        window.history.back();
        setTimeout(() => {
            if (reader.closing && token === reader.token) closeReader();
        }, 1000);
    }

    function isReaderEntry() {
        return Boolean(window.history.state && window.history.state.reader);
    }

    function pushReaderEntry() {
        try {
            window.history.pushState({ reader: true }, '');
        } catch (err) {
            // Safari throws after too many calls in a short time; the reader works without the entry
            console.warn('Could not add a history entry for the reader:', err);
        }
    }

    async function closeReader() {
        if (!reader.open) return;
        const closedName = reader.filename;
        const origin = reader.returnFocus;
        reader.returnFocus = null;
        resetReaderContent();
        releaseWakeLock();
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
        if (pendingRemoteMode) {
            applyingRemoteSettings = true;
            try {
                settings.mode = pendingRemoteMode;
                saveSettings();
            } finally {
                applyingRemoteSettings = false;
                pendingRemoteMode = null;
            }
        }
        await showPanel();
        // not when another comic was opened while the panel was being rebuilt
        if (!reader.open) restoreFocus(closedName, origin);
        document.dispatchEvent(new CustomEvent('comicreader:reader-closed'));
    }

    // what had the focus when a comic was opened from the panel. The lists are rebuilt while reading,
    // so a list row is remembered by its list and found again by file name; other controls by reference
    function focusOrigin() {
        const active = document.activeElement;
        if (!active || active === document.body || !active.closest) return null;
        const row = active.closest('.recent-comic-item');
        if (row) return { listId: row.parentElement ? row.parentElement.id : '' };
        return { element: active };
    }

    // after the reader closed: the row of the comic just read (in the list it was opened from), else the
    // control that opened it, else the heading of the visible view
    function restoreFocus(filename, origin) {
        let target = null;
        if (origin && 'listId' in origin) {
            const list = origin.listId ? document.getElementById(origin.listId) : null;
            target = findRowButton(list, filename) || findRowButton(document, filename);
        } else if (origin) {
            target = origin.element;
        }
        if (!isFocusable(target)) target = visibleHeading();
        if (target) target.focus();
    }

    function findRowButton(root, filename) {
        if (!root || !filename) return null;
        const row = [...root.querySelectorAll('.recent-comic-item')].find((el) => el.dataset.filename === filename);
        return row ? row.querySelector('.recent-comic-open') : null;
    }

    // the views' h1s have tabindex=-1, so they can hold the focus when nothing better is left
    function visibleHeading() {
        return [...document.querySelectorAll('.wrap h1')].find(isFocusable) || null;
    }

    function isFocusable(el) {
        return Boolean(el) && el.isConnected && !el.disabled && el.getClientRects().length > 0;
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
                        reader.pages[lastPage].scrollIntoView({ behavior: reduceMotion.matches ? 'auto' : 'smooth', block: 'center' });
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

        const probe = readingLine();
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

    function readingLine() {
        return window.innerHeight * 0.4;
    }

    // where the reading line crosses page `index`, as a share of that page's height
    function readingAnchor(index) {
        const rect = reader.pages[index].getBoundingClientRect();
        return { index, ratio: rect.height ? (readingLine() - rect.top) / rect.height : 0 };
    }

    // scrolls so that the anchored spot of its page is on the reading line again
    function scrollToAnchor(anchor) {
        const page = reader.pages[anchor.index];
        if (!page) return;
        const rect = page.getBoundingClientRect();
        window.scrollTo(0, window.scrollY + rect.top + anchor.ratio * rect.height - readingLine());
    }

    // keeps the reading position stable across layout changes (e.g. page width)
    function preservePosition(change) {
        if (settings.mode !== 'strip' || reader.pages.length === 0) {
            change();
            return;
        }
        const anchor = readingAnchor(pageAtViewport());
        change();
        scrollToAnchor(anchor);
    }

    // strip pages are sized from the layout width, so rotating, resizing or fullscreen moves the content
    // under scrollY; this puts the spot being read back on the reading line before a scroll can save
    // the wrong page. Height-only changes (a mobile URL bar showing or hiding) are left alone
    // unless `force` is set
    function keepAnchorAfterResize(force = false) {
        const width = document.documentElement.clientWidth;
        const changed = width !== lastWidth;
        lastWidth = width;
        if (!(changed || force) || !reader.open || !reader.tracking || settings.mode !== 'strip') return;
        if (!reader.anchor || !reader.pages[reader.anchor.index]) return;
        scrollToAnchor(reader.anchor);
        // a programmatic jump, not reading on: the toolbar stays as it is
        reader.lastScrollY = window.scrollY;
    }

    function setCurrentPage(index) {
        if (index === reader.current) return;
        reader.current = index;
        // a "read on another device" offer is moot once the reader moves on
        if (reader.toastAction) hideToast();
        updatePageIndicator();
        scheduleSave();
        keepScreenOn();
    }

    /* screen wake lock: the screen stays on while reading, until WAKE_LOCK_IDLE passes without
       a page change or scrolling; the next one takes the lock again */

    function keepScreenOn() {
        if (!reader.open) return;
        clearTimeout(reader.wakeTimer);
        reader.wakeTimer = setTimeout(releaseWakeLock, WAKE_LOCK_IDLE);
        requestWakeLock();
    }

    async function requestWakeLock() {
        if (!('wakeLock' in navigator) || !reader.open || document.visibilityState !== 'visible') return;
        if (reader.wakeLock || reader.wakeLockPending) return;
        reader.wakeLockPending = true;
        try {
            const lock = await navigator.wakeLock.request('screen');
            // closed or idle while the request was pending
            if (!reader.open || !reader.wakeTimer) {
                lock.release().catch(() => {});
                return;
            }
            reader.wakeLock = lock;
            // the browser lets go of it when the tab is hidden
            lock.addEventListener('release', () => {
                if (reader.wakeLock === lock) reader.wakeLock = null;
            });
        } catch (err) {
            // refused (e.g. battery saver); the screen then follows the system timeout
        } finally {
            reader.wakeLockPending = false;
        }
    }

    function releaseWakeLock() {
        clearTimeout(reader.wakeTimer);
        reader.wakeTimer = null;
        const lock = reader.wakeLock;
        reader.wakeLock = null;
        if (lock) lock.release().catch(() => {});
    }

    function updatePageIndicator() {
        const total = reader.pages.length;
        const loading = reader.loading && reader.loading.done < reader.loading.total
            ? ` · loading ${Math.floor((reader.loading.done / reader.loading.total) * 100)}%`
            : '';
        readerPageEl.textContent = `${total ? reader.current + 1 : 0} / ${total}${loading}`;
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
        // recorded again by the next strip scroll
        reader.anchor = null;
        if (mode === 'strip') destroyGallery();

        settings.mode = mode;
        saveSettings();

        outputElement.classList.toggle('mode-strip', mode === 'strip');
        outputElement.classList.toggle('mode-grid', mode === 'grid');
        reader.pages.forEach((page) => { page.tabIndex = pageTabIndex(mode); });
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

    // grid thumbnails are tab stops (each opens the gallery); strip pages are not, so Tab goes from the
    // toolbar straight to the end of the comic instead of through every page
    function pageTabIndex(mode) {
        return mode === 'strip' ? -1 : 0;
    }

    function toggleMode() {
        pendingRemoteMode = null;
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
        // the go-to-page panel hangs below the toolbar, so the toolbar stays while it is open
        if (settings.mode !== 'strip' || !pageJumpEl.hidden) return;
        reader.barHidden = true;
        readerBarEl.classList.add('rb-hidden');
    }

    // `action` = { label, run } replaces the default "Start over" button, false shows no button
    function showToast(text, action = null) {
        resumeToastTextEl.textContent = text;
        resumeStartOverBtn.hidden = action === false;
        resumeStartOverBtn.textContent = action ? action.label : 'Start over';
        reader.toastAction = action || null;
        resumeToastEl.hidden = false;
        clearTimeout(reader.toastTimer);
        reader.toastTimer = setTimeout(hideToast, 6000);
    }

    function hideToast() {
        clearTimeout(reader.toastTimer);
        reader.toastAction = null;
        resumeToastEl.hidden = true;
    }

    // a far jump (go-to-page panel, "Go to page N" from sync). In strip mode it waits, like restorePosition,
    // until every page up to the target is extracted and has its real height, so it lands on the right page
    async function jumpToPage(index) {
        if (!reader.pages[index]) return;
        const token = reader.token;
        const request = ++reader.jumpRequest;
        // a newer jump replaces an older one still waiting, and its toast
        clearJumpToast();
        showBar();
        if (settings.mode !== 'strip') {
            markLastRead(index);
            reader.pages[index].scrollIntoView({ block: 'center' });
            setCurrentPage(index);
            updateProgress();
            return;
        }

        if (reader.loading && reader.loading.done <= index) {
            // stays until the page is there (no timeout), so the jump never comes unannounced;
            // Cancel drops it and the reader stays where it is
            reader.jumpToast = `Loading page ${index + 1}…`;
            showToast(reader.jumpToast, {
                label: 'Cancel',
                run: () => {
                    if (request === reader.jumpRequest) reader.jumpRequest++;
                }
            });
            clearTimeout(reader.toastTimer);
            await waitForExtraction(index, token);
        }
        await waitForImages(reader.pages.slice(0, index + 1));
        // a newer jump or Cancel has dealt with the toast already
        if (request === reader.jumpRequest) clearJumpToast();
        // closed, switched to another comic or mode, or a newer jump was asked for meanwhile
        if (token !== reader.token || request !== reader.jumpRequest || settings.mode !== 'strip') return;
        goToPage(index);
        // a jump, not reading on: the toolbar stays as it is
        reader.lastScrollY = window.scrollY;
        setCurrentPage(index);
        updateProgress();
    }

    // hides the "Loading page N…" toast unless another message has replaced it meanwhile
    function clearJumpToast() {
        if (reader.jumpToast && !resumeToastEl.hidden && resumeToastTextEl.textContent === reader.jumpToast) hideToast();
        reader.jumpToast = '';
    }

    // resolves once page `index` is extracted, or when the comic is closed or switched
    function waitForExtraction(index, token) {
        return new Promise((resolve) => {
            const check = () => {
                if (token !== reader.token || !reader.loading || reader.loading.done > index) {
                    resolve();
                } else {
                    setTimeout(check, 100);
                }
            };
            check();
        });
    }

    /* go-to-page panel: opened from the page counter or with G */

    function togglePageJump() {
        if (pageJumpEl.hidden) openPageJump(); else closePageJump(true);
    }

    function openPageJump() {
        // not before the resume jump has settled, which would move the page again
        if (!reader.open || !reader.tracking || reader.pages.length === 0) return;
        const total = reader.pages.length;
        const value = String(reader.current + 1);
        [pageJumpRangeEl, pageJumpNumberEl].forEach((input) => {
            input.max = String(total);
            input.value = value;
        });
        pageJumpTotalEl.textContent = `of ${total}`;
        pageJumpEl.hidden = false;
        readerPageEl.setAttribute('aria-expanded', 'true');
        showBar();
        // the page counter when it was clicked, the title (or nothing) when G was pressed
        reader.pageJumpReturn = document.activeElement;
        pageJumpNumberEl.focus();
        pageJumpNumberEl.select();
    }

    // `returnFocus` (Escape, or the counter clicked again) puts the focus back where it was before the panel
    // opened: the counter when it was clicked, otherwise the title, so Space scrolls the comic and does not
    // press the counter again. Otherwise the focus just leaves the panel, so Space and the arrow keys scroll
    function closePageJump(returnFocus = false) {
        if (pageJumpEl.hidden) return;
        const active = document.activeElement;
        if (!returnFocus && active && pageJumpEl.contains(active)) active.blur();
        pageJumpEl.hidden = true;
        readerPageEl.setAttribute('aria-expanded', 'false');
        const back = reader.pageJumpReturn;
        reader.pageJumpReturn = null;
        if (!returnFocus) return;
        const usable = back && back !== document.body && document.contains(back) && !pageJumpEl.contains(back)
            && back.getClientRects().length > 0;
        (usable ? back : readerTitleEl).focus({ preventScroll: true });
    }

    // `input` is the field whose value is used (the range when Enter was pressed on it)
    function jumpFromPanel(input = pageJumpNumberEl) {
        const total = reader.pages.length;
        const number = parseInt(input.value, 10);
        if (!total || !Number.isFinite(number)) {
            pageJumpNumberEl.focus();
            pageJumpNumberEl.select();
            return;
        }
        closePageJump();
        jumpToPage(Math.max(1, Math.min(number, total)) - 1);
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

        if (!page) return;
        if (reader.loading) {
            // the gallery reads its items once, so it waits until every page is there
            event.preventDefault();
            showToast('Pages are still loading…', false);
            return;
        }
        if (!page.getAttribute('href')) return;
        if (!outputElement.getAttribute('lg-uid')) {
            // init the gallery on first click, then replay the click so it opens on this page.
            // dispatchEvent instead of click(): click() is ignored while this element's click is in progress
            event.preventDefault();
            if (!window.lightGallery) return;
            initGallery();
            page.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        }
    });

    /* reader events */

    readerCloseBtn.addEventListener('click', requestClose);
    // Tab into the auto-hidden toolbar slides it back in, so the focused button is never off-screen
    readerBarEl.addEventListener('focusin', showBar);
    // the loading overlay covers the reader bar, so it has its own way out
    if (loadingCancelBtn) loadingCancelBtn.addEventListener('click', requestClose);

    readerPageEl.addEventListener('click', togglePageJump);
    pageJumpGoBtn.addEventListener('click', () => jumpFromPanel());
    // the slider and the number field show the same page
    pageJumpRangeEl.addEventListener('input', () => {
        pageJumpNumberEl.value = pageJumpRangeEl.value;
    });
    pageJumpNumberEl.addEventListener('input', () => {
        const number = parseInt(pageJumpNumberEl.value, 10);
        if (Number.isFinite(number)) pageJumpRangeEl.value = String(number);
    });
    pageJumpEl.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' || (event.target !== pageJumpNumberEl && event.target !== pageJumpRangeEl)) return;
        event.preventDefault();
        jumpFromPanel(event.target);
    });
    // a click anywhere else closes the panel; it bubbles here after the strip's tap handler,
    // so that tap leaves the toolbar alone (hideBar does nothing while the panel is open)
    document.addEventListener('click', (event) => {
        if (pageJumpEl.hidden || pageJumpEl.contains(event.target) || readerPageEl.contains(event.target)) return;
        closePageJump();
    });

    // browser or phone Back while reading: closes the enlarged gallery page first, then the comic.
    // After a reload while reading, the entry still says `reader`: openComic reuses it, and if no comic is
    // opened, the first Back (which only steps down to this page's own entry below it) goes back once more,
    // so one Back leaves the site as it did before the reader had history entries
    window.addEventListener('popstate', () => {
        const leftStaleEntry = reader.staleEntry;
        reader.staleEntry = false;
        if (leftStaleEntry && !reader.open && !isReaderEntry()) {
            window.history.back();
            return;
        }
        if (document.body.classList.contains('lg-on')) {
            const galleryCloseBtn = document.querySelector('.lg-close');
            if (galleryCloseBtn) galleryCloseBtn.click();
            // that Back used up the reader's entry; the next one closes the comic
            if (reader.open) pushReaderEntry();
            return;
        }
        if (reader.open) closeReader();
    });
    readerWidthBtn.addEventListener('click', () => cycleWidth(1));
    readerFullscreenBtn.addEventListener('click', toggleFullscreen);
    modeButtons.forEach((btn) => {
        btn.addEventListener('click', () => {
            // the mode shown is kept: a mode from another device still applies when the comic closes
            if (btn.dataset.mode === settings.mode) return;
            pendingRemoteMode = null;
            applyMode(btn.dataset.mode);
        });
    });
    resumeStartOverBtn.addEventListener('click', () => {
        const action = reader.toastAction;
        hideToast();
        if (action) {
            action.run();
            return;
        }
        if (settings.mode === 'strip') {
            window.scrollTo({ top: 0, behavior: 'auto' });
        } else {
            markLastRead(0);
            setCurrentPage(0);
            window.scrollTo({ top: 0, behavior: reduceMotion.matches ? 'auto' : 'smooth' });
        }
        showBar();
    });

    document.addEventListener('fullscreenchange', () => {
        readerFullscreenBtn.classList.toggle('active', Boolean(document.fullscreenElement));
        // the viewport may change only in height here, so the anchor is restored either way
        requestAnimationFrame(() => keepAnchorAfterResize(true));
    });

    // write the pending page before the tab is hidden or closed (registered before cloud-sync.js pushes);
    // the screen lock is dropped by the browser while hidden and taken again on return
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
            flushSave();
        } else if (reader.open) {
            keepScreenOn();
        }
    });
    window.addEventListener('pagehide', flushSave);

    // another tab changed the history (or pulled it from sync)
    window.addEventListener('storage', (event) => {
        if (event.key === SETTINGS_KEY) {
            // another tab changed the reader settings (or took them from sync); not sent again from here
            applyReaderSettings(loadSettings());
            return;
        }
        if (event.key !== HISTORY_KEY || reader.open) return;
        loadRecentComics();
        if (currentView === 'library') renderAllComics();
    });

    window.addEventListener('scroll', () => {
        if (!reader.open || reader.scrollRaf) return;
        reader.scrollRaf = requestAnimationFrame(onReaderScroll);
    }, { passive: true });

    // once per frame
    window.addEventListener('resize', () => {
        if (reader.resizeRaf) return;
        reader.resizeRaf = requestAnimationFrame(() => {
            reader.resizeRaf = 0;
            keepAnchorAfterResize();
            if (reader.open) updateProgress();
        });
    });

    function onReaderScroll() {
        reader.scrollRaf = 0;
        // the scroll a width change causes can arrive before the resize frame; put the old spot back first
        if (document.documentElement.clientWidth !== lastWidth) keepAnchorAfterResize();
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
            if (reader.pages.length) {
                const index = pageAtViewport();
                setCurrentPage(index);
                if (reader.tracking) reader.anchor = readingAnchor(index);
            }
        }
        updateProgress();
        // scrolling within one tall page counts as reading too
        keepScreenOn();
    }

    // reveal the toolbar when the pointer reaches the top edge
    document.addEventListener('mousemove', (event) => {
        if (reader.open && reader.barHidden && event.clientY < 56) showBar();
    }, { passive: true });

    document.addEventListener('keydown', (event) => {
        if (!reader.open || document.body.classList.contains('lg-on')) return;
        // Escape closes the go-to-page panel (also from its fields) before it would close the comic
        if (event.key === 'Escape' && !pageJumpEl.hidden) {
            event.preventDefault();
            closePageJump(true);
            return;
        }
        if (event.target.closest && event.target.closest('input, textarea, select, [contenteditable="true"]')) return;

        // [ and ] need AltGr or Option on many layouts (German, French, Mac), so only Ctrl or Cmd
        // shortcuts are left to the browser here
        if (event.key === '[' || event.key === ']') {
            const altGr = event.getModifierState('AltGraph') || (event.ctrlKey && event.altKey);
            if (event.metaKey || (event.ctrlKey && !altGr) || reader.source !== 'folder') return;
            event.preventDefault();
            // holding the key down would open one comic after the other
            if (!event.repeat) openNeighbourComic(event.key === ']' ? 1 : -1);
            return;
        }
        if (event.altKey || event.ctrlKey || event.metaKey) return;

        const strip = settings.mode === 'strip';
        switch (event.key) {
            case 'g':
            case 'G':
                // keeps the key from being typed into the number field that gets the focus
                event.preventDefault();
                togglePageJump();
                break;
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
                if (!document.fullscreenElement) requestClose();
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

    // what is stored and synced: a mode that waits for the open comic to close counts already, so a
    // width change while reading does not send the old mode back
    function storedSettings() {
        return { mode: pendingRemoteMode || settings.mode, width: settings.width };
    }

    function saveSettings() {
        const json = JSON.stringify(storedSettings());
        try {
            localStorage.setItem(SETTINGS_KEY, json);
        } catch (e) {
            // storage unavailable (private mode etc.) - settings stay in memory
        }
        if (json !== lastSavedSettings) {
            lastSavedSettings = json;
            if (!applyingRemoteSettings) document.dispatchEvent(new CustomEvent('comicreader:settings-changed'));
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

    // notify=false is used when the change came from sync (or changed nothing), so it is not sent back;
    // `names` lists the changed entries
    function writeHistory(history, notify = true, names = null) {
        const err = storeHistory(history);
        if (err) {
            console.error('Failed to save reading history:', err);
            if (isQuotaError(err)) showStorageFullNotice();
        }
        if (notify) document.dispatchEvent(new CustomEvent('comicreader:history-changed', { detail: { names } }));
    }

    // returns null once stored, otherwise the error. When the quota is full, thumbnails that
    // "Recently Read" does not show are dropped for good and the write is tried once more
    function storeHistory(history) {
        try {
            localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
            return null;
        } catch (e) {
            const slim = isQuotaError(e) ? withoutOldThumbnails(history) : null;
            if (!slim) return e;
            try {
                localStorage.setItem(HISTORY_KEY, JSON.stringify(slim));
                return null;
            } catch (retryError) {
                return retryError;
            }
        }
    }

    // a copy without the thumbnails of hidden entries and of all but the RECENT_LIMIT most recent ones
    // (the open comic keeps its own); null when there is nothing to drop
    function withoutOldThumbnails(history) {
        const keep = new Set(Object.entries(history)
            .filter(([, data]) => data && !data.hidden_from_recent)
            .sort((a, b) => (b[1].timestamp || 0) - (a[1].timestamp || 0))
            .slice(0, RECENT_LIMIT)
            .map(([name]) => name));
        if (reader.open) keep.add(reader.filename);

        let dropped = false;
        const slim = {};
        Object.entries(history).forEach(([name, data]) => {
            if (data && data.thumbnail && !keep.has(name)) {
                const rest = { ...data };
                delete rest.thumbnail;
                slim[name] = rest;
                dropped = true;
            } else {
                slim[name] = data;
            }
        });
        return dropped ? slim : null;
    }

    // localStorage and IndexedDB report a full quota under different names and codes per browser
    function isQuotaError(err) {
        return Boolean(err) && (err.name === 'QuotaExceededError'
            || err.name === 'NS_ERROR_DOM_QUOTA_REACHED'
            || err.code === 22
            || err.code === 1014);
    }

    function showStorageFullNotice() {
        if (storageFullNoticeShown) return;
        storageFullNoticeShown = true;
        // deferred: the save that runs while a comic is closed or switched comes right before the toast is cleared
        setTimeout(() => {
            const text = 'Browser storage is full; reading progress could not be saved.';
            // #reopenNotice is only visible in Quick Read, the toast on every view
            if (!reader.open && currentView === 'quick') {
                showQuickNotice(text, 'error');
            } else {
                showToast(text, false);
            }
        }, 0);
    }

    function generateThumbnail(token) {
        const page = reader.pages[0];
        const img = page?.firstChild;
        if (!img || !img.src || page.classList.contains('page-error')) return;

        const run = () => {
            if (token !== reader.token || !img.naturalWidth || page.classList.contains('page-error')) return;
            try {
                // at most 100x150: a tall page (webtoon) is cropped from the top instead of squeezed
                const srcHeight = Math.min(img.naturalHeight, img.naturalWidth * THUMB_MAX_HEIGHT / THUMB_WIDTH);
                const canvas = document.createElement('canvas');
                canvas.width = THUMB_WIDTH;
                canvas.height = Math.max(1, Math.round(srcHeight * THUMB_WIDTH / img.naturalWidth));
                canvas.getContext('2d').drawImage(img, 0, 0, img.naturalWidth, srcHeight, 0, 0, canvas.width, canvas.height);
                setThumbnail(reader.filename, canvas.toDataURL('image/jpeg', 0.7));
            } catch (e) {
                console.error('Failed to create thumbnail:', e);
            }
        };
        const create = () => {
            if (img.complete && img.naturalWidth) {
                run();
            } else {
                img.addEventListener('load', run, { once: true });
            }
        };

        const existing = readHistory()[reader.filename]?.thumbnail;
        if (!existing) {
            create();
            return;
        }
        // the stored thumbnail is kept; only one made before the height limit (or a broken one) is replaced
        const stored = new Image();
        stored.onload = () => {
            if (stored.naturalHeight > THUMB_MAX_HEIGHT && token === reader.token) create();
        };
        stored.onerror = () => {
            if (token === reader.token) create();
        };
        stored.src = existing;
    }

    /*
     * Reading history: localStorage, one entry per file name
     *   { last_page, total_pages, source, timestamp, updated_at, thumbnail, hidden_from_recent }
     * timestamp = last read (list order), updated_at = last change (sync merge).
     * Kept behind readHistory/writeHistory/saveLastPageRead so a synced store can replace it later.
     */
    // `restore`: the save right after the reader restored the position. That is not a change: the
    // stored page stays (a sync pull may have moved it meanwhile) and so does updated_at, so opening
    // a comic never outranks newer progress from another device
    function saveLastPageRead(filename, pageIndex, { restore = false } = {}) {
        const readingHistory = readHistory();
        const known = readingHistory[filename];
        const existing = known || {};
        const isOpen = reader.open && filename === reader.filename;
        const newTotal = (isOpen && reader.pages.length) ? reader.pages.length : null;
        const source = isOpen ? reader.source : (existing.source || null);
        const totalChanged = Boolean(newTotal && existing.total_pages !== newTotal);
        const hidden = Boolean(existing.hidden_from_recent);
        const now = Date.now();
        // entries from before updated_at existed use their last read time
        const previous = existing.updated_at || existing.timestamp || 0;
        if (restore && known) pageIndex = existing.last_page || 0;

        let changed;
        let updatedAt;
        if (restore && !hidden) {
            updatedAt = previous || NEVER_CHANGED;
            // a comic opened here for the first time is sent too, with the oldest possible updated_at
            changed = updatedAt === NEVER_CHANGED && (!known || totalChanged);
        } else {
            // only a real change gets a new updated_at; it always sorts after the version it was
            // made on (the newest one merged from the server), whatever the device clocks say
            changed = !existing.updated_at || existing.last_page !== pageIndex || hidden || totalChanged;
            updatedAt = changed ? Math.max(now, previous + 1) : existing.updated_at;
        }

        // reading a comic again brings it back into "Recently Read" (no hidden flag)
        const entry = {
            ...existing,
            last_page: pageIndex,
            total_pages: newTotal || existing.total_pages || null,
            source,
            timestamp: now,
            updated_at: updatedAt,
            thumbnail: existing.thumbnail || null
        };
        delete entry.hidden_from_recent;
        readingHistory[filename] = entry;
        writeHistory(readingHistory, changed, [filename]);
    }

    // thumbnails stay on this device, so storing one is not a change to sync
    function setThumbnail(filename, dataUrl) {
        const readingHistory = readHistory();
        const existing = readingHistory[filename];
        readingHistory[filename] = existing
            ? { ...existing, thumbnail: dataUrl }
            : { last_page: 0, total_pages: null, source: null, timestamp: Date.now(), updated_at: NEVER_CHANGED, thumbnail: dataUrl };
        // a thumbnail that does not fit only loses itself (progress is untouched), so no "storage full" message
        const err = storeHistory(readingHistory);
        if (err) console.warn('Could not store the thumbnail:', err);
    }

    function progressInfo(data) {
        const page = (data.last_page || 0) + 1;
        const total = data.total_pages || 0;
        if (!total) return { label: `Page ${page}`, ratio: null };
        if (page >= total) return { label: `Finished · ${total} pages`, ratio: 1 };
        const ratio = page / total;
        return { label: `Page ${page} of ${total} · ${Math.round(ratio * 100)}%`, ratio };
    }

    function getLastPageRead(filename) {
        return readHistory()[filename]?.last_page || 0;
    }

    // hides one comic (or all when filename is null) from "Recently Read" without losing progress
    function hideFromRecent(filename) {
        const readingHistory = readHistory();
        const names = filename === null ? Object.keys(readingHistory) : [filename];
        const changed = names.filter((name) => readingHistory[name] && !readingHistory[name].hidden_from_recent);
        changed.forEach((name) => {
            const entry = readingHistory[name];
            entry.hidden_from_recent = true;
            // after the version it was made on, like a page change (see saveLastPageRead)
            entry.updated_at = Math.max(Date.now(), (entry.updated_at || entry.timestamp || 0) + 1);
        });
        if (changed.length) writeHistory(readingHistory, true, changed);
        // the list entry is gone, so its offline copy is no longer needed
        deleteCachedComics(names);
    }

    // IndexedDB: 'directories' holds the library folder handle, 'files' the offline copies of opened comics
    function openDB() {
        if (!dbPromise) {
            const opening = new Promise((resolve, reject) => {
                let blocked = false;
                const request = indexedDB.open('ComicReaderDB', 2);
                request.onerror = () => reject(request.error);
                // a tab running an older version of the reader holds the database open and never lets go
                request.onblocked = () => {
                    blocked = true;
                    reject(new Error('Close other tabs of this reader and reload.'));
                };
                request.onsuccess = () => {
                    const db = request.result;
                    // the caller already got the error; the next openDB() opens a fresh connection
                    if (blocked) {
                        db.close();
                        return;
                    }
                    // a newer version opened in another tab: let it upgrade, the next openDB() reconnects
                    db.onversionchange = () => {
                        db.close();
                        if (dbPromise === opening) dbPromise = null;
                    };
                    resolve(db);
                };
                request.onupgradeneeded = (event) => {
                    const db = event.target.result;
                    if (!db.objectStoreNames.contains('directories')) {
                        db.createObjectStore('directories');
                    }
                    if (!db.objectStoreNames.contains('files')) {
                        db.createObjectStore('files');
                    }
                };
            });
            opening.catch(() => { if (dbPromise === opening) dbPromise = null; });
            dbPromise = opening;
        }
        return dbPromise;
    }

    async function fileStore(mode, action) {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction('files', mode);
            const request = action(tx.objectStore('files'));
            let result;
            if (request) request.onsuccess = () => { result = request.result; };
            tx.oncomplete = () => resolve(result);
            // a failed request bubbles here before the transaction aborts, while tx.error is still null
            tx.onerror = (event) => reject(event.target.error || tx.error);
            tx.onabort = () => reject(tx.error);
        });
    }

    async function cacheComicFile(file, source) {
        // a copy bigger than the whole budget would only push every other copy out
        if (file.size > FILE_CACHE_LIMIT) return;
        const record = {
            name: file.name,
            blob: file,
            size: file.size,
            type: file.type,
            source,
            lastOpened: Date.now()
        };
        const put = () => fileStore('readwrite', (store) => store.put(record, file.name));
        try {
            if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
            try {
                await put();
            } catch (err) {
                // the browser's quota can be below FILE_CACHE_LIMIT (small phones): make room so this
                // copy and the rest fit in half the budget, then try once more
                if (!isQuotaError(err) || !(await pruneFileCache(FILE_CACHE_LIMIT / 2 - file.size, file.name))) throw err;
                await put();
            }
            await pruneFileCache(FILE_CACHE_LIMIT, file.name);
        } catch (err) {
            console.warn('Could not keep an offline copy of this comic:', err);
        }
    }

    async function getCachedComic(name) {
        try {
            const record = await fileStore('readonly', (store) => store.get(name));
            if (!record) return null;
            return { file: new File([record.blob], record.name, { type: record.type || 'application/octet-stream' }), source: record.source };
        } catch (err) {
            console.warn('Could not read the offline copy:', err);
            return null;
        }
    }

    function deleteCachedComics(names) {
        if (!names.length) return Promise.resolve();
        return fileStore('readwrite', (store) => {
            names.forEach((name) => store.delete(name));
            return null;
        }).catch((err) => console.warn('Could not delete offline copies:', err));
    }

    // drops the least recently read copies until the total fits in `limit`; `keep` (the comic being
    // cached) always stays. Returns how many copies were dropped
    async function pruneFileCache(limit = FILE_CACHE_LIMIT, keep = null) {
        const records = await fileStore('readonly', (store) => store.getAll());
        // reopening a copy does not rewrite it, so the reading history gives the real last use
        const history = readHistory();
        const lastRead = (record) => history[record.name]?.timestamp ?? record.lastOpened ?? 0;
        let total = records.reduce((sum, record) => sum + (record.size || 0), 0);
        const candidates = records
            .filter((record) => record.name !== keep)
            .sort((a, b) => lastRead(a) - lastRead(b));
        const drop = [];
        while (total > limit && candidates.length) {
            const oldest = candidates.shift();
            total -= oldest.size || 0;
            drop.push(oldest.name);
        }
        await deleteCachedComics(drop);
        return drop.length;
    }

    async function saveDirectoryHandle(dirHandle) {
        try {
            const db = await openDB();
            const tx = db.transaction('directories', 'readwrite');
            const store = tx.objectStore('directories');
            store.put(dirHandle, 'comicsFolder');
            await new Promise((resolve, reject) => {
                tx.oncomplete = resolve;
                tx.onerror = (event) => reject(event.target.error || tx.error);
                tx.onabort = () => reject(tx.error);
            });
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
                .slice(0, RECENT_LIMIT);

            recentComicsListEl.innerHTML = '';

            for (const [filename, data] of recentComics) {
                const progress = progressInfo(data);
                const item = createComicItem(
                    filename,
                    data,
                    `${progress.label} • ${formatTimestamp(data.timestamp)}`,
                    progress.ratio,
                    () => openRecent(filename)
                );

                const removeBtn = document.createElement('button');
                removeBtn.type = 'button';
                removeBtn.className = 'recent-remove-btn';
                removeBtn.title = 'Remove from Recently Read';
                removeBtn.setAttribute('aria-label', `Remove ${filename} from Recently Read`);
                removeBtn.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>';
                removeBtn.addEventListener('click', async () => {
                    // the list is rebuilt without this row; the focus moves to the row taking its place
                    const hadFocus = item.contains(document.activeElement);
                    const index = [...recentComicsListEl.children].indexOf(item);
                    await window.CloudSync?.pullNow?.();
                    hideFromRecent(filename);
                    await loadRecentComics();
                    if (!hadFocus) return;
                    const rows = recentComicsListEl.querySelectorAll('.recent-comic-open');
                    const next = rows[Math.min(index, rows.length - 1)];
                    (isFocusable(next) ? next : visibleHeading())?.focus();
                });
                item.appendChild(removeBtn);

                recentComicsListEl.appendChild(item);
            }

            recentComicsEl.style.display = recentComicsListEl.children.length > 0 ? 'block' : 'none';
        } catch (err) {
            console.error('Failed to load recent comics:', err);
        }
    }

    // offline copy first, then the library folder, otherwise ask for the file again
    async function openRecent(filename) {
        const cached = await getCachedComic(filename);
        if (cached) {
            openComic(cached.file, { source: cached.source || 'upload', fromCache: true });
            return;
        }
        if (comicsDirectoryHandle) {
            await openComicFromFolder(filename);
            return;
        }
        showReopenNotice(filename);
    }

    function showReopenNotice(filename) {
        showQuickReadMode();
        const page = (readHistory()[filename]?.last_page || 0) + 1;
        showQuickNotice(`"${filename}" is not stored in this browser any more. Select the file again and reading continues at page ${page}.`);
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
                    // from inside the reader (next/previous comic) the open comic just stays open
                    if (reader.open) showToast('No access to the comics folder', false); else showReconnectButton();
                    return;
                }
            }

            const fileHandle = await comicsDirectoryHandle.getFileHandle(filename);
            const file = await fileHandle.getFile();
            openComic(file, { source: 'folder' });
        } catch (err) {
            console.error('Failed to open comic:', err);
            if (reader.open) {
                showToast(`Could not open "${filename}"`, false);
            } else if (err.name === 'NotAllowedError') {
                showReconnectButton();
            } else {
                // keep the history entry: the file may come back or be selected manually
                showReopenNotice(filename);
            }
        }
    }

    // history merged by cloud-sync.js; `changedNames` are the entries that differ from before
    function applyRemoteHistory(history, changedNames = []) {
        changedNames = changedNames || [];
        writeHistory(history, false);
        if (!reader.open) {
            if (changedNames.length) {
                loadRecentComics();
                if (currentView === 'library') renderAllComics();
            }
            return;
        }
        // the lists are re-rendered when the reader closes; never move the open comic
        if (changedNames.includes(reader.filename)) offerRemotePage(history[reader.filename]);
    }

    // the open comic's stored page differs from the one shown (it came from another device): offer it
    function offerRemotePage(remote) {
        if (!reader.open || !reader.tracking || !remote || !reader.pages.length) return;
        const page = Math.max(0, Math.min(remote.last_page | 0, reader.pages.length - 1));
        if (page === reader.current) return;
        showToast(`Read to page ${page + 1} on another device`, {
            label: `Go to page ${page + 1}`,
            run: () => jumpToPage(page)
        });
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
