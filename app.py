"""Web demo: a phone mock-up in the browser that reads letters aloud (POC).

Run:  uvicorn app:app --reload   then open http://localhost:8000
"""

import tempfile
import time
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from ocr import SUPPORTED_EXTENSIONS, UnsupportedImageError, extract_text

STATIC_DIR = Path(__file__).parent / "static"
MAX_UPLOAD_BYTES = 15 * 1024 * 1024

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
