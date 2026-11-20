"""Tests for POST /api/summary in app.py. The model is never called."""

import pytest
from fastapi.testclient import TestClient

import app as app_module
from summary import SummariseError

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
    monkeypatch.setattr(app_module, "summary_limiter", app_module.RateLimiter(100, 60))
    monkeypatch.setattr(app_module, "summarise", lambda text: dict(RESULT))
    return TestClient(app_module.app)


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
