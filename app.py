"""Web demo: a phone mock-up in the browser that reads letters aloud (POC).

Run:  uvicorn app:app --reload   then open http://localhost:8000
"""

import json
import logging
import tempfile
import time
from pathlib import Path
from urllib.parse import urlsplit

from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles

from ocr import SUPPORTED_EXTENSIONS, UnsupportedImageError, extract_text
from tts import TtsError, synthesise

STATIC_DIR = Path(__file__).parent / "static"
MAX_UPLOAD_BYTES = 15 * 1024 * 1024
MAX_TTS_BODY_BYTES = 20_000
log = logging.getLogger("letter_reader")

# What the phone sees per TTS error code. Specifics stay in the server log.
# bad_input keeps its own message: it only describes the client's own input.
TTS_ERRORS = {
    "bad_input": (400, None),
    "unavailable": (503, "The voice service is not available right now."),
    "synthesis_failed": (502, "Could not make the voice. Please try again."),
}

app = FastAPI(title="LetterDialectReader")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/")
def index():
    return FileResponse(STATIC_DIR / "index.html")


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
            text = await run_in_threadpool(extract_text, path)
        except UnsupportedImageError as exc:
            raise HTTPException(400, str(exc)) from exc
        seconds = round(time.perf_counter() - start, 1)

    return {"text": text, "seconds": seconds}


@app.post("/api/tts")
async def tts_endpoint(request: Request):
    """Body: {"text": "<Hokkien in Chinese characters>"}. Returns audio/wav."""
    origin = request.headers.get("origin")
    if origin is not None and urlsplit(origin).netloc != request.headers.get("host"):
        raise HTTPException(403, "Cross-origin requests are not allowed.")
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
