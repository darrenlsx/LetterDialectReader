# LetterDialectReader

Helps elderly people who can't read understand letters from government agencies and other organisations:
**photo → text (OCR) → simple explanation → speech (MERaLion)**.

This is a proof of concept. It runs in a desktop browser, inside a phone mock-up.

| Part | Owner | Status |
|------|-------|--------|
| OCR (image → text) | Darren | ✅ `ocr/` |
| Explanation / summary | Ozzy | ✅ `summary/` |
| Text-to-speech (MERaLion) | Both | ⏳ |

## Setup (Windows, Python 3.11)

```powershell
python -m venv .venv
.\.venv\Scripts\activate
pip install -r requirements-dev.txt
copy .env.template .env
```

Put your OpenCode Go key in `.env` as `OPENCODE_API_KEY` (needed for the summary; OCR works without it). `app.py` loads `.env` itself. Optional settings are listed in `.env.template`.

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

## Using the summary module

```python
from summary import summarise

result = summarise(text)   # text from extract_text(...)
```

It calls `deepseek-v4.1-flash` and returns `{summary, key_details, action_required, confident, unclear_parts, missing_details}`.
A built-in check makes sure every amount, date, reference number, phone number and time in the letter appears in the summary; anything the model drops is asked for again, then added word for word, and `confident` is set to false so the app can say "please ask family".
The letter is treated as untrusted data, so instructions written inside a letter are flagged, not followed.

It raises `summary.SummariseError` with `.code` `bad_input` (text empty/too short, e.g. a blurry photo), `no_key` or `model_failed`.

API endpoint: `POST /api/summary` takes JSON `{"text": ...}` and returns the result above plus `seconds`. It is rate-limited per IP and rejects cross-origin requests.

In the web demo, the photo is read, then the summary appears with a tick (or a cross plus "please ask family" when not confident). A photo with almost no readable text shows a cross and "Photo was blurry. Please take the picture again."

## Tests and lint

```powershell
python -m pytest
npm install
npm run lint
```

## Notes

- The engine is classic PaddleOCR (PP-OCRv5 mobile). `paddlepaddle` is pinned to 3.2.2 because 3.3 crashes on CPU.
- Only commit fake sample letters. Never commit real personal letters.
