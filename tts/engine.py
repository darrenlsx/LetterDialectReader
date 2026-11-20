"""Hokkien text-to-speech: Hokkien written in Chinese characters -> WAV audio.

The public entry point is `synthesise`. Model-specific code lives in `_load_model`
and `_generate`, so another voice or engine can be swapped in without changing
what callers (the web app, the CLI, the translation step) use.

Model: MERaLiON/MERaLiON-OmniVoice-Hokkien-TTS (about 2.7 GB, downloaded from
Hugging Face on first use, then cached). It reads Hokkien in Chinese characters;
it does NOT translate. English or plain Mandarin wording in, poor speech out.
Translation to Hokkien happens before this step.

Env (all optional):
  TTS_MODEL       Hugging Face repo id or local folder
                  (default MERaLiON/MERaLiON-OmniVoice-Hokkien-TTS)
  TTS_DEVICE      "cuda:0", "cpu", ... (default: cuda:0 if a GPU is present, else cpu)
  TTS_REF_AUDIO   optional 3-8 s clean single-speaker clip (16 kHz mono WAV) to clone
  TTS_REF_TEXT    transcript of that clip, in Hokkien (required with TTS_REF_AUDIO)
"""

from __future__ import annotations

import io
import os
import re
import threading
import wave

DEFAULT_MODEL = "MERaLiON/MERaLiON-OmniVoice-Hokkien-TTS"
LANGUAGE = "nan"  # ISO 639-3 for Southern Min (Hokkien)
MIN_CHARS = 1
MAX_CHARS = 1_000

# CJK Unified Ideographs, Extension A, and compatibility ideographs.
_HAN = re.compile(r"[㐀-䶿一-鿿豈-﫿]")

_model = None
_voice_prompt = None
_lock = threading.Lock()  # one load at a time, and one generation at a time


class TtsError(Exception):
    """`message` is user-safe (it may reach the phone). Specifics go in `detail`
    or `__cause__` for server logs only.

    code: "bad_input" | "unavailable" | "synthesis_failed"
    """

    def __init__(self, code: str, message: str, detail: str | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.detail = detail


def _device() -> str:
    device = os.environ.get("TTS_DEVICE")
    if device:
        return device
    import torch

    return "cuda:0" if torch.cuda.is_available() else "cpu"


def _load_model():
    """Load the model once and keep it in memory. Caller holds `_lock`."""
    global _model, _voice_prompt
    if _model is not None:
        return _model
    try:
        import torch
        from omnivoice.models.omnivoice import OmniVoice
    except ImportError as exc:
        raise TtsError(
            "unavailable",
            "The voice service is not available right now.",
            detail="TTS dependencies missing: pip install -r tts/requirements.txt",
        ) from exc

    device = _device()
    dtype = torch.float16 if device.startswith("cuda") else torch.float32
    try:
        model = OmniVoice.from_pretrained(
            os.environ.get("TTS_MODEL") or DEFAULT_MODEL,
            device_map=device,
            dtype=dtype,
        )
        ref_audio = os.environ.get("TTS_REF_AUDIO")
        if ref_audio:
            ref_text = os.environ.get("TTS_REF_TEXT")
            if not ref_text:
                raise TtsError(
                    "unavailable",
                    "The voice service is not available right now.",
                    detail="TTS_REF_AUDIO is set but TTS_REF_TEXT is not.",
                )
            # Encode the reference once; reused for every request.
            _voice_prompt = model.create_voice_clone_prompt(ref_audio=ref_audio, ref_text=ref_text)
    except TtsError:
        raise
    except Exception as exc:  # download failure, out of memory, bad reference clip
        raise TtsError(
            "unavailable",
            "The voice service is not available right now.",
            detail=f"model load failed: {exc!r}",
        ) from exc
    _model = model
    return model


def _generate(model, text: str):
    """Return (samples as a 1-D float array, sampling rate)."""
    import numpy as np

    kwargs = {"text": text, "language": LANGUAGE}
    if _voice_prompt is not None:
        kwargs["voice_clone_prompt"] = _voice_prompt
    audios = model.generate(**kwargs)
    audio = audios[0]
    if hasattr(audio, "detach"):  # torch tensor
        audio = audio.detach().float().cpu().numpy()
    return np.squeeze(np.asarray(audio, dtype="float32")), int(model.sampling_rate)


def _to_wav(samples, rate: int) -> bytes:
    import numpy as np

    pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype("<i2")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm.tobytes())
    return buf.getvalue()


def validate(text: object) -> str:
    """Return the cleaned text, or raise TtsError("bad_input")."""
    if not isinstance(text, str):
        raise TtsError("bad_input", "Text must be a string.")
    text = text.strip()
    if len(text) < MIN_CHARS:
        raise TtsError("bad_input", "There is no text to read.")
    if len(text) > MAX_CHARS:
        raise TtsError("bad_input", f"Text is too long (max {MAX_CHARS} characters).")
    if not _HAN.search(text):
        raise TtsError("bad_input", "Text must be Hokkien written in Chinese characters.")
    return text


def synthesise(text: str) -> bytes:
    """Speak Hokkien text (Chinese characters) and return it as WAV bytes.

    Raises TtsError. The first call loads the model, which can take a while.
    """
    text = validate(text)
    with _lock:
        model = _load_model()
        try:
            samples, rate = _generate(model, text)
            if samples.size == 0:
                raise ValueError("model returned no audio")
            return _to_wav(samples, rate)
        except TtsError:
            raise
        except Exception as exc:
            raise TtsError(
                "synthesis_failed",
                "Could not make the voice. Please try again.",
                detail=f"synthesis failed: {exc!r}",
            ) from exc
