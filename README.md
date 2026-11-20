# LetterDialectReader

Helps elderly people who can't read understand letters from government agencies and other organisations:
**photo → text (OCR) → simple explanation → speech (MERaLion)**.

This is a proof of concept. It runs in a desktop browser, inside a phone mock-up.

| Part | Owner | Status |
|------|-------|--------|
| OCR (image → text) | Darren | ✅ `ocr/` |
| Explanation / summary | Teammate | ⏳ |
| Text-to-speech (MERaLion) | Both | ⏳ |

## Setup (Windows, Python 3.11)

```powershell
python -m venv .venv
.\.venv\Scripts\activate
pip install -r requirements.txt
```

The first run downloads the PP-OCRv5 mobile models (about 20 MB) to `~/.paddlex`.

## Run

**Web demo:**

```powershell
uvicorn app:app --reload
```

Then open http://localhost:8000.

**Command line:**

```powershell
python ocr_cli.py samples/sample_letter.jpg
```

## Using the OCR module (for teammates)

```python
from ocr import extract_text

text = extract_text("letter.jpg")   # PNG/JPEG only; returns plain text in reading order
```

It raises `FileNotFoundError` if the file is missing, and `ocr.UnsupportedImageError` if the file type isn't supported.
After the model has loaded, each letter takes about 3 seconds on a laptop CPU.

API endpoint: `POST /api/ocr` takes a multipart `file` and returns `{"text": ..., "seconds": ...}`.

## Notes

- The engine is classic PaddleOCR (PP-OCRv5 mobile). `paddlepaddle` is pinned to 3.2.2 because 3.3 crashes on CPU.
- Only commit fake sample letters. Never commit real personal letters.
