"""Tests for the Hokkien TTS module and POST /api/tts. The real model is never loaded."""

import io
import wave

import numpy as np
import pytest
from fastapi.testclient import TestClient

import app as app_module
import tts.engine as engine
from tts import TtsError, synthesise, validate

HOKKIEN = "你阿母煮的菜真好食"


class FakeModel:
    sampling_rate = 24_000

    def __init__(self):
        self.calls = []

    def generate(self, **kwargs):
        self.calls.append(kwargs)
        return [np.sin(np.linspace(0, 440, 2400)).astype("float32")]


@pytest.fixture
def fake(monkeypatch):
    model = FakeModel()
    monkeypatch.setattr(engine, "_load_model", lambda: model)
    monkeypatch.setattr(engine, "_voice_prompt", None)
    return model


def test_synthesise_returns_wav_and_asks_for_hokkien(fake):
    data = synthesise(HOKKIEN)
    with wave.open(io.BytesIO(data)) as w:
        assert w.getframerate() == 24_000
        assert w.getnchannels() == 1
        assert w.getnframes() == 2400
    assert fake.calls == [{"text": HOKKIEN, "language": "nan"}]


def test_voice_clone_prompt_is_passed_when_set(fake, monkeypatch):
    monkeypatch.setattr(engine, "_voice_prompt", "PROMPT")
    synthesise(HOKKIEN)
    assert fake.calls[0]["voice_clone_prompt"] == "PROMPT"


def test_loanwords_are_allowed():
    assert validate("  我 suka 食红豆冰  ") == "我 suka 食红豆冰"


@pytest.mark.parametrize(
    "bad",
    ["", "   ", "Please pay $120 by 11 April.", "1234 5678", None, 42, "你" * 1001],
)
def test_bad_input_is_rejected(bad):
    with pytest.raises(TtsError) as err:
        validate(bad)
    assert err.value.code == "bad_input"


def test_missing_dependencies_are_unavailable(monkeypatch):
    monkeypatch.setattr(engine, "_model", None)
    monkeypatch.setitem(__import__("sys").modules, "omnivoice", None)  # makes the import fail
    with pytest.raises(TtsError) as err:
        synthesise(HOKKIEN)
    assert err.value.code == "unavailable"
    assert "pip install" in err.value.detail
    assert "pip install" not in err.value.message


def test_model_failure_is_synthesis_failed(monkeypatch):
    class Broken(FakeModel):
        def generate(self, **kwargs):
            raise RuntimeError("CUDA out of memory SECRET")

    monkeypatch.setattr(engine, "_load_model", lambda: Broken())
    with pytest.raises(TtsError) as err:
        synthesise(HOKKIEN)
    assert err.value.code == "synthesis_failed"
    assert "SECRET" not in err.value.message
    assert "SECRET" in err.value.detail


def test_empty_audio_is_synthesis_failed(monkeypatch):
    class Silent(FakeModel):
        def generate(self, **kwargs):
            return [np.zeros(0, dtype="float32")]

    monkeypatch.setattr(engine, "_load_model", lambda: Silent())
    with pytest.raises(TtsError) as err:
        synthesise(HOKKIEN)
    assert err.value.code == "synthesis_failed"


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(app_module, "tts_limiter", app_module.RateLimiter(100, 60))
    monkeypatch.setattr(app_module, "synthesise", lambda text: b"RIFFfake")
    return TestClient(app_module.app)


def test_endpoint_returns_wav(client):
    res = client.post("/api/tts", json={"text": HOKKIEN})
    assert res.status_code == 200
    assert res.headers["content-type"] == "audio/wav"
    assert res.content == b"RIFFfake"
    assert "x-seconds" in res.headers


@pytest.mark.parametrize("payload", [b"not json", b'{"nope": 1}', b"[]"])
def test_endpoint_bad_body_is_400(client, payload):
    res = client.post("/api/tts", content=payload, headers={"content-type": "application/json"})
    assert res.status_code == 400


def test_endpoint_oversize_body_is_413(client):
    assert client.post("/api/tts", json={"text": "你" * 30_000}).status_code == 413


def test_endpoint_rate_limited(client, monkeypatch):
    monkeypatch.setattr(app_module, "tts_limiter", app_module.RateLimiter(1, 60))
    assert client.post("/api/tts", json={"text": HOKKIEN}).status_code == 200
    assert client.post("/api/tts", json={"text": HOKKIEN}).status_code == 429


def test_endpoint_needs_token_when_set(client, monkeypatch):
    monkeypatch.setenv("ACCESS_TOKEN", "s3cret")
    assert client.post("/api/tts", json={"text": HOKKIEN}).status_code == 401
    ok = client.post("/api/tts", json={"text": HOKKIEN}, headers={"x-access-token": "s3cret"})
    assert ok.status_code == 200


def test_endpoint_wrong_method_is_405(client):
    assert client.get("/api/tts").status_code == 405


def test_endpoint_cross_origin_is_403_same_origin_ok(client):
    bad = client.post("/api/tts", json={"text": HOKKIEN}, headers={"origin": "http://evil.example"})
    assert bad.status_code == 403
    ok = client.post("/api/tts", json={"text": HOKKIEN}, headers={"origin": "http://testserver"})
    assert ok.status_code == 200


def test_endpoint_bad_input_keeps_its_message(client, monkeypatch):
    monkeypatch.setattr(app_module, "synthesise", synthesise)  # real validation, no model needed
    res = client.post("/api/tts", json={"text": "English only"})
    assert res.status_code == 400
    assert res.json()["detail"] == "Text must be Hokkien written in Chinese characters."


@pytest.mark.parametrize("code,status", [("unavailable", 503), ("synthesis_failed", 502), ("weird", 500)])
def test_endpoint_errors_are_generic_and_logged(client, monkeypatch, caplog, code, status):
    def fail(text):
        raise TtsError(code, "SECRET sk-123", detail="internal SECRET detail")

    monkeypatch.setattr(app_module, "synthesise", fail)
    res = client.post("/api/tts", json={"text": HOKKIEN})
    assert res.status_code == status
    assert "SECRET" not in res.text
    assert "internal SECRET detail" in caplog.text


def test_endpoint_unexpected_exception_is_generic_500(client, monkeypatch):
    def crash(text):
        raise RuntimeError("SECRET internals")

    monkeypatch.setattr(app_module, "synthesise", crash)
    res = client.post("/api/tts", json={"text": HOKKIEN})
    assert res.status_code == 500
    assert "SECRET" not in res.text
