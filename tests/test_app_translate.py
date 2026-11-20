"""Tests for POST /api/translate and the OCR -> summary -> translate chain.
Neither the OCR model nor the LLM is called."""

import pytest
from fastapi.testclient import TestClient

import app as app_module
from translate import TranslateError

PHOTO = ("letter.jpg", b"\xff\xd8\xff fake jpeg bytes", "image/jpeg")
LETTER = "HDB letter: pay $86.40 by 3 March 2026. Call 6490 1111."
SUMMARY = {
    "summary": "Pay $86.40 by 3 March 2026.",
    "key_details": [],
    "action_required": True,
    "confident": True,
    "unclear_parts": [],
    "missing_details": [],
}
TRANSLATION = {"text": "请在2026年3月3日之前付86.40元。", "confident": True, "missing_details": []}


@pytest.fixture
def client(monkeypatch):
    monkeypatch.delenv("ACCESS_TOKEN", raising=False)
    for name in ("summary_limiter", "translate_limiter", "ocr_limiter"):
        monkeypatch.setattr(app_module, name, app_module.RateLimiter(100, 60))
    monkeypatch.setattr(app_module, "extract_text_with_confidence", lambda path: (LETTER, 0.97))
    monkeypatch.setattr(app_module, "summarise", lambda text: dict(SUMMARY))
    monkeypatch.setattr(app_module, "translate", lambda text: dict(TRANSLATION))
    return TestClient(app_module.app)


def test_photo_to_summary_to_translation(client, monkeypatch):
    """What the phone does: each step's output is the next step's input."""
    seen = {}

    def fake_summarise(text):
        seen["summarise"] = text
        return dict(SUMMARY)

    def fake_translate(text):
        seen["translate"] = text
        return dict(TRANSLATION)

    monkeypatch.setattr(app_module, "summarise", fake_summarise)
    monkeypatch.setattr(app_module, "translate", fake_translate)

    ocr = client.post("/api/ocr", files={"file": PHOTO}).json()
    summary = client.post("/api/summary", json={"text": ocr["text"]}).json()
    translation = client.post("/api/translate", json={"text": summary["summary"]}).json()

    assert seen == {"summarise": LETTER, "translate": SUMMARY["summary"]}
    assert translation["text"] == TRANSLATION["text"]
    assert translation["confident"] is True
    assert isinstance(translation["seconds"], float)


def test_not_confident_is_passed_through(client, monkeypatch):
    monkeypatch.setattr(
        app_module, "translate",
        lambda text: {"text": "x", "confident": False, "missing_details": ["86.40"]},
    )
    body = client.post("/api/translate", json={"text": SUMMARY["summary"]}).json()
    assert body["confident"] is False and body["missing_details"] == ["86.40"]


@pytest.mark.parametrize("payload", [b"not json", b'{"nope": 1}', b"[]"])
def test_bad_body_is_400(client, payload):
    res = client.post("/api/translate", content=payload, headers={"content-type": "application/json"})
    assert res.status_code == 400


def test_oversize_body_is_413(client):
    assert client.post("/api/translate", json={"text": "x" * 250_000}).status_code == 413


def test_cross_origin_is_403(client):
    res = client.post("/api/translate", json={"text": "hi"}, headers={"origin": "http://evil.example"})
    assert res.status_code == 403


def test_token_required_when_set(client, monkeypatch):
    monkeypatch.setenv("ACCESS_TOKEN", "s3cret")
    assert client.post("/api/translate", json={"text": "hi"}).status_code == 401
    assert client.post("/api/translate", json={"text": "hi"}, headers={"x-access-token": "s3cret"}).status_code == 200


def test_is_rate_limited(client, monkeypatch):
    monkeypatch.setattr(app_module, "translate_limiter", app_module.RateLimiter(1, 60))
    assert client.post("/api/translate", json={"text": "hi"}).status_code == 200
    assert client.post("/api/translate", json={"text": "hi"}).status_code == 429


def test_bad_input_keeps_its_message(client, monkeypatch):
    def fail(text):
        raise TranslateError("bad_input", "There is no text to translate.")

    monkeypatch.setattr(app_module, "translate", fail)
    res = client.post("/api/translate", json={"text": " "})
    assert res.status_code == 400 and res.json()["detail"] == "There is no text to translate."


@pytest.mark.parametrize("code,status", [("model_failed", 502), ("no_key", 500), ("weird", 500)])
def test_errors_are_generic_and_logged(client, monkeypatch, caplog, code, status):
    def fail(text):
        raise TranslateError(code, "SECRET sk-123", detail="upstream SECRET body")

    monkeypatch.setattr(app_module, "translate", fail)
    res = client.post("/api/translate", json={"text": "hi"})
    assert res.status_code == status
    assert "SECRET" not in res.text and "sk-123" not in res.text
    assert "upstream SECRET body" in caplog.text


def test_unexpected_exception_is_generic_500(client, monkeypatch):
    def crash(text):
        raise RuntimeError("SECRET internals")

    monkeypatch.setattr(app_module, "translate", crash)
    res = client.post("/api/translate", json={"text": "hi"})
    assert res.status_code == 500 and "SECRET" not in res.text


def test_page_has_translation_card(client):
    assert "translation-card" in client.get("/").text
