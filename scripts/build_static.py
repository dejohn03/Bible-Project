"""Build the static site that GitHub Pages serves.

GitHub Pages cannot run Flask, so the page is rendered once here and the three
API endpoints move into the browser (see public/static-api.js). The Flask app
keeps working exactly as before; this only produces a snapshot it can also run
without.

Run with: python scripts/build_static.py
"""

from __future__ import annotations

import gzip
import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "_site"
ASSETS = ("styles.css", "app.js", "static-api.js", "favicon.svg")


def build() -> Path:
    if OUT.exists():
        shutil.rmtree(OUT)
    (OUT / "data").mkdir(parents=True)

    sys.path.insert(0, str(ROOT))
    import app as stillword

    stillword.app.config.update(TESTING=True)
    with stillword.app.test_client() as client:
        html = client.get("/").get_data(as_text=True)

    # Pages serves the project from a subpath, so every asset reference has to be
    # relative, and the browser-side API must load before the app itself.
    for asset in ("styles.css", "app.js", "favicon.svg"):
        html = html.replace('"/' + asset + '"', '"' + asset + '"')
    html = html.replace(
        '<script src="app.js" defer></script>',
        '<script src="static-api.js" defer></script>\n  <script src="app.js" defer></script>',
    )

    (OUT / "index.html").write_text(html, encoding="utf-8")

    for name in ASSETS:
        shutil.copy2(ROOT / "public" / name, OUT / name)

    # The search index and the dictionary ship as plain JSON: Pages gzips them on
    # the wire, and the browser needs no decompression step to read them.
    shutil.copy2(ROOT / "data" / "kjv.json", OUT / "data" / "kjv.json")
    with gzip.open(ROOT / "data" / "dictionary.json.gz", "rt", encoding="utf-8") as handle:
        dictionary = json.load(handle)
    (OUT / "data" / "dictionary.json").write_text(
        json.dumps(dictionary, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
    )

    return OUT


if __name__ == "__main__":
    built = build()
    print("built", built)
