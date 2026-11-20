# LetterDialectReader

Helps elderly people who can't read understand letters from government agencies and other organisations:
**photo → text (OCR) → simple explanation → speech (MERaLion)**.

This is a proof of concept. It runs in a desktop browser, inside a phone mock-up.

| Part | Owner | Status |
|------|-------|--------|
| OCR (image → text) | Darren | ✅ `ocr/` |
| Explanation / summary | Ozzy | ✅ `summary/` |
| Text-to-speech (Hokkien, MERaLiON-OmniVoice) | Both | 🧪 `tts/` (module + `/api/tts`; not yet wired into the UI) |

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

API endpoint: `POST /api/summary` takes JSON `{"text": ...}` and returns the result above plus `seconds`.

Both API endpoints are rate-limited per IP, reject cross-origin requests, require `Content-Length` and cap the body size before reading it. If `ACCESS_TOKEN` is set in `.env`, they also need the token (header `x-access-token`, `?token=`, or the cookie set by opening `/?token=<value>` once).

In the web demo, the photo is read, then the summary appears with a tick (or a cross plus "please ask family" when not confident). `POST /api/ocr` also returns `confidence` (0-1) and `readable`; a photo that isn't readable (under 20 characters, or confidence below 0.9) shows a cross and "Photo was blurry. Please take the picture again." In code, use `ocr.extract_text_with_confidence(path)` to get the score.

**Phone on the same Wi-Fi:** set `ACCESS_TOKEN` in `.env`, run `uvicorn app:app --host 0.0.0.0`, then open `http://<your-laptop-IP>:8000/?token=<value>` once on the phone.

## Using the Hokkien TTS module

```python
from tts import synthesise

wav_bytes = synthesise("你阿母煮的菜真好食")   # Hokkien in Chinese characters -> WAV (24 kHz mono)
```

Uses [MERaLiON-OmniVoice-Hokkien-TTS](https://huggingface.co/MERaLiON/MERaLiON-OmniVoice-Hokkien-TTS) (about 2.7 GB, downloaded on first use). **It does not translate.** The input must already be Hokkien written in Chinese characters; English or plain Mandarin wording gives poor speech. Translation happens in an earlier step.

Setup (optional, on top of the steps above; a CUDA GPU is recommended):

```powershell
pip install -r tts/requirements.txt
python tts_cli.py "你阿母煮的菜真好食" --out output/hello.wav
```

`synthesise` raises `tts.TtsError` with `code` `bad_input`, `unavailable` (dependencies or model missing) or `synthesis_failed`. Optional env vars (`TTS_MODEL`, `TTS_DEVICE`, `TTS_REF_AUDIO`, `TTS_REF_TEXT` for voice cloning) are documented in `tts/engine.py`.

API endpoint: `POST /api/tts` takes `{"text": "..."}` and returns `audio/wav`. Tests: `pip install pytest httpx`, then `pytest tests`.

## Tests and lint

```powershell
python -m pytest
npm install
npm run lint
```

## Notes

- The engine is classic PaddleOCR (PP-OCRv5 mobile). `paddlepaddle` is pinned to 3.2.2 because 3.3 crashes on CPU.
- Only commit fake sample letters. Never commit real personal letters.
