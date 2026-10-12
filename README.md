# Web Comic Reader

Modern web-based comic book reader for CBR, CBZ, and CBT files with library management and reading progress tracking.

**Live:** https://mersahin.github.io/Web-Comic-Reader/

> Based on [afzafri/Web-Comic-Reader](https://github.com/afzafri/Web-Comic-Reader) (MIT). Upstream history is preserved, so upstream fixes can be merged with `git remote add upstream https://github.com/afzafri/Web-Comic-Reader.git && git fetch upstream && git merge upstream/master`.

## Features

- **Modern UI** 
- **Continuous Scroll Mode** - Pages stacked top to bottom with no gaps, like a webtoon/long-strip reader (default)
- **Grid + Gallery Mode** - Thumbnail grid with lightGallery zoom, rotate and fullscreen; switch any time without losing your page
- **Adjustable Page Width** - Narrow, medium, wide or full width in scroll mode
- **Auto-hiding Toolbar** - Page counter, progress bar, view switch and fullscreen; hides while you read down
- **Resume Reading** - Jumps back to the exact page you left, with a one-click "Start over"
- **Library Mode** - Select your comics folder once, access anytime with persistent folder access
- **Reading Progress** - Automatically saves your last read page and scrolls to it when you reopen
- **Thumbnail Previews** - Auto-generated cover thumbnails for quick comic recognition
- **Recently Read** - On the start screen: your last 20 comics with page, percentage and a progress bar; remove single entries or clear the list (progress is kept)
- **Offline Copies** - Comics you open (uploads and Telegram downloads) are kept in the browser (IndexedDB, up to 1 GB, oldest dropped first) so Recently Read reopens them in one click
- **Telegram Search** - Type a title; a small local helper searches the web for `site:t.me` channels, scans their public pages for CBZ/CBR/CBT files and, optionally, downloads them straight into the reader
- **Quick Read Mode** - Upload and read individual files without library setup
- **Client-Side Only** - All processing happens in your browser, no server uploads required
- **Offline Support** - Works completely offline after initial load

## Usage

### Library Mode (Recommended)
1. Click "Select Comics Folder"
2. Choose your comics folder and grant permission
3. Browse your library with thumbnails and progress tracking
4. Click any comic to read
5. Your progress is automatically saved

### Quick Read Mode
1. Click "Quick Read"
2. Upload a single CBR/CBZ/CBT file
3. Read immediately (progress is remembered per file name in this browser)

### Telegram Search
Browsers cannot read t.me or search-engine pages from another website (they send no CORS headers), so the searching is done by a small helper that runs on your own computer: [`tools/tg-finder/tg_finder.py`](tools/tg-finder/tg_finder.py). It only listens on `127.0.0.1` and only answers this site and `localhost`.

```bash
# search only: Python 3, no extra packages
python3 tools/tg-finder/tg_finder.py

# search + read files directly in the site, through your own Telegram account
pip install telethon
python3 tools/tg-finder/tg_finder.py --api-id 12345 --api-hash <hash from my.telegram.org/apps>
```

How a search works:
1. The helper searches the web for `site:t.me <title>` (DuckDuckGo, DuckDuckGo Lite, then Bing) and collects channel names. With an API ID it also uses Telegram's own channel search.
2. Channels listed under **My channels** in the site are always included.
3. Each channel's public page (`t.me/s/<channel>?q=<title>`) is scanned for `.cbz`, `.cbr` and `.cbt` files. If none match but the channel name did, its latest comics are shown.
4. **Read** downloads the file through the helper (only with `--api-id`), keeps an offline copy and opens it. Files from channels that disable saving are not downloaded.

Without `--api-id`, results still link to the post in Telegram; a downloaded file can be dropped into Quick Read. The first start with `--api-id` asks for your phone number and login code in the terminal; the session file (`tg_finder.session`) stays next to the script. Chrome may ask to allow access to your local network the first time.

Search engines may answer with a captcha after many searches; the site shows which sources failed.

### Keyboard Shortcuts (while reading)
| Key | Action |
|-----|--------|
| `→` / `D` / `N` | Next page (scroll mode) |
| `←` / `A` / `P` | Previous page (scroll mode) |
| `Space`, `PageDown`, `↓` | Scroll down |
| `M` | Switch between scroll and grid view |
| `W` / `Shift+W` | Cycle page width (scroll mode) |
| `F` | Toggle fullscreen |
| `Esc` | Close the comic |

## Getting Started (Development)

### Prerequisites
- A local web server (Python's `http.server`, Node's `http-server`, etc.)
- For Library Mode: HTTPS server setup

### Basic Setup (HTTP - Quick Read Only)
```bash
# Clone or download the repository
git clone <repository-url>
cd Web-Comic-Reader

# Start a local server (choose one):
# Python 3
python -m http.server 8000

# Python 2
python -m SimpleHTTPServer 8000

# Node.js http-server
npx http-server -p 8000

# PHP
php -S localhost:8000
```

Visit `http://localhost:8000` in your browser. Only Quick Read mode will work.

### HTTPS Setup (Required for Library Mode)

To enable Library Mode with folder access, you need HTTPS:

**Option 1: Using nginx-proxy (Recommended for local development)**
1. Set up nginx-proxy with SSL certificates
2. Configure proxy to your local server
3. Access via `https://yourdomain.test`

**Option 2: Using mkcert for local HTTPS**
```bash
# Install mkcert
# macOS
brew install mkcert

# Create local CA
mkcert -install

# Generate certificate
mkcert localhost 127.0.0.1

# Use with your server (example with http-server)
npx http-server -p 8000 -S -C localhost+1.pem -K localhost+1-key.pem
```

### Deployment (GitHub Pages)

`.github/workflows/pages.yml` publishes the site on every push to the default branch.
One-time setup: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
GitHub Pages serves over HTTPS, so Library Mode works on the live site.

### File Structure
```
├── index.html              # Main HTML file
├── assets/
│   ├── css/
│   │   └── styles.css     # All styles and theming
│   └── js/
│       ├── script.js      # Main application logic
│       ├── telegram-finder.js  # Telegram search UI (talks to the local helper)
│       └── uncompress/
│           └── uncompress.js  # Archive extraction
├── tools/tg-finder/tg_finder.py # Local helper for Telegram search
├── .github/workflows/pages.yml  # GitHub Pages deployment
├── README.md
└── LICENSE
```

### Development Notes
- Reading progress is stored in `localStorage` (key: `comic_reader_userpref`)
- Reader settings (view mode, page width) are stored in `localStorage` (key: `comic_reader_settings`)
- Reading history entries hold `last_page`, `total_pages`, `source`, `timestamp`, `thumbnail` and `hidden_from_recent`; all access goes through `readHistory`/`writeHistory`/`saveLastPageRead`, the seam for a future synced store
- Offline copies live in IndexedDB `ComicReaderDB` (store `files`); Telegram search settings in `localStorage` (key: `comic_reader_finder`)
- Archive pages are filtered to images (`__MACOSX`, dotfiles and metadata such as `ComicInfo.xml` are skipped) and sorted naturally (`page2` before `page10`)
- Folder handles are stored in `IndexedDB` (database: `ComicReaderDB`)
- Thumbnails are base64-encoded JPEG stored in localStorage
- Uses vanilla JavaScript (no jQuery required)

## Requirements

- Modern browser with File System Access API support (Chrome, Edge, Opera)
- **HTTPS required** for Library Mode (folder access)
- For Quick Read Mode, HTTP is sufficient

## Browser Compatibility

### Library Mode (File System Access API)
**✅ Fully Supported:**
- Chrome/Chromium (desktop)
- Microsoft Edge (desktop)
- Opera (desktop)

**❌ Not Supported:**
- Safari (macOS & iOS) - Apple has not implemented this API due to privacy/security concerns
- Firefox - Partially supported behind flags, not production-ready
- All iOS browsers (Chrome, Firefox, Edge on iOS) - Use Safari's engine, inherit same limitations

**📝 Note:** Safari and unsupported browsers will automatically fall back to Quick Read mode only. Users can still read comics by uploading individual files, but library features and progress tracking won't be available.

## Supported Formats

- `.cbr` - Comic Book RAR
- `.cbz` - Comic Book ZIP
- `.cbt` - Comic Book TAR

## Technical Details

- Pure client-side processing (no server required)
- Reading progress stored in localStorage
- Folder handles stored in IndexedDB
- Thumbnails generated using Canvas API
- lightGallery for image viewing with zoom and fullscreen

## Credits

- [Uncompress.js](https://github.com/workhorsy/uncompress.js) - Archive extraction
- [lightGallery](https://github.com/sachinchoolur/lightGallery) - Image gallery and viewer
- [Dropzone.js](https://www.dropzone.dev/) - File upload handling

## License

This project is licensed under the MIT License - see the LICENSE file for details.
