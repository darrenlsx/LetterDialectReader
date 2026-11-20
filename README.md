# LetterDialectReader

Helps elderly people who can't read understand letters from government agencies and other organisations:
**photo → text (OCR) → simple explanation → speech (MERaLion)**.

This is a proof of concept. It runs in a desktop browser, inside a phone mock-up.

| Part | Owner | Status |
|------|-------|--------|
| OCR (image → text) | Darren | ✅ `ocr/` |
| Explanation / summary | Teammate | ⏳ |
| Text-to-speech (Hokkien, MERaLiON-OmniVoice) | Both | 🧪 `tts/` (module + `/api/tts`; not yet wired into the UI) |

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

## Notes

- The engine is classic PaddleOCR (PP-OCRv5 mobile). `paddlepaddle` is pinned to 3.2.2 because 3.3 crashes on CPU.
- Only commit fake sample letters. Never commit real personal letters.
