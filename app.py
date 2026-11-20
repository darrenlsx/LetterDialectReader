"""Web demo: a phone mock-up in the browser that reads letters aloud (POC).

Run:  uvicorn app:app --reload   then open http://localhost:8000

Env (from the shell or .env; all optional except OPENCODE_API_KEY):
  OPENCODE_API_KEY      key for the summary and translation model (POST /api/summary
                        and POST /api/translate)
  LLM_BASE_URL          default https://opencode.ai/inference/go/openai/v1
  LLM_MODEL             default deepseek-v4.1-flash
  ACCESS_TOKEN          if set, /api/* needs it: header x-access-token, ?token=,
                        or the cookie set by opening /?token=<value> once
  RATE_LIMIT_MAX        summary requests per IP per window, default 5
  OCR_RATE_LIMIT_MAX    photo uploads per IP per window, default 10
  TTS_RATE_LIMIT_MAX    voice requests per IP per window, default 5
  RATE_LIMIT_WINDOW_S   window length in seconds, default 60

For the phone demo on the LAN: uvicorn app:app --host 0.0.0.0, with ACCESS_TOKEN set.
"""

import hmac
import json
import logging
import os
import tempfile
import threading
import time
from pathlib import Path
from urllib.parse import urlsplit

from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from ocr import SUPPORTED_EXTENSIONS, UnsupportedImageError, extract_text_with_confidence
from summary import SummariseError, load_dotenv, summarise
from translate import TranslateError, translate
from tts import TtsError, synthesise

load_dotenv()
log = logging.getLogger("letter_reader")

STATIC_DIR = Path(__file__).parent / "static"
MAX_UPLOAD_BYTES = 15 * 1024 * 1024
MAX_SUMMARY_BODY_BYTES = 200_000
MAX_TRACKED_IPS = 10_000
MAX_TTS_BODY_BYTES = 20_000
# A photo is "readable" when OCR found enough text with enough confidence;
# otherwise the phone shows the cross and asks for a retake (the brief's
# "Photo was blurry" step). MIN_TEXT_CHARS matches summary's minimum.
MIN_TEXT_CHARS = 20
# Calibrated on samples/sample_letter.jpg with Gaussian blur: radius 0-3 scored
# 0.94-0.97 and read correctly; radius 4 scored 0.83 and misread the date
# ("20 Noventer 2828"); radius 6 scored 0.28. Re-check with real phone photos.
MIN_OCR_CONFIDENCE = 0.9

# What the phone sees per error code. Upstream details stay in the server log.
# bad_input keeps its own message: it only describes the client's own input.
SUMMARY_ERRORS = {
    "bad_input": (400, None),
    "no_key": (500, "The summary service is not available right now."),
    "model_failed": (502, "The summary service is not available right now."),
}

# TTS: bad_input keeps its own message; the rest stay generic.
TTS_ERRORS = {
    "bad_input": (400, None),
    "unavailable": (503, "The voice service is not available right now."),
    "synthesis_failed": (502, "Could not make the voice. Please try again."),
}

TRANSLATE_ERRORS = {
    "bad_input": (400, None),
    "no_key": (500, "The translation service is not available right now."),
    "model_failed": (502, "The translation service is not available right now."),
}

app = FastAPI(title="LetterDialectReader")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


def _access_token() -> str | None:
    return os.environ.get("ACCESS_TOKEN") or None


def _token_matches(given: str | None, expected: str) -> bool:
    return given is not None and hmac.compare_digest(given.encode(), expected.encode())


@app.get("/")
def index(request: Request):
    res = FileResponse(STATIC_DIR / "index.html")
    expected = _access_token()
    if expected and _token_matches(request.query_params.get("token"), expected):
        # Lets a phone open /?token=... once; its same-origin fetches then carry the cookie.
        res.set_cookie("access_token", expected, httponly=True, samesite="strict")
    return res


@app.post("/api/ocr")
async def ocr_endpoint(file: UploadFile = File(...)):
    suffix = Path(file.filename or "").suffix.lower()
    if suffix not in SUPPORTED_EXTENSIONS:
        raise HTTPException(400, "Please choose a PNG or JPEG photo.")
    data = await file.read()
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, "That photo is too large (max 15 MB).")

    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / f"upload{suffix}"
        path.write_bytes(data)
        start = time.perf_counter()
        try:
            text, confidence = await run_in_threadpool(extract_text_with_confidence, path)
        except UnsupportedImageError as exc:
            raise HTTPException(400, str(exc)) from exc
        seconds = round(time.perf_counter() - start, 1)

    readable = len(text.strip()) >= MIN_TEXT_CHARS and confidence >= MIN_OCR_CONFIDENCE
    return {"text": text, "seconds": seconds, "confidence": round(confidence, 3), "readable": readable}


class RateLimiter:
    """Fixed-window per-key counter with bounded memory."""

    def __init__(self, max_requests: int, window_s: float, now=time.monotonic) -> None:
        self.max = max_requests
        self.window = window_s
        self.now = now
        self.hits: dict[str, list[float]] = {}  # key -> [count, reset_at]
        self.lock = threading.Lock()

    def hit(self, key: str) -> tuple[bool, int]:
        with self.lock:
            t = self.now()
            if len(self.hits) >= MAX_TRACKED_IPS:
                for k in [k for k, v in self.hits.items() if v[1] <= t]:
                    del self.hits[k]
                while len(self.hits) >= MAX_TRACKED_IPS:  # still full: drop oldest
                    del self.hits[next(iter(self.hits))]
            entry = self.hits.get(key)
            if entry is None or entry[1] <= t:
                self.hits.pop(key, None)
                entry = self.hits[key] = [0, t + self.window]
            entry[0] += 1
            return entry[0] <= self.max, max(1, int(entry[1] - t + 0.999))


_WINDOW_S = float(os.environ.get("RATE_LIMIT_WINDOW_S", "60"))
summary_limiter = RateLimiter(int(os.environ.get("RATE_LIMIT_MAX", "5")), _WINDOW_S)
translate_limiter = RateLimiter(int(os.environ.get("RATE_LIMIT_MAX", "5")), _WINDOW_S)
ocr_limiter = RateLimiter(int(os.environ.get("OCR_RATE_LIMIT_MAX", "10")), _WINDOW_S)
tts_limiter = RateLimiter(int(os.environ.get("TTS_RATE_LIMIT_MAX", "5")), _WINDOW_S)

# POST routes guarded by api_guard: path -> (limiter name, max body bytes).
# The multipart allowance covers form boundaries/headers around the photo.
API_ROUTES = {
    "/api/summary": ("summary_limiter", MAX_SUMMARY_BODY_BYTES),
    "/api/translate": ("translate_limiter", MAX_SUMMARY_BODY_BYTES),
    "/api/ocr": ("ocr_limiter", MAX_UPLOAD_BYTES + 64 * 1024),
    "/api/tts": ("tts_limiter", MAX_TTS_BODY_BYTES),
}


def _is_cross_origin(request: Request) -> bool:
    """A cross-origin request has an Origin header whose host differs from Host."""
    origin = request.headers.get("origin")
    if origin is None:
        return False
    try:
        return urlsplit(origin).netloc.lower() != (request.headers.get("host") or "").lower()
    except ValueError:
        return True


def _deny(status: int, detail: str, headers: dict[str, str] | None = None) -> JSONResponse:
    return JSONResponse({"detail": detail}, status_code=status, headers=headers)


@app.middleware("http")
async def api_guard(request: Request, call_next):
    """Checks that must run before any request body is read: origin, access
    token, per-IP rate limit and a declared body size within the limit."""
    route = API_ROUTES.get(request.url.path)
    if route is None or request.method != "POST":
        return await call_next(request)
    limiter_name, max_bytes = route

    if _is_cross_origin(request):
        return _deny(403, "Cross-origin requests are not allowed.")
    expected = _access_token()
    if expected:
        given = (request.headers.get("x-access-token") or request.query_params.get("token")
                 or request.cookies.get("access_token"))
        if not _token_matches(given, expected):
            return _deny(401, "Access token missing or wrong.")

    ip = request.client.host if request.client else "unknown"
    ok, retry_after = globals()[limiter_name].hit(ip)
    if not ok:
        return _deny(429, "Too many requests. Please wait a minute.", {"retry-after": str(retry_after)})

    # Browsers always send Content-Length for fetch bodies. Requiring it means
    # the server reads at most max_bytes (the HTTP layer stops at the length).
    length = request.headers.get("content-length")
    if length is None or not length.isdigit():
        return _deny(411, "Content-Length is required.")
    if int(length) > max_bytes:
        return _deny(413, "That request is too large.")
    return await call_next(request)


@app.post("/api/summary")
async def summary_endpoint(request: Request):
    body = await request.body()
    if len(body) > MAX_SUMMARY_BODY_BYTES:
        raise HTTPException(413, "That letter is too long.")
    try:
        text = json.loads(body)["text"]
    except (ValueError, KeyError, TypeError):
        raise HTTPException(400, 'Body must be JSON: {"text": string}') from None

    start = time.perf_counter()
    try:
        result = await run_in_threadpool(summarise, text)
    except SummariseError as exc:
        status, public = SUMMARY_ERRORS.get(exc.code, (500, None))
        if exc.code != "bad_input":
            log.error("summary failed: %s | %s", exc.code, exc.detail, exc_info=exc)
        if public is None:
            public = exc.message if exc.code == "bad_input" else "Something went wrong. Please try again."
        raise HTTPException(status, public) from None
    except Exception:
        log.exception("summary crashed")
        raise HTTPException(500, "Something went wrong. Please try again.") from None
    result["seconds"] = round(time.perf_counter() - start, 1)
    return result


@app.post("/api/translate")
async def translate_endpoint(request: Request):
    """Translate the English summary into Chinese for the Hokkien voice step."""
    body = await request.body()
    if len(body) > MAX_SUMMARY_BODY_BYTES:
        raise HTTPException(413, "That text is too long.")
    try:
        text = json.loads(body)["text"]
    except (ValueError, KeyError, TypeError):
        raise HTTPException(400, 'Body must be JSON: {"text": string}') from None

    start = time.perf_counter()
    try:
        result = await run_in_threadpool(translate, text)
    except TranslateError as exc:
        status, public = TRANSLATE_ERRORS.get(exc.code, (500, None))
        if exc.code != "bad_input":
            log.error("translate failed: %s | %s", exc.code, exc.detail, exc_info=exc)
        if public is None:
            public = exc.message if exc.code == "bad_input" else "Something went wrong. Please try again."
        raise HTTPException(status, public) from None
    except Exception:
        log.exception("translate crashed")
        raise HTTPException(500, "Something went wrong. Please try again.") from None
    result["seconds"] = round(time.perf_counter() - start, 1)
    return result


@app.post("/api/tts")
async def tts_endpoint(request: Request):
    """Body: {"text": "<Hokkien in Chinese characters>"}. Returns audio/wav.

    Origin, token, rate limit and body size are checked by api_guard.
    """
    body = await request.body()
    if len(body) > MAX_TTS_BODY_BYTES:
        raise HTTPException(413, "That text is too long.")
    try:
        text = json.loads(body)["text"]
    except (ValueError, KeyError, TypeError):
        raise HTTPException(400, 'Body must be JSON: {"text": string}') from None

    start = time.perf_counter()
    try:
        wav = await run_in_threadpool(synthesise, text)
    except TtsError as exc:
        status, public = TTS_ERRORS.get(exc.code, (500, None))
        if exc.code != "bad_input":
            log.error("tts failed: %s | %s", exc.code, exc.detail, exc_info=exc)
        if public is None:
            public = exc.message if exc.code == "bad_input" else "Something went wrong. Please try again."
        raise HTTPException(status, public) from None
    except Exception:
        log.exception("tts crashed")
        raise HTTPException(500, "Something went wrong. Please try again.") from None
    return Response(
        wav,
        media_type="audio/wav",
        headers={"x-seconds": f"{time.perf_counter() - start:.1f}", "cache-control": "no-store"},
    )
