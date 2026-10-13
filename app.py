import json
import os
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen

from flask import Flask, jsonify, render_template, request

app = Flask(__name__)
BIBLE_API_BASE = "https://bible-api.com"
SUPPORTED_TRANSLATIONS = {"kjv", "web"}


@app.get("/")
def home():
    return render_template("index.html")


@app.get("/api/passage")
def get_passage():
    """Fetch a Bible passage from bible-api.com and return JSON to the browser."""
    reference = request.args.get("reference", "").strip()
    translation = request.args.get("translation", "kjv").strip().lower()

    if not reference:
        return jsonify({"error": "Please provide a Bible passage reference."}), 400

    if len(reference) > 100:
        return jsonify({"error": "That passage reference is too long."}), 400

    if translation not in SUPPORTED_TRANSLATIONS:
        return jsonify({"error": "Choose KJV or WEB as the translation."}), 400

    url = BIBLE_API_BASE + "/" + quote(reference, safe="") + "?" + urlencode(
        {"translation": translation}
    )
    api_request = Request(
        url,
        headers={
            "Accept": "application/json",
            "User-Agent": "StillwordBibleReader/1.0",
        },
    )

    try:
        with urlopen(api_request, timeout=12) as response:
            data = json.loads(response.read().decode("utf-8"))
    except HTTPError as error:
        try:
            details = json.loads(error.read().decode("utf-8"))
            message = details.get("error", "The passage could not be found.")
        except (ValueError, UnicodeDecodeError):
            message = "The Bible service could not find that passage."
        return jsonify({"error": message}), 404
    except (URLError, TimeoutError):
        return jsonify({
            "error": "The Bible text service is temporarily unavailable. Please try again."
        }), 502
    except (ValueError, UnicodeDecodeError):
        return jsonify({"error": "The Bible service returned an unreadable response."}), 502

    if not isinstance(data, dict) or not isinstance(data.get("verses"), list):
        return jsonify({"error": "The Bible service returned an unexpected response."}), 502

    return jsonify(data)


@app.get("/health")
def health():
    """A small endpoint that hosting services can use to check the app."""
    return jsonify({"status": "ok"})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5000"))
    app.run(host="0.0.0.0", port=port, debug=False)
