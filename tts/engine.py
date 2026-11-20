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
  TTS_REF_AUDIO   voice to clone. Unset or "none": no cloning (default; cloning made CPU
                  generation about 2.4x slower). "bundled": the clip shipped with the
                  MERaLiON model. Or a path to a 3-8 s clean single-speaker 16 kHz mono WAV.
  TTS_REF_TEXT    transcript of that clip, in Hokkien (required with a TTS_REF_AUDIO path)
  TTS_NUM_STEP    diffusion steps, 1-64 (default 10; OmniVoice's own default is 32)
"""

from __future__ import annotations

import io
import logging
import os
import re
import threading
import time
import wave

log = logging.getLogger("letter_reader.tts")

DEFAULT_MODEL = "MERaLiON/MERaLiON-OmniVoice-Hokkien-TTS"
LANGUAGE = "nan"  # ISO 639-3 for Southern Min (Hokkien)
MIN_CHARS = 1
MAX_CHARS = 1_000
# Diffusion steps. OmniVoice defaults to 32; 10 was picked on a CPU-only laptop after
# comparing by ear (33 s of speech: 32 steps 27 min, 16 steps 14 min, 8 steps 6 min).
# Env TTS_NUM_STEP overrides.
DEFAULT_NUM_STEP = 10
# Reference clip bundled in the model repo (7.6 s, one speaker), used when TTS_REF_AUDIO=bundled.
REF_AUDIO_FILE = "reference_audio/reference_audio.wav"
REF_TEXT_FILE = "reference_audio/reference_text.txt"

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


def _bundled_reference() -> tuple[str | None, str | None]:
    """The reference clip shipped with the MERaLiON model, from the local cache only."""
    try:
        from huggingface_hub import hf_hub_download

        repo = os.environ.get("TTS_MODEL") or DEFAULT_MODEL
        audio = hf_hub_download(repo, REF_AUDIO_FILE, local_files_only=True)
        text_path = hf_hub_download(repo, REF_TEXT_FILE, local_files_only=True)
        with open(text_path, encoding="utf-8") as f:
            text = f.read().strip()
    except Exception as exc:  # not cached, a local model folder without it, no hub library
        log.info("no bundled reference voice (%s); using the model's default voice", exc)
        return None, None
    return (audio, text) if text else (None, None)


def _reference_voice() -> tuple[str | None, str | None]:
    """(audio path, transcript) for voice cloning, or (None, None) for none.

    Off by default: on a CPU the 7.6 s bundled reference made each generation about
    2.4x slower (71 s vs 30 s for 5.7 s of speech at 10 steps).
    TTS_REF_AUDIO unset or "none": no cloning (the model's own voice).
    TTS_REF_AUDIO=bundled: the clip shipped with the MERaLiON model.
    TTS_REF_AUDIO=<path> with TTS_REF_TEXT: that clip.
    """
    ref_audio = (os.environ.get("TTS_REF_AUDIO") or "").strip()
    if not ref_audio or ref_audio.lower() == "none":
        return None, None
    if ref_audio.lower() == "bundled":
        return _bundled_reference()
    if ref_audio:
        ref_text = os.environ.get("TTS_REF_TEXT")
        if not ref_text:
            raise TtsError(
                "unavailable",
                "The voice service is not available right now.",
                detail="TTS_REF_AUDIO is set but TTS_REF_TEXT is not.",
            )
        return ref_audio, ref_text
    return None, None


def preload() -> bool:
    """Load the model (and reference voice) now, e.g. at server start. Never raises.

    Returns True when the model is ready. Missing voice packages are expected on
    machines without the voice installed, so they are logged quietly.
    """
    start = time.perf_counter()
    try:
        with _lock:
            _load_model()
    except TtsError as exc:
        if "dependencies missing" in (exc.detail or ""):
            log.info("voice not installed, skipping preload")
        else:
            log.error("voice preload failed: %s", exc.detail or exc)
        return False
    except Exception:
        log.exception("voice preload crashed")
        return False
    log.info("voice model loaded in %.1fs", time.perf_counter() - start)
    return True


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
        ref_audio, ref_text = _reference_voice()
        if ref_audio:
            # Encode the reference once; reused for every request, so separately
            # generated sentence chunks all sound like the same speaker.
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


def _num_step() -> int:
    """Diffusion steps per generation (DEFAULT_NUM_STEP unless TTS_NUM_STEP is set)."""
    try:
        steps = int(os.environ.get("TTS_NUM_STEP") or DEFAULT_NUM_STEP)
    except ValueError:
        return DEFAULT_NUM_STEP
    return min(max(steps, 1), 64)


def _generate(model, text: str):
    """Return (samples as a 1-D float array, sampling rate)."""
    import numpy as np

    kwargs = {"text": text, "language": LANGUAGE, "num_step": _num_step()}
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
