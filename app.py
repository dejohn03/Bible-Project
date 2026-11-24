"""Stillword - a quiet place to read the Bible.

A small Flask application that serves a reading interface and proxies passage
requests to bible-api.com.

Two things this module is deliberate about:

* Caching. Bible text never changes, so every passage is cached in memory after
  the first successful fetch. Without this, browsing ten chapters costs ten
  upstream calls, and the shared public service throttles quickly.
* Honest errors. bible-api.com answers throttling with ``429`` and a plain-text
  body. Mapping that to "passage not found" tells a reader their passage does
  not exist, which is wrong. Busy and missing are reported separately.
"""

from __future__ import annotations

import json
import os
import threading
import time
from collections import OrderedDict
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen

from flask import Flask, Response, jsonify, render_template, request

# Assets live in public/ because Vercel serves that directory from its CDN and
# explicitly does not support Flask's default static folder. An empty
# static_url_path keeps url_for("static", ...) emitting /styles.css, which is
# the same URL locally and on Vercel.
app = Flask(__name__, static_folder="public", static_url_path="")

BIBLE_API_BASE = "https://bible-api.com"
SUPPORTED_TRANSLATIONS = {"kjv", "web"}
USER_AGENT = "StillwordBibleReader/1.0 (+https://github.com/dejohn03/Bible-Project)"

UPSTREAM_TIMEOUT = 12  # seconds allowed for a single attempt
UPSTREAM_ATTEMPTS = 3  # total attempts, including the first
RETRY_BACKOFF = (0.4, 1.2)  # pause before attempt 2, then attempt 3

CACHE_TTL = 6 * 60 * 60  # six hours; the text is immutable in practice
CACHE_MAX_ENTRIES = 512

CACHE_CONTROL = "public, max-age=3600"

SEARCH_MIN_LENGTH = 2
SEARCH_MAX_LENGTH = 100
SEARCH_RESULT_LIMIT = 200
SEARCH_DATA_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "kjv.json")

# The icon is kept here rather than read from public/favicon.svg. Vercel serves
# public/ from its CDN and leaves it out of the function bundle, so reading the
# file from disk works locally but returns 404 in production.
FAVICON_SVG = (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" role="img"'
    ' aria-label="Stillword">'
    '<rect width="32" height="32" rx="7" fill="#101010"/>'
    '<g stroke="#d6b879" stroke-width="2.6" stroke-linecap="round">'
    '<path d="M16 6.5v19"/><path d="M6.5 16h19"/>'
    '<path d="M9.3 9.3l13.4 13.4"/><path d="M22.7 9.3L9.3 22.7"/>'
    "</g></svg>"
)

CONTENT_SECURITY_POLICY = "; ".join(
    (
        "default-src 'self'",
        "base-uri 'none'",
        "form-action 'self'",
        "frame-ancestors 'none'",
        "img-src 'self' data:",
        "script-src 'self'",
        "style-src 'self' https://fonts.googleapis.com",
        "font-src https://fonts.gstatic.com",
        "connect-src 'self'",
    )
)

BUSY_MESSAGE = "The Bible text service is busy right now. Please try again in a moment."
UNAVAILABLE_MESSAGE = "The Bible text service is temporarily unavailable. Please try again."
MISSING_MESSAGE = "The Bible service could not find that passage."


class UpstreamError(Exception):
    """An upstream failure that the reader should be told about honestly."""

    def __init__(self, message, status=502, retry_after=None):
        super().__init__(message)
        self.message = message
        self.status = status
        self.retry_after = retry_after


class PassageCache:
    """A small thread-safe LRU cache with a time limit per entry.

    Gunicorn runs several worker processes, so each worker keeps its own cache.
    That is fine for a read-only dataset like this: a warm cache is a bonus, not
    a correctness requirement. Swap in Redis if you ever need it shared.
    """

    def __init__(self, ttl=CACHE_TTL, max_entries=CACHE_MAX_ENTRIES):
        self._ttl = ttl
        self._max_entries = max_entries
        self._lock = threading.Lock()
        self._entries: OrderedDict = OrderedDict()

    def get(self, key):
        with self._lock:
            entry = self._entries.get(key)
            if entry is None:
                return None
            expires_at, value = entry
            if expires_at <= time.monotonic():
                self._entries.pop(key, None)
                return None
            self._entries.move_to_end(key)
            return value

    def set(self, key, value):
        with self._lock:
            self._entries[key] = (time.monotonic() + self._ttl, value)
            self._entries.move_to_end(key)
            while len(self._entries) > self._max_entries:
                self._entries.popitem(last=False)

    def clear(self):
        with self._lock:
            self._entries.clear()

    def __len__(self):
        with self._lock:
            return len(self._entries)


cache = PassageCache()


def _normalise_reference(reference):
    """Collapse spacing and case so 'john 3:16' and 'John  3:16' share a cache slot."""
    return " ".join(reference.lower().split())


def _retry_pause(attempt):
    """Seconds to wait before the next attempt, never past the last backoff step."""
    return RETRY_BACKOFF[min(attempt, len(RETRY_BACKOFF) - 1)]


def fetch_upstream(reference, translation):
    """Fetch a passage from bible-api.com, retrying while the service is busy.

    Raises UpstreamError for anything the reader should see, so the route never
    has to guess what went wrong.
    """
    url = f"{BIBLE_API_BASE}/{quote(reference, safe='')}?" + urlencode({"translation": translation})
    last_status = None

    for attempt in range(UPSTREAM_ATTEMPTS):
        api_request = Request(
            url,
            headers={"Accept": "application/json", "User-Agent": USER_AGENT},
        )
        try:
            with urlopen(api_request, timeout=UPSTREAM_TIMEOUT) as response:
                return json.loads(response.read().decode("utf-8"))
        except HTTPError as error:
            # Retry throttling and server faults. A missing passage is final.
            if error.code == 429 or 500 <= error.code < 600:
                last_status = error.code
                if attempt + 1 < UPSTREAM_ATTEMPTS:
                    time.sleep(_retry_pause(attempt))
                    continue
                break
            # A bad reference comes back as 400 and a missing one as 404. Both
            # mean "no such passage", which the page turns into a search rather
            # than telling the reader the service is broken.
            if error.code in (400, 404):
                raise UpstreamError(MISSING_MESSAGE, status=404) from error
            raise UpstreamError(UNAVAILABLE_MESSAGE, status=502) from error
        except (URLError, TimeoutError) as error:
            last_status = None
            if attempt + 1 < UPSTREAM_ATTEMPTS:
                time.sleep(_retry_pause(attempt))
                continue
            raise UpstreamError(UNAVAILABLE_MESSAGE, status=502) from error
        except (ValueError, UnicodeDecodeError) as error:
            raise UpstreamError(
                "The Bible service returned an unreadable response.", status=502
            ) from error

    if last_status == 429:
        raise UpstreamError(BUSY_MESSAGE, status=503, retry_after="10")
    raise UpstreamError(UNAVAILABLE_MESSAGE, status=502)


@app.get("/")
def home():
    return render_template("index.html")


@app.get("/api/passage")
def get_passage():
    """Return a Bible passage as JSON, from the cache when possible."""
    reference = request.args.get("reference", "").strip()
    translation = request.args.get("translation", "kjv").strip().lower()

    if not reference:
        return jsonify({"error": "Please provide a Bible passage reference."}), 400

    if len(reference) > 100:
        return jsonify({"error": "That passage reference is too long."}), 400

    if translation not in SUPPORTED_TRANSLATIONS:
        return jsonify({"error": "Choose KJV or WEB as the translation."}), 400

    cache_key = (translation, _normalise_reference(reference))
    cached = cache.get(cache_key)
    if cached is not None:
        response = jsonify(cached)
        response.headers["X-Cache"] = "HIT"
        response.headers["Cache-Control"] = CACHE_CONTROL
        return response

    try:
        data = fetch_upstream(reference, translation)
    except UpstreamError as error:
        response = jsonify({"error": error.message})
        response.status_code = error.status
        if error.retry_after:
            response.headers["Retry-After"] = error.retry_after
        return response

    if not isinstance(data, dict) or not isinstance(data.get("verses"), list):
        response = jsonify({"error": "The Bible service returned an unexpected response."})
        response.status_code = 502
        return response

    cache.set(cache_key, data)
    response = jsonify(data)
    response.headers["X-Cache"] = "MISS"
    response.headers["Cache-Control"] = CACHE_CONTROL
    return response


_search_index = None
_search_index_lock = threading.Lock()


def _load_search_index():
    """Load the bundled KJV text once per process.

    bible-api.com has no search endpoint and rejects multi-chapter ranges, so
    searching through it would cost one request per chapter. The King James text
    is public domain, so it ships with the app instead: searching is instant and
    never touches the network.
    """
    global _search_index
    if _search_index is not None:
        return _search_index
    with _search_index_lock:
        if _search_index is not None:
            return _search_index
        with open(SEARCH_DATA_PATH, encoding="utf-8") as handle:
            payload = json.load(handle)
        records = []
        for book in payload["books"]:
            name = book["name"]
            for chapter_number, verses in enumerate(book["chapters"], start=1):
                for verse_number, text in enumerate(verses, start=1):
                    records.append(
                        (
                            f"{name} {chapter_number}:{verse_number}",
                            name,
                            chapter_number,
                            verse_number,
                            text,
                            text.lower(),
                        )
                    )
        _search_index = records
        return _search_index


def search_bible(term, limit=SEARCH_RESULT_LIMIT):
    """Return every verse containing ``term``, capped at ``limit`` results.

    ``total`` counts all matches so the reader can be told how many exist even
    when only the first page is shown.
    """
    needle = term.lower()
    total = 0
    results = []
    for reference, book, chapter, verse, text, lowered in _load_search_index():
        if needle in lowered:
            total += 1
            if len(results) < limit:
                results.append(
                    {
                        "reference": reference,
                        "book": book,
                        "chapter": chapter,
                        "verse": verse,
                        "text": text,
                    }
                )
    return total, results


@app.get("/api/search")
def api_search():
    """Search the whole Bible for a word or phrase.

    Results carry the King James text. Opening one loads the chapter in whichever
    translation the reader has selected.
    """
    query = request.args.get("q", "").strip()

    if len(query) < SEARCH_MIN_LENGTH:
        return jsonify({"error": "Search for at least two characters."}), 400

    if len(query) > SEARCH_MAX_LENGTH:
        return jsonify({"error": "That search term is too long."}), 400

    total, results = search_bible(query)
    response = jsonify(
        {
            "query": query,
            "translation": "kjv",
            "total": total,
            "shown": len(results),
            "results": results,
        }
    )
    response.headers["Cache-Control"] = "public, max-age=600"
    return response


@app.get("/health")
def health():
    """A small endpoint that hosting services can use to check the app."""
    return jsonify({"status": "ok"})


@app.get("/favicon.ico")
def favicon():
    """Answer the browser's default icon request so it is not a 404."""
    return Response(FAVICON_SVG, mimetype="image/svg+xml")


@app.after_request
def add_security_headers(response):
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("Permissions-Policy", "geolocation=(), microphone=(), camera=()")
    response.headers.setdefault("Content-Security-Policy", CONTENT_SECURITY_POLICY)
    return response


@app.errorhandler(404)
def handle_not_found(_error):
    if request.path.startswith("/api/"):
        return jsonify({"error": "That endpoint does not exist."}), 404
    return render_template("404.html"), 404


@app.errorhandler(500)
def handle_server_error(_error):
    if request.path.startswith("/api/"):
        return jsonify({"error": "Something went wrong on our side."}), 500
    return render_template("500.html"), 500


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5000"))
    app.run(host="0.0.0.0", port=port, debug=False)
