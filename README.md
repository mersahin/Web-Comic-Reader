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
- **Go to Page** - Click the page counter (or press `G`) for a page slider and a page number field; `Enter` or **Go** jumps there
- **Next Issue** - At the end of a comic from your library folder (in both views), a **Next** button with the name and saved progress of the following file opens it, in the same order as the library list; `[` and `]` open the previous and next comic
- **Resume Reading** - Jumps back to the exact page you left, with a one-click "Start over"
- **Stays in Place** - Rotating the phone, resizing the window or switching fullscreen keeps your spot in scroll mode. The screen stays on while a comic is open, until 10 minutes pass without turning a page or scrolling (in browsers with the Screen Wake Lock API)
- **Fast Opening** - The comic shows as soon as the pages up to your saved page are extracted; the rest loads in the background (percentage next to the page counter). **Cancel** on the loading screen (or `Esc`) closes it
- **Library Mode** - Select your comics folder once, access anytime with persistent folder access
- **Reading Progress** - Automatically saves your last read page and scrolls to it when you reopen
- **Thumbnail Previews** - Auto-generated cover thumbnails for quick comic recognition
- **Recently Read** - On the start screen: your last 20 comics with page, percentage and a progress bar; remove single entries or clear the list (progress is kept)
- **Sync Across Devices** - Optional account (email + password) that keeps reading progress, Recently Read, reader settings and My channels in sync; each user sees only their own data
- **Offline Copies** - Comics that open successfully (uploads and Telegram downloads) are kept in the browser (IndexedDB, up to 1 GB, least recently read dropped first; a single file over 1 GB is not kept) so Recently Read reopens them in one click. Reopening a copy does not write it again, and when the browser runs out of space older copies make room for the new one
- **Telegram Search** - Sign in once with your own Telegram API ID, type a title and read CBZ/CBR/CBT files from public channels right in the browser; an optional local helper adds `site:t.me` web search
- **Quick Read Mode** - Upload and read individual files without library setup
- **Keyboard, Screen Reader and Phone Friendly** - Every comic in All Comics and Recently Read is a button you can reach with `Tab`, and closing a comic puts the focus back on its row. Follows the system's dark mode (also for scrollbars, form controls and the browser bar colour) and its reduce-motion setting (no smooth scrolling, slide or hover animations). On phones the layout stays clear of the notch in landscape, form fields do not zoom the page on iOS, and small buttons get larger touch targets
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
2. Click the box (or Tab to it and press Enter) to pick a CBR/CBZ/CBT file, or drop one onto it. One comic opens at a time: if you drop several, the first comic is opened and the rest are ignored; other file types are refused with a notice
3. Read immediately (progress is remembered per file name in this browser)

### Telegram Search
Open **Search Telegram**, sign in once under **Telegram account** with your own API ID and API hash from [my.telegram.org/apps](https://my.telegram.org/apps), your phone number and the login code (plus your two-step password if you use one). A bot token from BotFather does not work.

Everything then runs in the browser, nothing to install: the bundled [GramJS](https://github.com/gram-js/gramjs) client (`assets/js/vendor/telegram.js`) talks to Telegram directly over WebSocket.

How a search works:
1. Channels listed under **My channels** (up to 50) are always searched.
2. Telegram's own channel search finds public channels matching the title.
3. Each channel is searched for documents; only `.cbz`, `.cbr` and `.cbt` files are listed. If none match but the channel name did, its latest comics are shown.
4. Files in chats you have joined are searched too.
5. **Read** downloads the file with a progress bar, keeps an offline copy and opens it. Files from channels that disable saving are not downloaded.

Where the login is kept:
- `localStorage` holds only the API ID.
- The Telegram session and API hash live in `sessionStorage` and disappear when the tab is closed.
- **Remember me on this device** stores them encrypted with your passphrase (PBKDF2-SHA256, 310,000 iterations, AES-GCM). The next visit asks for the passphrase. This matters because every GitHub Pages project under the same `<user>.github.io` address shares `localStorage`.
- **Log out** ends the Telegram session and deletes both copies; **Forget this device** deletes the saved one.

All third-party scripts and styles are pinned with Subresource Integrity hashes.

#### Optional: web search through a local helper
Search engines and t.me pages cannot be read by a website (no CORS headers), so `site:t.me` web search needs [`tools/tg-finder/tg_finder.py`](tools/tg-finder/tg_finder.py) running on a computer (Python 3, standard library only). When it runs next to a signed-in browser, its web results are added as extra channels; without a Telegram login it can search on its own and, with `--api-id/--api-hash` and Telethon, download as well.

```bash
python3 tools/tg-finder/tg_finder.py
```

It listens only on `127.0.0.1` and answers only this site and `localhost`. Search engines may show captchas after many searches; the site lists which sources failed.

#### Rebuilding the Telegram client bundle
```bash
cd tools/telegram-bundle && npm ci && npm run build
```

### Sync Across Devices
Click **Sign in** in the bar at the bottom of the panel, create an account with email and password, confirm the email, then sign in on each device. The confirmation link does not sign you in: the page says the email is confirmed, and you sign in with your password.

What is synced: reading progress and Recently Read (file name, page, page count, last read), reader view settings, and the My channels list. Comic files, thumbnails and Telegram logins stay on each device.

Sync is automatic, there is nothing to press:
- It checks for changes from other devices on sign-in, about every 30 to 60 seconds while the page is visible, when the tab or window gets focus again, when a comic is opened (before it resumes, waiting at most 3 seconds) or closed, and when the network comes back.
- Changes made on this device are sent within a few seconds (at least every 10 seconds while reading), and right away when the tab is hidden or closed.
- For each comic the newest change wins. A change always counts as newer than the version it was made on, so a device clock that runs ahead or behind cannot make it lose. Opening a comic is not a change: it resumes at the newest page from any device and never sends an older one.
- Before the SQL block at the end of `supabase/schema.sql` has been run, the app looks up the server copy of a comic before it sends a change (the newer one wins; an older change that is still unsent when the tab closes goes out on the next visit), and fetches all rows about once a minute. Once it has been run, the server keeps the newer row when a device with older data sends it (that device then takes the server copy), and only changed rows are fetched.
- If the same comic is open on another device, the reader never jumps; it offers **Go to page N** instead. View settings from another device apply when the comic is closed.
- Tabs of the same browser share the progress, view settings and My channels: a change in one tab shows up in the others (a new view mode waits until the comic is closed, a new channel list until you leave the My channels box).
- The bar turns amber while offline or retrying and red after repeated failures. **Sync now** forces a full check.
- A comic whose file name the server cannot store (longer than 512 characters, or with invalid characters) stays on this device only and never blocks the rest of the sync.

The sign-in lasts until the tab is closed unless **Stay signed in on this device** is ticked. **Log out** signs out this browser only; your other devices stay signed in, and it works offline too. **Delete my synced data** removes everything from the server and logs out; the device keeps its own copy and does not upload it again when you sign in later (only new reading is synced). A password reset link opens only the new-password form and nothing syncs until it is saved; you then sign in with the new password. An expired or already used confirmation or reset link shows a message in the Account view.

If two accounts are signed in in two tabs of the same browser, the one that synced first keeps syncing and the other tab shows "Another account is syncing in another tab" until the first one logs out, is closed or stays hidden for 2 minutes.

#### Setting it up (once, by the site owner)
1. Create a free project at [supabase.com](https://supabase.com) in the **Central EU (Frankfurt)** region.
2. Open **SQL Editor**, paste [`supabase/schema.sql`](supabase/schema.sql) and run it. It creates the tables and the row level security rules that let each user read and write only their own rows. Running the whole file again later is safe, for example after it was updated.
3. **Authentication > URL Configuration**: set **Site URL** to `https://mersahin.github.io/Web-Comic-Reader/` and add the same address under **Redirect URLs** (used by confirmation and password reset emails).
4. **Authentication > Sign In / Providers > Email**: keep Email enabled and **Confirm email** on.
5. **Project Settings > API**: copy the **Project URL** and the **anon / publishable** key into [`assets/js/sync-config.js`](assets/js/sync-config.js), then commit and push. The anon key is meant to be public; the row level security rules protect the data. Never put the `service_role` key in the site.
6. Optional: to keep the site for yourself, create your account first, then turn off **Allow new users to sign up** under Authentication.

#### Keeping the free project awake
Free Supabase projects are paused after a week without database activity. [`.github/workflows/supabase-keepalive.yml`](.github/workflows/supabase-keepalive.yml) prevents that: every day at 05:17 UTC it calls `public.keepalive()` as the anon role, using the Project URL and publishable key from `sync-config.js`. It needs no secrets and reads no user data.
- Run the block at the end of `supabase/schema.sql` (or the whole file) once in the **SQL Editor**. Until then the job pings `valid_channel_list` instead and shows a warning.
- Start it by hand under **Actions > Supabase keepalive > Run workflow**.
- A second job re-enables the workflow on every run, so GitHub does not switch the schedule off after 60 days without repository activity.
- GitHub emails failed runs to whoever created the workflow or last changed its schedule.
- If the project was paused anyway, resume it in the Supabase dashboard.

### Keyboard Shortcuts (while reading)
| Key | Action |
|-----|--------|
| `→` / `D` / `N` | Next page (scroll mode) |
| `←` / `A` / `P` | Previous page (scroll mode) |
| `Space`, `PageDown`, `↓` | Scroll down |
| `M` | Switch between scroll and grid view |
| `W` / `Shift+W` | Cycle page width (scroll mode) |
| `F` | Toggle fullscreen |
| `G` | Go to page: opens the page slider and number field under the toolbar (`Enter` jumps, `Esc` closes it) |
| `[` / `]` | Previous / next comic in the library folder (comics opened from the folder) |
| `Esc` | Close the go-to-page panel when it is open, otherwise close the comic (also while it is still loading) |
| Browser or phone **Back** | Close the comic and stay on the site (in grid view an enlarged page is closed first) |

Moving around with `Tab`:
- On the start screen and in the library, `Tab` reaches each comic row; `Enter` opens it. In Recently Read the **×** next to a row is its own stop and removes the comic from the list.
- Opening a comic puts the focus on its title in the toolbar, so `Space` keeps scrolling. `Shift+Tab` goes to Close, `Tab` to the other toolbar buttons; a hidden toolbar slides back in when the focus reaches it.
- In scroll mode `Tab` skips the pages and goes on to the end of the comic. In grid mode every thumbnail is a stop.
- Closing a comic puts the focus back where it was opened: on its row in the list, on the Quick Read box, or on the search field in Telegram search.

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
│       ├── telegram-finder.js  # Telegram search UI (in-browser client or local helper)
│       ├── cloud-sync.js       # Account + sync of progress, settings, My channels
│       ├── sync-config.js      # Supabase project URL + anon key (fill in to enable sync)
│       ├── vendor/telegram.js  # GramJS browser bundle (built by tools/telegram-bundle)
│       └── uncompress/
│           └── uncompress.js  # Archive extraction
├── tools/tg-finder/tg_finder.py # Optional local helper (web search)
├── tools/telegram-bundle/       # Build script for the GramJS bundle
├── supabase/schema.sql          # Tables, row level security, sync triggers, keepalive()
├── .github/workflows/pages.yml  # GitHub Pages deployment
├── .github/workflows/supabase-keepalive.yml  # Daily ping that keeps the free Supabase project awake
├── README.md
└── LICENSE
```

### Development Notes
- Reading progress is stored in `localStorage` (key: `comic_reader_userpref`)
- Reader settings (view mode, page width) are stored in `localStorage` (key: `comic_reader_settings`)
- Reading history entries hold `last_page`, `total_pages`, `source`, `timestamp`, `updated_at` (last change, for the sync merge; 1 ms after 1970 for a comic only opened on this device, so any other device's copy wins), `thumbnail` and `hidden_from_recent`; all access goes through `readHistory`/`writeHistory`/`saveLastPageRead`, the seam for a future synced store
- Offline copies live in IndexedDB `ComicReaderDB` (store `files`); Telegram search settings in `localStorage` (key: `comic_reader_finder`); Telegram login in `comic_reader_tg` (API ID only), `sessionStorage` `comic_reader_tg_tab` and the encrypted `comic_reader_tg_vault`
- Archive pages are filtered to images (`__MACOSX`, dotfiles, empty entries and metadata such as `ComicInfo.xml` are skipped) and sorted naturally (`page2` before `page10`)
- A page that cannot be extracted or decoded shows a "Page could not be read" placeholder instead of stopping the comic; RAR/TAR pages that give no answer within 30 s count as unreadable
- Folder handles are stored in `IndexedDB` (database: `ComicReaderDB`). A tab still running an older version of the reader can block a database upgrade; offline copies and the restored library folder are then skipped with "Close other tabs of this reader and reload." in the console instead of hanging. Tabs with this version close their connection when a newer version upgrades the database
- Thumbnails are base64-encoded JPEGs in the history entry in localStorage: 100 px wide and at most 150 px tall (tall pages such as webtoons are cropped from the top), made once per comic (older, taller ones are replaced on the next open)
- localStorage is shared by every project on the same `<user>.github.io` address. When it is full, thumbnails of hidden entries and of entries outside the 20 shown in Recently Read are dropped and the save is retried once; if it still fails, "Browser storage is full; reading progress could not be saved." appears once per page load
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

## License

This project is licensed under the MIT License - see the LICENSE file for details.
