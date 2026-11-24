# Stillword

A quiet, comfortable place to read the Bible in the browser. Search a passage by
reference, browse all 66 books, and read in the King James Version or the World
English Bible.

Passage text comes from [bible-api.com](https://bible-api.com/). Both translations
are public domain.

## How it works

The browser never talks to the Bible service directly. Flask sits in the middle:

```
browser  ->  Flask (/api/passage)  ->  bible-api.com
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
| `static/app.js` | Book list, navigation, search, verse rendering |
| `static/styles.css` | All styling (dark theme) |
| `static/favicon.svg` | Site icon |
| `tests/test_app.py` | Test suite |
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

### `GET /health`

Returns `{"status": "ok"}`. Used by the hosting health check.

## Notes on caching

Bible text does not change, so a successful passage is cached in memory for six
hours, with the 512 most recently used passages kept. Gunicorn runs multiple
worker processes, so each worker keeps its own cache. That is fine here: a warm
cache is a speed bonus, not a correctness requirement. Move to Redis if you ever
need the cache shared across workers or instances.

## Deploying to Render

`render.yaml` describes the service. Push to `main` and Render redeploys:

```bash
gunicorn app:app --workers 2 --threads 4 --timeout 30
```

## License

MIT. See [LICENSE](LICENSE).
