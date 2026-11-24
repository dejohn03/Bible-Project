"""Tests for the Stillword Flask app.

The upstream Bible service is always faked here. Tests must never depend on the
network, and they must never consume the shared public service's rate limit.
"""

import io
import json
from urllib.error import HTTPError, URLError

import pytest

import app as app_module


@pytest.fixture()
def client():
    app_module.app.config.update(TESTING=True)
    app_module.cache.clear()
    with app_module.app.test_client() as test_client:
        yield test_client
    app_module.cache.clear()


@pytest.fixture()
def passage_payload():
    return {
        "reference": "John 3:16",
        "translation_id": "kjv",
        "translation_name": "King James Version",
        "verses": [
            {
                "book_name": "John",
                "chapter": 3,
                "verse": 16,
                "text": "For God so loved the world.",
            }
        ],
    }


@pytest.fixture()
def fake_upstream(monkeypatch, passage_payload):
    """Replace the network fetch and record how often it was called."""
    calls = []

    def fake_fetch(reference, translation):
        calls.append((reference, translation))
        return passage_payload

    monkeypatch.setattr(app_module, "fetch_upstream", fake_fetch)
    return calls


class FakeResponse:
    def __init__(self, payload):
        self._payload = json.dumps(payload).encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, *exc_info):
        return False

    def read(self):
        return self._payload


def http_error(request, code, body=b""):
    return HTTPError(request.full_url, code, "error", {}, io.BytesIO(body))


# --------------------------------------------------------------------------
# Basic routes
# --------------------------------------------------------------------------


def test_health_returns_ok(client):
    response = client.get("/health")
    assert response.status_code == 200
    assert response.get_json() == {"status": "ok"}


def test_home_page_renders(client):
    response = client.get("/")
    assert response.status_code == 200
    body = response.get_data(as_text=True)
    assert "Stillword" in body
    assert 'content="#101010"' in body


def test_favicon_is_served(client):
    response = client.get("/favicon.ico")
    assert response.status_code == 200
    assert "svg" in response.headers["Content-Type"]


# --------------------------------------------------------------------------
# Request validation
# --------------------------------------------------------------------------


def test_missing_reference_is_rejected(client):
    response = client.get("/api/passage")
    assert response.status_code == 400
    assert "reference" in response.get_json()["error"].lower()


def test_overlong_reference_is_rejected(client):
    response = client.get("/api/passage", query_string={"reference": "a" * 101})
    assert response.status_code == 400
    assert "too long" in response.get_json()["error"].lower()


def test_unsupported_translation_is_rejected(client):
    response = client.get(
        "/api/passage", query_string={"reference": "John 3:16", "translation": "niv"}
    )
    assert response.status_code == 400
    assert "KJV or WEB" in response.get_json()["error"]


# --------------------------------------------------------------------------
# Successful passages and caching
# --------------------------------------------------------------------------


def test_passage_is_returned(client, fake_upstream):
    response = client.get(
        "/api/passage", query_string={"reference": "John 3:16", "translation": "kjv"}
    )
    assert response.status_code == 200
    assert response.get_json()["reference"] == "John 3:16"
    assert fake_upstream == [("John 3:16", "kjv")]


def test_repeated_passage_is_served_from_cache(client, fake_upstream):
    query = {"reference": "John 3:16", "translation": "kjv"}

    first = client.get("/api/passage", query_string=query)
    second = client.get("/api/passage", query_string=query)

    assert first.headers["X-Cache"] == "MISS"
    assert second.headers["X-Cache"] == "HIT"
    assert len(fake_upstream) == 1, "the upstream must be called only once"


def test_cache_key_ignores_spacing_and_case(client, fake_upstream):
    client.get("/api/passage", query_string={"reference": "John 3:16"})
    client.get("/api/passage", query_string={"reference": "  john   3:16  "})
    assert len(fake_upstream) == 1


def test_different_translations_are_cached_separately(client, fake_upstream):
    client.get("/api/passage", query_string={"reference": "John 3:16", "translation": "kjv"})
    client.get("/api/passage", query_string={"reference": "John 3:16", "translation": "web"})
    assert len(fake_upstream) == 2


def test_cache_respects_its_size_limit():
    small = app_module.PassageCache(ttl=60, max_entries=2)
    small.set("a", 1)
    small.set("b", 2)
    small.set("c", 3)
    assert len(small) == 2
    assert small.get("a") is None, "the oldest entry should be evicted"


def test_cache_expires_entries():
    expiring = app_module.PassageCache(ttl=-1, max_entries=4)
    expiring.set("a", 1)
    assert expiring.get("a") is None


# --------------------------------------------------------------------------
# Error mapping: busy is not the same as missing
# --------------------------------------------------------------------------


def test_upstream_not_found_is_a_404(client, monkeypatch):
    def raise_missing(reference, translation):
        raise app_module.UpstreamError(app_module.MISSING_MESSAGE, status=404)

    monkeypatch.setattr(app_module, "fetch_upstream", raise_missing)
    response = client.get("/api/passage", query_string={"reference": "Zzz 1"})

    assert response.status_code == 404
    assert "could not find" in response.get_json()["error"].lower()


def test_busy_upstream_is_a_503_with_retry_after(client, monkeypatch):
    def raise_busy(reference, translation):
        raise app_module.UpstreamError(app_module.BUSY_MESSAGE, status=503, retry_after="10")

    monkeypatch.setattr(app_module, "fetch_upstream", raise_busy)
    response = client.get("/api/passage", query_string={"reference": "John 3:16"})

    assert response.status_code == 503
    assert response.headers["Retry-After"] == "10"
    assert "busy" in response.get_json()["error"].lower()


def test_unavailable_upstream_is_a_502(client, monkeypatch):
    def raise_down(reference, translation):
        raise app_module.UpstreamError(app_module.UNAVAILABLE_MESSAGE, status=502)

    monkeypatch.setattr(app_module, "fetch_upstream", raise_down)
    response = client.get("/api/passage", query_string={"reference": "John 3:16"})

    assert response.status_code == 502


def test_unexpected_payload_is_a_502(client, monkeypatch):
    monkeypatch.setattr(app_module, "fetch_upstream", lambda reference, translation: {})
    response = client.get("/api/passage", query_string={"reference": "John 3:16"})
    assert response.status_code == 502


# --------------------------------------------------------------------------
# Retry behaviour inside fetch_upstream
# --------------------------------------------------------------------------


def test_fetch_upstream_retries_then_succeeds(monkeypatch, passage_payload):
    calls = {"count": 0}

    def fake_urlopen(request, timeout=0):
        calls["count"] += 1
        if calls["count"] == 1:
            raise http_error(request, 429, b"Retry later")
        return FakeResponse(passage_payload)

    monkeypatch.setattr(app_module, "urlopen", fake_urlopen)
    monkeypatch.setattr(app_module.time, "sleep", lambda seconds: None)

    data = app_module.fetch_upstream("John 3:16", "kjv")

    assert data["reference"] == "John 3:16"
    assert calls["count"] == 2


def test_fetch_upstream_reports_busy_after_exhausting_retries(monkeypatch):
    calls = {"count": 0}

    def always_throttled(request, timeout=0):
        calls["count"] += 1
        raise http_error(request, 429, b"Retry later")

    monkeypatch.setattr(app_module, "urlopen", always_throttled)
    monkeypatch.setattr(app_module.time, "sleep", lambda seconds: None)

    with pytest.raises(app_module.UpstreamError) as excinfo:
        app_module.fetch_upstream("John 3:16", "kjv")

    assert calls["count"] == app_module.UPSTREAM_ATTEMPTS
    assert excinfo.value.status == 503
    assert excinfo.value.retry_after == "10"


def test_fetch_upstream_does_not_retry_a_missing_passage(monkeypatch):
    calls = {"count": 0}

    def missing(request, timeout=0):
        calls["count"] += 1
        raise http_error(request, 404, b'{"error": "not found"}')

    monkeypatch.setattr(app_module, "urlopen", missing)
    monkeypatch.setattr(app_module.time, "sleep", lambda seconds: None)

    with pytest.raises(app_module.UpstreamError) as excinfo:
        app_module.fetch_upstream("Zzz 1", "kjv")

    assert calls["count"] == 1
    assert excinfo.value.status == 404


def test_fetch_upstream_handles_a_network_failure(monkeypatch):
    def offline(request, timeout=0):
        raise URLError("no route to host")

    monkeypatch.setattr(app_module, "urlopen", offline)
    monkeypatch.setattr(app_module.time, "sleep", lambda seconds: None)

    with pytest.raises(app_module.UpstreamError) as excinfo:
        app_module.fetch_upstream("John 3:16", "kjv")

    assert excinfo.value.status == 502


# --------------------------------------------------------------------------
# Headers and error pages
# --------------------------------------------------------------------------


def test_security_headers_are_present(client):
    response = client.get("/")
    assert response.headers["X-Content-Type-Options"] == "nosniff"
    assert response.headers["X-Frame-Options"] == "DENY"
    assert "Content-Security-Policy" in response.headers
    assert "default-src 'self'" in response.headers["Content-Security-Policy"]


def test_unknown_api_route_returns_json(client):
    response = client.get("/api/nope")
    assert response.status_code == 404
    assert "error" in response.get_json()


def test_unknown_page_returns_the_html_error_page(client):
    response = client.get("/no-such-page")
    assert response.status_code == 404
    assert "not in the book" in response.get_data(as_text=True)


# --------------------------------------------------------------------------
# Whole-Bible search
# --------------------------------------------------------------------------


def test_search_rejects_a_term_that_is_too_short(client):
    response = client.get("/api/search?q=a")
    assert response.status_code == 400
    assert "error" in response.get_json()


def test_search_rejects_an_overlong_term(client):
    response = client.get("/api/search?q=" + "a" * 101)
    assert response.status_code == 400


def test_search_finds_a_known_verse(client):
    response = client.get("/api/search?q=shepherd")
    assert response.status_code == 200
    data = response.get_json()
    assert data["total"] > 0
    assert "Psalms 23:1" in [result["reference"] for result in data["results"]]


def test_search_results_carry_the_fields_the_page_needs(client):
    data = client.get("/api/search?q=shepherd").get_json()
    result = data["results"][0]
    for field in ("reference", "book", "chapter", "verse", "text"):
        assert field in result
    assert data["translation"] == "kjv"


def test_search_is_case_insensitive(client):
    lower = client.get("/api/search?q=shepherd").get_json()
    upper = client.get("/api/search?q=SHEPHERD").get_json()
    assert lower["total"] == upper["total"]
    assert lower["total"] > 0


def test_search_reports_no_matches_for_nonsense(client):
    data = client.get("/api/search?q=zzzzqqqqxx").get_json()
    assert data["total"] == 0
    assert data["results"] == []


def test_search_caps_results_but_reports_the_true_total(client):
    data = client.get("/api/search?q=the").get_json()
    assert data["total"] > app_module.SEARCH_RESULT_LIMIT
    assert data["shown"] == app_module.SEARCH_RESULT_LIMIT
    assert len(data["results"]) == app_module.SEARCH_RESULT_LIMIT


def test_search_covers_the_whole_bible_not_one_chapter(client):
    """The old keyword search only looked at the chapter on screen."""
    data = client.get("/api/search?q=shepherd").get_json()
    books = {result["book"] for result in data["results"]}
    assert len(books) > 1


def test_upstream_bad_reference_is_treated_as_not_found(client, monkeypatch):
    """bible-api.com answers an impossible reference with 400, not 404.

    Reporting that as "service unavailable" was misleading, and it stopped the
    page from turning the input into a search.
    """

    def raise_bad_request(*args, **kwargs):
        raise HTTPError("https://bible-api.com/x", 400, "Bad Request", None, io.BytesIO(b""))

    monkeypatch.setattr(app_module, "urlopen", raise_bad_request)
    response = client.get("/api/passage", query_string={"reference": "John 99"})

    assert response.status_code == 404
    assert "could not find" in response.get_json()["error"].lower()


def test_phrase_with_one_wrong_word_still_finds_the_verse(client):
    """A reader who says "world" where the verse says "Word" reaches John 1:1."""
    response = client.get(
        "/api/search",
        query_string={"q": "in the beginning was the world and the world was with God"},
    )

    assert response.status_code == 200
    data = response.get_json()
    assert data["approximate"] is True
    assert data["results"][0]["reference"] == "John 1:1"
    assert "beginning" in data["matched_words"]


def test_exact_phrase_is_not_labelled_approximate(client):
    response = client.get("/api/search", query_string={"q": "in the beginning was the Word"})

    data = response.get_json()
    assert data["approximate"] is False
    assert "John 1:1" in [result["reference"] for result in data["results"]]


def test_query_of_only_common_words_finds_nothing(client):
    response = client.get("/api/search", query_string={"q": "in the and of"})

    data = response.get_json()
    assert data["total"] == 0
    assert data["approximate"] is False


# --- Names and unfamiliar words -------------------------------------------------


def test_define_explains_a_name(client):
    response = client.get("/api/define", query_string={"term": "Immanuel"})

    data = response.get_json()
    assert response.status_code == 200
    assert data["found"] is True
    assert data["matched_term"] == "Immanuel"
    assert "God with us" in data["meanings"][0]["text"]
    assert data["meanings"][0]["source"] == "Hitchcock's Bible Names"


def test_define_is_case_insensitive(client):
    response = client.get("/api/define", query_string={"term": "immanuel"})

    assert response.get_json()["found"] is True


def test_define_matches_the_start_of_a_longer_name(client):
    response = client.get("/api/define", query_string={"term": "Imman"})

    data = response.get_json()
    assert data["found"] is True
    assert data["matched_term"] == "Immanuel"


def test_define_points_to_verses_that_use_the_word(client):
    response = client.get("/api/define", query_string={"term": "propitiation"})

    data = response.get_json()
    assert data["found"] is True
    references = [result["reference"] for result in data["references"]]
    assert "Romans 3:25" in references


def test_define_matches_whole_words_only(client):
    """A substring match would send "selah" to Methuselah in Genesis."""

    response = client.get("/api/define", query_string={"term": "selah"})

    data = response.get_json()
    assert data["found"] is True
    references = [result["reference"] for result in data["references"]]
    assert references
    assert all("Methuselah" not in result["text"] for result in data["references"])


def test_define_reports_an_unknown_word_without_erroring(client):
    response = client.get("/api/define", query_string={"term": "zzzqqq"})

    data = response.get_json()
    assert response.status_code == 200
    assert data["found"] is False
    assert data["meanings"] == []


def test_define_rejects_a_too_short_term(client):
    response = client.get("/api/define", query_string={"term": "a"})

    assert response.status_code == 400


def test_define_rejects_an_overlong_term(client):
    response = client.get("/api/define", query_string={"term": "a" * 61})

    assert response.status_code == 400


def test_dictionary_ships_with_the_app():
    terms = app_module._load_dictionary()

    assert len(terms) > 4000
    assert "immanuel" in terms
