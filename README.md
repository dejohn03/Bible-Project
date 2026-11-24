# Stillword

A quiet, comfortable place to read the Bible in the browser. Search a passage by
reference, browse all 66 books, and read in the King James Version or the World
English Bible.

Passage text comes from [bible-api.com](https://bible-api.com/). Both translations
are public domain.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/dejohn03/Bible-Project)

## How it works

The browser never talks to the Bible service directly. Flask sits in the middle:

```
browser  ->  Flask (/api/passage)  ->  bible-api.com
browser  ->  Flask (/api/search)   ->  data/kjv.json (bundled)
                  |
                  +-- in-memory cache, retries, honest error messages
```

That indirection is what makes the app pleasant to use. It keeps the upstream
API keyless, lets the server cache passages so repeat reads cost nothing, and
turns an upstream failure into a message a reader can actually understand.

## Project layout

| Path | Purpose |
| --- | --- |
| `app.py` | Flask app: routes, passage cache, upstream fetch and retries |
| `templates/index.html` | The reader page |
| `templates/404.html`, `templates/500.html` | Error pages |
| `public/app.js` | Book list, navigation, search, verse rendering |
| `public/styles.css` | All styling (dark theme) |
| `public/favicon.svg` | Site icon |
| `data/kjv.json` | Public-domain King James text, used for whole-Bible search |
| `tests/test_app.py` | Test suite |
| `pyproject.toml` | Dependencies for Vercel's uv build; mirrors `requirements.txt` |
| `vercel.json` | Vercel function config: timeout and bundle exclusions |
| `render.yaml` | Render deployment blueprint |

## Running locally

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements-dev.txt
python3 app.py
```

Then open <http://localhost:5000>. Set `PORT` to change the port.

## Tests and linting

```bash
pytest
ruff check .
ruff format --check .
```

The test suite fakes the upstream service, so it needs no network and never
consumes the public API's rate limit. CI runs both commands on every push.

## API

### `GET /api/passage`

| Parameter | Required | Default | Notes |
| --- | --- | --- | --- |
| `reference` | yes | | Up to 100 characters, e.g. `John 3:16` |
| `translation` | no | `kjv` | `kjv` or `web` |

Returns the upstream payload, including a `verses` array. Responses carry
`X-Cache: HIT` or `X-Cache: MISS` so you can see whether the cache answered.

```bash
curl "http://localhost:5000/api/passage?reference=John%203:16&translation=kjv"
```

### Status codes

| Code | Meaning |
| --- | --- |
| `200` | Passage returned |
| `400` | Missing, overlong, or unsupported request |
| `404` | The reference does not exist |
| `502` | The Bible service failed or returned something unreadable |
| `503` | The Bible service is busy; check `Retry-After` and try again |

`404` and `503` are deliberately separate. Earlier versions reported a busy
service as "passage not found", which sent readers looking for a mistake in
their own reference.

### `GET /api/search`

Searches every verse of the Bible and returns matches with their references.

```bash
curl "http://localhost:5000/api/search?q=shepherd"
```

```json
{
  "query": "shepherd",
  "translation": "kjv",
  "total": 74,
  "shown": 74,
  "results": [
    { "reference": "Genesis 46:32", "book": "Genesis", "chapter": 46, "verse": 32, "text": "..." }
  ]
}
```

`total` counts every match; `shown` is capped at 200.

The page sends input to this endpoint unless it parses as a reference with a
chapter number, such as `Mark 1` or `John 3:16`. A bare book name like `Mark`
searches for the word instead. If a reference lookup comes back not found, the
page falls back to searching the same text rather than dead-ending. The search index is the
King James Version and is served from `data/kjv.json`, so searching never calls
the upstream API and cannot be rate limited. Opening a result loads that chapter
in whichever translation the reader has selected.

Returns `400` if the term is shorter than two characters or longer than 100.

### `GET /health`

Returns `{"status": "ok"}`. Used by the hosting health check.

## Notes on caching

Bible text does not change, so a successful passage is cached in memory for six
hours, with the 512 most recently used passages kept. Gunicorn runs multiple
worker processes and Vercel runs one function per instance, so each keeps its
own cache. That is fine here: a warm
cache is a speed bonus, not a correctness requirement. Move to Redis if you ever
need the cache shared across workers or instances.

## Deploying

### Vercel

Vercel detects the Flask app in `app.py` and runs it as a single function.
`vercel.json` raises the function timeout to 60 seconds, so a slow upstream
surfaces as our own `503` instead of a platform `504`.

Two things to know:

- Static assets must live in `public/`. Vercel serves that directory from its
  CDN and does not use Flask's static folder. `app.py` points `static_folder` at
  `public` with an empty `static_url_path`, so `url_for("static", ...)` still
  produces `/styles.css` locally and in production.
- The passage cache is per function instance, so it is not shared between
  instances. It still saves upstream calls on warm instances.
- `data/kjv.json` is about 4 MB and must stay inside the function bundle,
  since search reads it from disk. Do not move it into `public/`.

### Render

`render.yaml` describes a Render service. Push to `main` and Render redeploys:

```bash
gunicorn app:app --workers 2 --threads 4 --timeout 30
```

## License

The bundled King James text in `data/kjv.json` is public domain in most
jurisdictions. It remains subject to Crown copyright in the United Kingdom.

MIT. See [LICENSE](LICENSE).
