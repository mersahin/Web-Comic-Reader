# Web Comic Reader

Modern web-based comic book reader for CBR, CBZ, and CBT files with library management and reading progress tracking.

**Live:** https://mersahin.github.io/Web-Comic-Reader/

> Based on [afzafri/Web-Comic-Reader](https://github.com/afzafri/Web-Comic-Reader) (MIT). Upstream history is preserved, so upstream fixes can be merged with `git remote add upstream https://github.com/afzafri/Web-Comic-Reader.git && git fetch upstream && git merge upstream/master`.

## Features

- **Modern UI** 
- **Library Mode** - Select your comics folder once, access anytime with persistent folder access
- **Reading Progress** - Automatically saves your last read page and scrolls to it when you reopen
- **Thumbnail Previews** - Auto-generated cover thumbnails for quick comic recognition
- **Recently Read** - Quick access to your last 5 comics with progress indicators
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
3. Read immediately (progress won't be saved)

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
│       └── uncompress/
│           └── uncompress.js  # Archive extraction
├── .github/workflows/pages.yml  # GitHub Pages deployment
├── README.md
└── LICENSE
```

### Development Notes
- Reading progress is stored in `localStorage` (key: `comic_reader_userpref`)
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
