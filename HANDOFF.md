# Handoff log

Shared context between collaborators and their Claude agents. Agents only see what is in the repo, so anything that lives on one person's machine (decisions, env setup, test results, blockers) must be written here and pushed.

Read this file first. Add a new entry at the top before every push. Never put secrets (API keys, tokens) in it.

## Entry template

### YYYY-MM-DD, <author>
- **Pushed:** branch / commit, one line on what changed
- **State:** what works, what is broken or unverified
- **Decisions:** choices made and why
- **Needs from you:** questions or tasks for the other person
- **Local-only info:** anything the other side cannot see (env vars needed by name only, sample files, test results)

---

### 2026-11-20, OzzyOw (Hokkien TTS)
- **Pushed:** branch `feature/text-to-speech` (based on `main` at 6dc8c05): `tts/` module, `POST /api/tts` in `app.py`, `tts_cli.py`, `tts/requirements.txt`, `tests/test_tts.py`, README section.
- **State:** 25 pytest tests pass with the model stubbed. Also run with the real model on a CPU-only Windows laptop (torch 2.15 CPU, omnivoice 0.2.1): the CLI and `POST /api/tts` return valid 24 kHz mono WAV (audible, not silent) for Hokkien text, and English-only text is rejected with 400. **Nobody has listened to it yet, so whether it sounds like Hokkien is unverified.**
  - **Speed on CPU is too slow for the 5-minute target:** about 43 s to speak a 3 s sentence once warm (roughly 13x real time). The first request also downloads the 2.7 GB model (first CLI run took about 3.5 min) and loads it (about 5 s once cached). A spoken summary of 30 s would take about 7 min on CPU, so the demo needs a CUDA GPU, short phrases, or pre-generated audio.
  - Not wired into the UI: `static/` and `public/` have no Listen button yet.
- **Decisions:**
  - Model is `MERaLiON/MERaLiON-OmniVoice-Hokkien-TTS`. It reads Hokkien in Chinese characters and does not translate, so the translation step (separate branch) must output Hokkien wording, not Mandarin.
  - `synthesise(text)` returns WAV bytes. Input must contain at least one Chinese character and be at most 1000 characters. Errors are `TtsError` with `bad_input`, `unavailable` or `synthesis_failed`; the phone gets generic messages, details go to the server log.
  - TTS dependencies are optional (`tts/requirements.txt`), so the rest of the app runs without torch. WAV is written with the standard library.
  - `/api/tts` has the cross-origin check but no rate limit or access token yet (the model call is serialised by a lock).
  - The model is under the MERaLiON-3 Public Licence. Not yet read; check before the demo.
- **Needs from you:** wire translation output into `POST /api/tts` and add the Listen button in the UI. Say which dialect-list and error prompts (e.g. "Photo was blurry") need pre-generated audio.
- **Local-only info:** none. Optional env vars (names only): `TTS_MODEL`, `TTS_DEVICE`, `TTS_REF_AUDIO`, `TTS_REF_TEXT`.

### 2026-11-20, darrenlsx (logo)
- **Pushed:** branch `feature/logo`: app logo `static/logo.svg` (信 in a speech bubble, blue `#0b5ed7`, same as the main button), shown in the phone header and used as the favicon
- **State:** Works in the OCR demo (`static/`). Not yet in `public/index.html` (the Node page).
- **Decisions:** We picked 信 ("letter") because the users read Chinese rather than English. The speech bubble stands for "read aloud to you".
- **Needs from you:** In the Python port, please serve `static/logo.svg` and use it in the header and as the favicon (`<link rel="icon" type="image/svg+xml" href="/static/logo.svg">`).
- **Local-only info:** none

### 2026-11-20, OzzyOw (review fixes)
- **Pushed:** branch `summarise-oci-generated-text`, fixes from a code review of the summarisation feature
- **State:** 49 tests pass (`npm test`). Live check against `deepseek-v4.1-flash` passed, including a letter with an injected "ignore previous instructions" line (flagged as suspicious, `confident` false).
- **Decisions:**
  - Critical-detail check now compares canonical values (dates day-first, amounts, times, IDs/phones) as whole tokens, so "$500" no longer satisfies "$50" and "April 11, 2026" counts as "11 April 2026".
  - `confident` is true only if the model says exactly `true` and `unclear_parts` is empty.
  - Letter text is wrapped in a random per-request tag and treated as untrusted data.
  - One retry on bad JSON, timeout, 429 or 5xx (not 401/403). Client sees generic errors only; details go to the server log.
  - Server binds to 127.0.0.1 by default, rate-limits `/api/summarise` (5/min/IP), rejects cross-origin POSTs, optional `ACCESS_TOKEN`.
- **How to run:** `npm start`, open http://localhost:3000. For the real-phone demo set `HOST=0.0.0.0` and `ACCESS_TOKEN` in `.env`, then open `http://<your-LAN-IP>:3000/?token=<value>` once on the phone. All optional vars are listed in `.env.template`.
- **Needs from you:** same as below (OCI wiring, where Hokkien translation sits).
- **Local-only info:** none new.

### 2026-11-20, OzzyOw (summarisation built)
- **Pushed:** branch `summarise-oci-generated-text`, summarisation feature (not yet merged to `main`). If you cannot see it on GitHub, the push is still pending.
- **State:** works end to end against the real `deepseek-v4.1-flash` model with a sample letter. 7 unit tests pass (`npm test`).
  - `src/summarise.js`: `summarise(text)` takes OCI-extracted letter text and returns `{ summary, key_details[], action_required, confident, unclear_parts[], missing_details[] }`. English output only; Hokkien translation and speech are not built.
  - `server.js`: `POST /api/summarise` with `{ "text": "..." }`, plus static hosting. Run with `npm start`, open http://localhost:3000.
  - `public/index.html`: simulated phone UI. Paste OCI text (or "Use sample letter"), tap Summarise.
- **Decisions:**
  - Endpoint is OpenCode Go (`https://opencode.ai/inference/go/openai/v1`), authenticated with `OPENCODE_API_KEY`, same as the lunch-uncle project.
  - Critical-detail safety net: code extracts amounts, dates, IDs, phone numbers and times from the source. If any are missing from the output it retries once, then appends them verbatim and sets `confident` to false.
  - No dependencies; Node 26 built-ins only (`node --env-file`, `node --test`).
- **Needs from you:** how the real OCI step will call `summarise` (the function takes plain text, so wire it in after OCI). Decide where the Hokkien translation step sits.
- **Local-only info:** `.env` with `OPENCODE_API_KEY` must be created from `.env.template`. `.agents/`, `.claude/` and `skills-lock.json` are untracked and not committed.

### 2026-11-20, darrenlsx
- **Pushed:** branch `feature/ocr` (PR #1 into `main`): OCR module, CLI and a phone-style web demo
- **State:** Working and tested on a Windows laptop CPU. `from ocr import extract_text` takes a PNG/JPEG path and returns plain text in reading order, in about 3s per letter once the model has loaded. Web demo: `uvicorn app:app --reload`, then open http://localhost:8000. `POST /api/ocr` returns `{text, seconds}`. The Summary and Listen sections in the UI are placeholders.
- **Decisions:** Classic PaddleOCR (PP-OCRv5 mobile) instead of PaddleOCR-VL, which is too slow without a GPU. `paddlepaddle` is pinned to 3.2.2 because 3.3 crashes on CPU (oneDNN). There's no blur check yet; the brief's tick/cross step is still to do.
- **Needs from you:** For the summary step, call `extract_text(...)` and pass its string to `deepseek-v4.1-flash`. The "OCI" step in your entry is this OCR step, so the summary model can be text-only. Suggest adding `POST /api/summary` to `app.py` and filling in the Summary section in `static/`.
- **Local-only info:** No env vars are needed for OCR. On first run, about 20 MB of models are downloaded to `~/.paddlex`. The test image is `samples/sample_letter.jpg` (a fake letter).

### 2026-11-20, OzzyOw
- **Pushed:** `main` (`.env.template`, `.gitignore`); branch `summarise-oci-generated-text` created
- **State:** branch `summarise-oci-generated-text` is for building the summarisation function. No code yet.
- **Decisions:** `deepseek-v4.1-flash` is the model used for the summarisation step (summarising text generated by OCI) in `summarise-oci-generated-text`. This supersedes the earlier plan to use Claude for the summary. Keys come from `.env` (copy `.env.template`, names only, never commit `.env`).
- **Needs from you:** confirm the API key name and endpoint for the model (template currently has `OPENCODE_API_KEY` and `GOOGLE_PLACES_API_KEY`). Note: if the model is text-only, the photo-to-text (OCI) step must run before it.
- **Local-only info:** `.env` exists on OzzyOw's machine only.

### 2026-11-20, initial
- **Pushed:** nothing yet
- **State:** repo contains README.md and PRODUCT_BRIEF.md. Build plan agreed: Hokkien-only demo (Cantonese and Teochew listed as coming soon), web/PWA, Claude vision for reading and summarizing the letter.
- **Decisions:** see the plan summary in PRODUCT_BRIEF.md and README once added
- **Needs from you:** confirm Hokkien audio approach (recorded prompts, TTS choice)
- **Local-only info:** none
