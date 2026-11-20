"""Web demo: a phone mock-up in the browser that reads letters aloud (POC).

Run:  uvicorn app:app --reload   then open http://localhost:8000

Env (from the shell or .env; all optional except OPENCODE_API_KEY):
  OPENCODE_API_KEY      key for the summary model (POST /api/summary)
  LLM_BASE_URL          default https://opencode.ai/inference/go/openai/v1
  LLM_MODEL             default deepseek-v4.1-flash
  RATE_LIMIT_MAX        summary requests per IP per window, default 5
  RATE_LIMIT_WINDOW_S   window length in seconds, default 60
"""

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
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from ocr import SUPPORTED_EXTENSIONS, UnsupportedImageError, extract_text
from summary import SummariseError, load_dotenv, summarise

load_dotenv()
log = logging.getLogger("letter_reader")

STATIC_DIR = Path(__file__).parent / "static"
MAX_UPLOAD_BYTES = 15 * 1024 * 1024
MAX_SUMMARY_BODY_BYTES = 200_000
MAX_TRACKED_IPS = 10_000

# What the phone sees per error code. Upstream details stay in the server log.
# bad_input keeps its own message: it only describes the client's own input.
SUMMARY_ERRORS = {
    "bad_input": (400, None),
    "no_key": (500, "The summary service is not available right now."),
    "model_failed": (502, "The summary service is not available right now."),
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


summary_limiter = RateLimiter(
    int(os.environ.get("RATE_LIMIT_MAX", "5")),
    float(os.environ.get("RATE_LIMIT_WINDOW_S", "60")),
)


def _is_cross_origin(request: Request) -> bool:
    """A cross-origin request has an Origin header whose host differs from Host."""
    origin = request.headers.get("origin")
    if origin is None:
        return False
    try:
        return urlsplit(origin).netloc != request.headers.get("host")
    except ValueError:
        return True


@app.post("/api/summary")
async def summary_endpoint(request: Request):
    if _is_cross_origin(request):
        raise HTTPException(403, "Cross-origin requests are not allowed.")
    ip = request.client.host if request.client else "unknown"
    ok, retry_after = summary_limiter.hit(ip)
    if not ok:
        raise HTTPException(429, "Too many requests. Please wait a minute.",
                            headers={"retry-after": str(retry_after)})

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
