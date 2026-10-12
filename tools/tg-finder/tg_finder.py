#!/usr/bin/env python3
"""Local helper for Web Comic Reader's Telegram search.

The reader runs on GitHub Pages. Browsers block it from reading t.me and
search-engine pages directly (those sites send no CORS headers), so this
helper runs on your own computer, fetches the pages for the reader and
answers with JSON. It only listens on 127.0.0.1.

Search (no account needed, standard library only):
    python3 tg_finder.py

Search + downloads through your own Telegram account (pip install telethon,
API ID/hash from https://my.telegram.org/apps):
    python3 tg_finder.py --api-id 12345 --api-hash 0123abcd...

Endpoints (all GET, JSON unless noted):
    /health                         status, whether downloads are enabled
    /search?q=batman                web search "site:t.me <q>" -> channels -> comic files
    /channel?u=name[&q=..][&before=id]  comic files in one public channel
    /download?u=name&id=123         file bytes (only with --api-id/--api-hash)
"""

import argparse
import asyncio
import html
import json
import queue
import re
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

VERSION = 1
DEFAULT_PORT = 8787
DEFAULT_ORIGINS = ["https://mersahin.github.io"]
COMIC_RE = re.compile(r"\.(cbz|cbr|cbt)$", re.IGNORECASE)
USERNAME_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_]{3,31}$")
TME_LINK_RE = re.compile(r"https?://(?:www\.)?t\.me/(?:s/)?([A-Za-z][A-Za-z0-9_]{3,31})(?:/(\d+))?", re.IGNORECASE)
# t.me paths that are not channels
RESERVED_PATHS = {
    "joinchat", "addstickers", "addemoji", "addlist", "addtheme", "share", "proxy", "socks",
    "iv", "login", "setlanguage", "confirmphone", "invoice", "boost", "contact", "giftcode",
    "blog", "faq", "apps", "privacy", "tos", "username", "dl",
}
USER_AGENT = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/129.0 Safari/537.36")
CACHE_TTL = 600
MAX_CHANNELS = 8


class HelperError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


# ---------------------------------------------------------------------------
# HTTP fetching with a small in-memory cache
# ---------------------------------------------------------------------------

_cache = {}
_cache_lock = threading.Lock()


def fetch(url, data=None, timeout=20):
    key = (url, json.dumps(data, sort_keys=True) if data is not None else None)
    now = time.time()
    with _cache_lock:
        hit = _cache.get(key)
        if hit and now - hit[0] < CACHE_TTL:
            return hit[1]
    headers = {
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.8,de;q=0.6,tr;q=0.5",
    }
    body = None
    if data is not None:
        body = urllib.parse.urlencode(data).encode()
        headers["Content-Type"] = "application/x-www-form-urlencoded"
    request = urllib.request.Request(url, data=body, headers=headers)
    with urllib.request.urlopen(request, timeout=timeout) as response:
        text = response.read().decode("utf-8", "replace")
        final_url = response.geturl()
    with _cache_lock:
        _cache[key] = (now, (text, final_url))
    return text, final_url


# ---------------------------------------------------------------------------
# Web search: find public channels for a keyword via "site:t.me"
# ---------------------------------------------------------------------------

BLOCKED_RE = re.compile(r"anomaly|captcha|unusual traffic", re.IGNORECASE)


def _search_engines(query):
    yield "duckduckgo", lambda: fetch("https://html.duckduckgo.com/html/", data={"q": query, "kl": "wt-wt"})[0]
    yield "duckduckgo-lite", lambda: fetch("https://lite.duckduckgo.com/lite/", data={"q": query})[0]
    yield "bing", lambda: fetch("https://www.bing.com/search?" + urllib.parse.urlencode({"q": query, "count": "50"}))[0]


def extract_channels(page):
    """Channel usernames in the order they appear in a result page."""
    text = urllib.parse.unquote(html.unescape(page))
    seen = []
    for match in TME_LINK_RE.finditer(text):
        name = match.group(1)
        if name.lower() in RESERVED_PATHS or name.lower() in (n.lower() for n in seen):
            continue
        if USERNAME_RE.match(name):
            seen.append(name)
    return seen


def web_search_channels(keyword, limit=MAX_CHANNELS):
    queries = [f"site:t.me {keyword} cbz OR cbr", f"site:t.me {keyword}"]
    found, engines, errors = [], [], []
    for query in queries:
        for engine, run in _search_engines(query):
            try:
                page = run()
            except Exception as exc:  # noqa: BLE001 - report and try the next engine
                errors.append(f"{engine}: {exc}")
                continue
            names = extract_channels(page)
            if not names and BLOCKED_RE.search(page):
                errors.append(f"{engine}: asked for a captcha, try again later")
                continue
            if names:
                engines.append(engine)
                for name in names:
                    if name.lower() not in (n.lower() for n in found):
                        found.append(name)
                break
        if len(found) >= limit:
            break
    return found[:limit], sorted(set(engines)), errors


# ---------------------------------------------------------------------------
# t.me/s/<channel> preview parsing
# ---------------------------------------------------------------------------

def _text(fragment):
    return html.unescape(re.sub(r"<[^>]+>", "", fragment or "")).strip()


def _first(pattern, text, flags=re.S):
    match = re.search(pattern, text, flags)
    return match.group(1) if match else None


def parse_size(label):
    match = re.match(r"([\d.,]+)\s*(B|KB|MB|GB)", label or "", re.IGNORECASE)
    if not match:
        return None
    value = float(match.group(1).replace(",", "."))
    factor = {"B": 1, "KB": 1024, "MB": 1024 ** 2, "GB": 1024 ** 3}[match.group(2).upper()]
    return int(value * factor)


def parse_channel_page(page, username):
    info = {
        "username": username,
        "title": _text(_first(r'class="tgme_channel_info_header_title"[^>]*>(.*?)</div>', page)) or username,
        "photo": _first(r'class="tgme_page_photo_image[^"]*"[^>]*>\s*<img src="([^"]+)"', page),
        "preview": "tgme_widget_message" in page or "tgme_channel_info" in page,
    }
    files = []
    ids = []
    chunks = re.split(r'(?=<div class="tgme_widget_message_wrap)', page)
    for chunk in chunks:
        post = _first(r'data-post="([^"]+)"', chunk)
        if not post or "/" not in post:
            continue
        msg_id = int(post.rsplit("/", 1)[1]) if post.rsplit("/", 1)[1].isdigit() else None
        if msg_id is None:
            continue
        ids.append(msg_id)
        for doc in re.finditer(r'tgme_widget_message_document_title[^>]*>(.*?)</div>\s*'
                               r'<div class="tgme_widget_message_document_extra[^>]*>(.*?)</div>', chunk, re.S):
            name = _text(doc.group(1))
            if not COMIC_RE.search(name):
                continue
            size_label = _text(doc.group(2))
            files.append({
                "id": msg_id,
                "name": name,
                "sizeLabel": size_label,
                "size": parse_size(size_label),
                "date": _first(r'<time datetime="([^"]+)"', chunk),
                "caption": _text(_first(r'class="tgme_widget_message_text[^"]*"[^>]*>(.*?)</div>', chunk))[:280],
                "url": f"https://t.me/{username}/{msg_id}",
                "protected": "tgme_widget_message_protected" in chunk,
            })
    info["files"] = files
    info["oldestId"] = min(ids) if ids else None
    return info


def _format_size(size):
    if not size:
        return ""
    value = float(size)
    for unit in ("B", "KB", "MB"):
        if value < 1024:
            return f"{int(value)} B" if unit == "B" else f"{value:.1f} {unit}"
        value /= 1024
    return f"{value:.1f} GB"


def channel_files(username, keyword="", before=None, downloader=None):
    if not USERNAME_RE.match(username or ""):
        raise HelperError(400, "Invalid channel username")
    params = {}
    if keyword:
        params["q"] = keyword
    if before:
        params["before"] = str(before)
    url = f"https://t.me/s/{username}" + ("?" + urllib.parse.urlencode(params) if params else "")
    try:
        page, final_url = fetch(url)
    except urllib.error.HTTPError as exc:
        raise HelperError(502, f"t.me answered {exc.code} for @{username}") from exc
    if "/s/" not in final_url:
        # channel exists but has the web preview disabled (or is not a channel)
        if downloader is not None:
            return downloader.channel_files(username, keyword, before)
        return {"username": username, "title": username, "photo": None, "preview": False, "files": [], "oldestId": None}
    return parse_channel_page(page, username)


def _merge(target, names):
    for name in names:
        if USERNAME_RE.match(name or "") and name.lower() not in (n.lower() for n in target):
            target.append(name)


def search(keyword, extra_channels=(), downloader=None):
    keyword = (keyword or "").strip()
    if len(keyword) < 2:
        raise HelperError(400, "Search term is too short")
    names = []
    _merge(names, extra_channels)
    web_names, engines, errors = web_search_channels(keyword)
    _merge(names, web_names)
    if downloader is not None:
        try:
            _merge(names, downloader.find_channels(keyword))
            engines.append("telegram")
        except Exception as exc:  # noqa: BLE001
            errors.append(f"telegram: {exc}")
    channels = []
    for name in names[:MAX_CHANNELS + len(extra_channels)]:
        try:
            result = channel_files(name, keyword, downloader=downloader)
            if not result["files"]:
                # the channel matched the keyword, list its latest comics instead
                result = channel_files(name, downloader=downloader)
                result["matchedBy"] = "channel"
            else:
                result["matchedBy"] = "files"
            channels.append(result)
        except HelperError as exc:
            errors.append(exc.message)
        except Exception as exc:  # noqa: BLE001
            errors.append(f"@{name}: {exc}")
        time.sleep(0.3)  # be gentle with t.me
    channels.sort(key=lambda c: (len(c["files"]) == 0, c.get("matchedBy") != "files"))
    return {"query": keyword, "engines": sorted(set(engines)), "channels": channels, "errors": errors}


# ---------------------------------------------------------------------------
# Optional downloads through the user's own Telegram account (Telethon)
# ---------------------------------------------------------------------------

class TelegramDownloader:
    def __init__(self, api_id, api_hash, session):
        try:
            from telethon import TelegramClient  # noqa: WPS433
        except ImportError:
            sys.exit("Downloads need Telethon: pip install telethon")
        self.loop = asyncio.new_event_loop()
        threading.Thread(target=self.loop.run_forever, daemon=True).start()
        self.client = TelegramClient(session, api_id, api_hash, loop=self.loop)

    def _run(self, coro, timeout=None):
        return asyncio.run_coroutine_threadsafe(coro, self.loop).result(timeout)

    def login(self):
        # prompts for phone, login code and 2FA password in this terminal on first run
        self._run(self.client.start())
        me = self._run(self.client.get_me())
        return me.username or me.first_name

    def find_channels(self, keyword, limit=10):
        """Public channels whose name or title matches the keyword (Telegram's own search)."""
        from telethon import functions  # noqa: WPS433

        async def run():
            found = await self.client(functions.contacts.SearchRequest(q=keyword, limit=limit))
            return [chat.username for chat in found.chats
                    if getattr(chat, "username", None)
                    and (getattr(chat, "broadcast", False) or getattr(chat, "megagroup", False))]
        return self._run(run(), timeout=60)

    def channel_files(self, username, keyword="", before=None, limit=50):
        """Same shape as the t.me preview parser, read through the API."""
        from telethon.tl.types import InputMessagesFilterDocument  # noqa: WPS433

        async def run():
            entity = await self.client.get_entity(username)
            messages = await self.client.get_messages(
                entity, limit=limit, search=keyword or None,
                filter=InputMessagesFilterDocument, max_id=before or 0)
            files = []
            for message in messages:
                name = message.file.name if message.file else None
                if not name or not COMIC_RE.search(name):
                    continue
                files.append({
                    "id": message.id, "name": name, "size": message.file.size,
                    "sizeLabel": _format_size(message.file.size),
                    "date": message.date.isoformat() if message.date else None,
                    "caption": (message.message or "")[:280],
                    "url": f"https://t.me/{username}/{message.id}",
                    "protected": bool(getattr(message, "noforwards", False) or getattr(entity, "noforwards", False)),
                })
            return {
                "username": username, "title": getattr(entity, "title", username), "photo": None,
                "preview": False, "source": "telegram", "files": files,
                "oldestId": min((m.id for m in messages), default=None),
            }
        return self._run(run(), timeout=90)

    def _message(self, username, msg_id):
        async def get():
            message = await self.client.get_messages(username, ids=msg_id)
            if not message or not message.document:
                raise HelperError(404, "Message has no file")
            name = message.file.name or f"{username}-{msg_id}"
            if not COMIC_RE.search(name):
                raise HelperError(415, "Not a comic archive")
            if getattr(message, "noforwards", False) or getattr(message.chat, "noforwards", False):
                raise HelperError(403, "This channel protects its content from saving")
            return message, name, message.file.size
        return self._run(get(), timeout=60)

    def stream(self, username, msg_id):
        """Returns (name, size, iterator of byte chunks)."""
        message, name, size = self._message(username, msg_id)
        chunks = queue.Queue(maxsize=16)

        async def pump():
            try:
                async for chunk in self.client.iter_download(message.document):
                    await asyncio.get_running_loop().run_in_executor(None, chunks.put, bytes(chunk))
                chunks.put(None)
            except Exception as exc:  # noqa: BLE001
                chunks.put(exc)

        asyncio.run_coroutine_threadsafe(pump(), self.loop)

        def iterate():
            while True:
                item = chunks.get(timeout=120)
                if item is None:
                    return
                if isinstance(item, Exception):
                    raise item
                yield item

        return name, size, iterate()


# ---------------------------------------------------------------------------
# HTTP server
# ---------------------------------------------------------------------------

def make_handler(allowed_origins, downloader):
    def origin_allowed(origin):
        if not origin:
            return True  # curl / same machine tools
        parsed = urllib.parse.urlparse(origin)
        if parsed.hostname in ("localhost", "127.0.0.1"):
            return True
        return origin in allowed_origins

    class Handler(BaseHTTPRequestHandler):
        server_version = f"tg-finder/{VERSION}"

        def log_message(self, fmt, *args):  # quieter log
            sys.stderr.write("[tg-finder] " + (fmt % args) + "\n")

        def _cors(self):
            origin = self.headers.get("Origin")
            if origin and origin_allowed(origin):
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Vary", "Origin")
                self.send_header("Access-Control-Expose-Headers", "Content-Length, Content-Disposition, X-File-Name")

        def _json(self, status, payload):
            body = json.dumps(payload).encode()
            self.send_response(status)
            self._cors()
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def do_OPTIONS(self):  # noqa: N802 - CORS / Private Network Access preflight
            self.send_response(204)
            self._cors()
            self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Access-Control-Allow-Private-Network", "true")
            self.send_header("Access-Control-Max-Age", "600")
            self.end_headers()

        def do_GET(self):  # noqa: N802
            if not origin_allowed(self.headers.get("Origin")):
                self._json(403, {"error": "Origin not allowed. Start the helper with --allow-origin <url>."})
                return
            url = urllib.parse.urlparse(self.path)
            args = {k: v[0] for k, v in urllib.parse.parse_qs(url.query).items()}
            try:
                if url.path == "/health":
                    self._json(200, {"ok": True, "version": VERSION, "downloads": downloader is not None})
                elif url.path == "/search":
                    extra = [c.strip().lstrip("@") for c in args.get("channels", "").split(",") if c.strip()]
                    self._json(200, search(args.get("q", ""), extra[:20], downloader))
                elif url.path == "/channel":
                    username = args.get("u", "").lstrip("@")
                    before = int(args["before"]) if args.get("before", "").isdigit() else None
                    self._json(200, channel_files(username, args.get("q", ""), before, downloader))
                elif url.path == "/download":
                    self._download(args)
                else:
                    self._json(404, {"error": "Unknown endpoint"})
            except HelperError as exc:
                self._json(exc.status, {"error": exc.message})
            except Exception as exc:  # noqa: BLE001
                self._json(500, {"error": str(exc)})

        def _download(self, args):
            if downloader is None:
                raise HelperError(501, "Downloads are off. Restart the helper with --api-id and --api-hash.")
            username = args.get("u", "").lstrip("@")
            if not USERNAME_RE.match(username) or not args.get("id", "").isdigit():
                raise HelperError(400, "Expected u=<channel>&id=<message id>")
            name, size, chunks = downloader.stream(username, int(args["id"]))
            self.send_response(200)
            self._cors()
            self.send_header("Content-Type", "application/octet-stream")
            if size:
                self.send_header("Content-Length", str(size))
            quoted = urllib.parse.quote(name)
            self.send_header("Content-Disposition", f"attachment; filename*=UTF-8''{quoted}")
            self.send_header("X-File-Name", quoted)
            self.end_headers()
            for chunk in chunks:
                self.wfile.write(chunk)

    return Handler


def main():
    parser = argparse.ArgumentParser(description="Local Telegram search helper for Web Comic Reader")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--allow-origin", action="append", default=[],
                        help="extra web origin allowed to use the helper (default: %s)" % DEFAULT_ORIGINS[0])
    parser.add_argument("--api-id", type=int, help="Telegram API ID from my.telegram.org (enables downloads)")
    parser.add_argument("--api-hash", help="Telegram API hash from my.telegram.org")
    parser.add_argument("--session", default="tg_finder", help="Telethon session file name (default: tg_finder)")
    args = parser.parse_args()

    downloader = None
    if args.api_id or args.api_hash:
        if not (args.api_id and args.api_hash):
            parser.error("--api-id and --api-hash must be used together")
        downloader = TelegramDownloader(args.api_id, args.api_hash, args.session)
        print(f"Logged in to Telegram as {downloader.login()}")

    origins = DEFAULT_ORIGINS + args.allow_origin
    server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(origins, downloader))
    print(f"tg-finder listening on http://127.0.0.1:{args.port}  (downloads {'on' if downloader else 'off'})")
    print("Allowed origins:", ", ".join(origins), "+ localhost")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
