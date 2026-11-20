"""Tests for app.py's API routes. Neither the OCR model nor the LLM is called."""

import pytest
from fastapi.testclient import TestClient

import app as app_module
from summary import SummariseError

PHOTO = ("letter.jpg", b"\xff\xd8\xff fake jpeg bytes", "image/jpeg")

LETTER = "HDB letter: pay $86.40 by 3 March 2026. Call 6490 1111."
RESULT = {
    "summary": "Pay $86.40 by 3 March 2026.",
    "key_details": [{"type": "amount", "text": "$86.40"}],
    "action_required": True,
    "confident": True,
    "unclear_parts": [],
    "missing_details": [],
}


@pytest.fixture
def client(monkeypatch):
    monkeypatch.delenv("ACCESS_TOKEN", raising=False)
    monkeypatch.setattr(app_module, "summary_limiter", app_module.RateLimiter(100, 60))
    monkeypatch.setattr(app_module, "ocr_limiter", app_module.RateLimiter(100, 60))
    monkeypatch.setattr(app_module, "summarise", lambda text: dict(RESULT))
    monkeypatch.setattr(app_module, "extract_text_with_confidence", lambda path: (LETTER, 0.97))
    return TestClient(app_module.app)


# --- body size: checked before the body is read ------------------------------

def test_missing_content_length_is_411(client):
    def chunks():
        yield b'{"text": "'
        yield b'x' * 100 + b'"}'

    res = client.post("/api/summary", content=chunks(), headers={"content-type": "application/json"})
    assert res.status_code == 411


def test_declared_oversize_is_rejected_before_reading(client, monkeypatch):
    def boom(*a, **k):
        raise AssertionError("handler must not run")

    monkeypatch.setattr(app_module, "summarise", boom)
    res = client.post("/api/summary", json={"text": "x" * 250_000})
    assert res.status_code == 413


def test_ocr_oversize_photo_is_413(client):
    big = ("big.jpg", b"\xff\xd8" + b"0" * (app_module.MAX_UPLOAD_BYTES + 100_000), "image/jpeg")
    assert client.post("/api/ocr", files={"file": big}).status_code == 413


# --- access token ------------------------------------------------------------

def test_token_required_when_set(client, monkeypatch):
    monkeypatch.setenv("ACCESS_TOKEN", "s3cret")
    assert client.post("/api/summary", json={"text": LETTER}).status_code == 401
    assert client.post("/api/ocr", files={"file": PHOTO}).status_code == 401
    assert client.post("/api/summary", json={"text": LETTER}, headers={"x-access-token": "nope"}).status_code == 401
    assert client.post("/api/summary", json={"text": LETTER}, headers={"x-access-token": "s3cret"}).status_code == 200
    assert client.post("/api/summary?token=s3cret", json={"text": LETTER}).status_code == 200


def test_opening_page_with_token_sets_cookie_for_api(client, monkeypatch):
    monkeypatch.setenv("ACCESS_TOKEN", "s3cret")
    assert "access_token" not in client.get("/?token=wrong").cookies
    page = client.get("/?token=s3cret")
    assert page.status_code == 200 and page.cookies.get("access_token") == "s3cret"
    assert client.post("/api/summary", json={"text": LETTER}).status_code == 200  # cookie carried


def test_no_token_check_when_unset(client):
    assert client.post("/api/summary", json={"text": LETTER}).status_code == 200


# --- OCR endpoint ------------------------------------------------------------

def test_ocr_returns_text_confidence_and_readable(client):
    body = client.post("/api/ocr", files={"file": PHOTO}).json()
    assert body["text"] == LETTER
    assert body["confidence"] == 0.97
    assert body["readable"] is True


@pytest.mark.parametrize("text,confidence", [("short", 0.99), (LETTER, 0.83), ("", 0.0)])
def test_ocr_unreadable_when_short_or_low_confidence(client, monkeypatch, text, confidence):
    monkeypatch.setattr(app_module, "extract_text_with_confidence", lambda path: (text, confidence))
    assert client.post("/api/ocr", files={"file": PHOTO}).json()["readable"] is False


def test_ocr_is_rate_limited(client, monkeypatch):
    monkeypatch.setattr(app_module, "ocr_limiter", app_module.RateLimiter(1, 60))
    assert client.post("/api/ocr", files={"file": PHOTO}).status_code == 200
    assert client.post("/api/ocr", files={"file": PHOTO}).status_code == 429


def test_ocr_cross_origin_is_403(client):
    res = client.post("/api/ocr", files={"file": PHOTO}, headers={"origin": "http://evil.example"})
    assert res.status_code == 403


def test_success_returns_summary_and_seconds(client):
    res = client.post("/api/summary", json={"text": LETTER})
    assert res.status_code == 200
    body = res.json()
    assert body["summary"] == RESULT["summary"]
    assert body["confident"] is True
    assert isinstance(body["seconds"], float)


@pytest.mark.parametrize("payload", [b"not json", b'{"nope": 1}', b"[]"])
def test_bad_body_is_400(client, payload):
    res = client.post("/api/summary", content=payload, headers={"content-type": "application/json"})
    assert res.status_code == 400


def test_oversize_body_is_413(client):
    res = client.post("/api/summary", json={"text": "x" * 250_000})
    assert res.status_code == 413


def test_wrong_method_is_405(client):
    assert client.get("/api/summary").status_code == 405


def test_cross_origin_is_403_same_origin_ok(client):
    bad = client.post("/api/summary", json={"text": LETTER}, headers={"origin": "http://evil.example"})
    assert bad.status_code == 403
    ok = client.post("/api/summary", json={"text": LETTER}, headers={"origin": "http://testserver"})
    assert ok.status_code == 200


def test_bad_input_keeps_its_message(client, monkeypatch):
    def fail(text):
        raise SummariseError("bad_input", "Letter text is empty or too short.")

    monkeypatch.setattr(app_module, "summarise", fail)
    res = client.post("/api/summary", json={"text": "hi"})
    assert res.status_code == 400
    assert res.json()["detail"] == "Letter text is empty or too short."


@pytest.mark.parametrize("code,status", [("model_failed", 502), ("no_key", 500), ("weird", 500)])
def test_errors_are_generic_and_logged(client, monkeypatch, caplog, code, status):
    def fail(text):
        raise SummariseError(code, "SECRET sk-123", detail="upstream SECRET body")

    monkeypatch.setattr(app_module, "summarise", fail)
    res = client.post("/api/summary", json={"text": LETTER})
    assert res.status_code == status
    assert "SECRET" not in res.text and "sk-123" not in res.text
    assert "upstream SECRET body" in caplog.text


def test_unexpected_exception_is_generic_500(client, monkeypatch):
    def crash(text):
        raise RuntimeError("SECRET internals")

    monkeypatch.setattr(app_module, "summarise", crash)
    res = client.post("/api/summary", json={"text": LETTER})
    assert res.status_code == 500
    assert "SECRET" not in res.text


def test_rate_limit_returns_429_then_resets(client, monkeypatch):
    clock = [0.0]
    monkeypatch.setattr(app_module, "summary_limiter", app_module.RateLimiter(2, 60, now=lambda: clock[0]))
    assert client.post("/api/summary", json={"text": LETTER}).status_code == 200
    assert client.post("/api/summary", json={"text": LETTER}).status_code == 200
    res = client.post("/api/summary", json={"text": LETTER})
    assert res.status_code == 429
    assert int(res.headers["retry-after"]) > 0
    clock[0] = 61.0
    assert client.post("/api/summary", json={"text": LETTER}).status_code == 200


def test_index_still_served(client):
    res = client.get("/")
    assert res.status_code == 200
    assert "summary-card" in res.text
