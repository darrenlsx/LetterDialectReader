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

### 2026-11-20, OzzyOw (TTS integration demo)
- **Pushed:** branch `tts-integration-demo`, merged into `main`: Listen card in the UI plus `static/sample_tts.wav`.
- **State:** After the Chinese translation appears, the Listen card shows "正在生成语音…" for 5 s, then plays `static/sample_tts.wav` (autoplay, with visible controls in case the browser blocks it). Checked in the browser with the OCR/summary/translate replies stubbed: spinner 5.0 s, then audio playing (7.7 s). Not checked end to end with the real pipeline in the UI. Nobody has listened to the clip, so whether it sounds like Hokkien is unverified.
- **Decisions:**
  - TTS is simulated, not called: `speak()` in `static/app.js` waits 5 s and plays the fixed file. Replace it with a `POST /api/tts` call (the endpoint already exists) when a GPU is available.
  - The wav was generated with `tts_cli.py` on CPU from only the first two sentences of the sample translation (full text did not finish in 25 min on CPU). It plays after any letter, not only the sample one. "Sample Agency of Singapore" stays in English in the text, so it may be mispronounced.
  - The Listen placeholder card in `index.html` is replaced by the real card (`#listen-card`).
- **Needs from you:** `feature/listen-button` (143617c) overlaps this card and may now conflict; reconcile or drop it. Listen to the clip.
- **Local-only info:** none.

### 2026-11-20, darrenlsx (remove key details)
- **Pushed:** `main` directly. Removed the 重要资料 Key details list from the Summary card (HTML and JS). The card now shows only the ✓/✗ mark, the Chinese summary and the timing line.
- **State:** 120 tests pass. Checked in the browser with the sample letter: only Chinese text shown, no errors.
- **Decisions:** `key_details` is still returned by `/api/summary` but not shown. The English "ask family to check" warning is kept as the only safety signal; it may later be shown in Chinese.
- **Needs from you:** none
- **Local-only info:** none

### 2026-11-20, darrenlsx (Chinese-only summary)
- **Pushed:** `main` directly (no branch). The 摘要 Summary card now shows only the Chinese translation. The English summary is hidden and the separate 中文 card is gone.
- **State:** 120 tests pass. Checked in the browser with `samples/sample_letter.jpg`: ✓ shown, Chinese text, no warnings, 38s from photo. ESLint is not installed locally, so lint was not run.
- **Decisions:** The English summary is still fetched (translation needs it) but not shown. Key details (重要资料) are still in English from the summary step. Warnings and the ✓/✗ mark are kept. `#translation` now sits inside `#summary-card`; `#summary` is only used for error messages.
- **Needs from you:** `feature/listen-button` (143617c) is not on `main` yet. Its Listen wiring may read the old `translation-card` or `translation-timing` elements, so check it when merging.
- **Local-only info:** none

### 2026-11-20, OzzyOw (Hokkien TTS)
- **Pushed:** branch `feature/text-to-speech` (merged with `main` at 4b24950): `tts/` module, `POST /api/tts` in `app.py`, `tts_cli.py`, `tts/requirements.txt`, `tests/test_tts.py`, README section.
- **State:** All 120 pytest tests pass (27 of them for TTS, with the model stubbed). Also run with the real model on a CPU-only Windows laptop (torch 2.15 CPU, omnivoice 0.2.1): the CLI and `POST /api/tts` return valid 24 kHz mono WAV (audible, not silent) for Hokkien text, and English-only text is rejected with 400. **Nobody has listened to it yet, so whether it sounds like Hokkien is unverified.**
  - **Speed on CPU is too slow for the 5-minute target:** about 43 s to speak a 3 s sentence once warm (roughly 13x real time). The first request also downloads the 2.7 GB model (first CLI run took about 3.5 min) and loads it (about 5 s once cached). A spoken summary of 30 s would take about 7 min on CPU, so the demo needs a CUDA GPU, short phrases, or pre-generated audio.
  - Not wired into the UI: `static/` and `public/` have no Listen button yet.
- **Decisions:**
  - Model is `MERaLiON/MERaLiON-OmniVoice-Hokkien-TTS`. It reads Hokkien in Chinese characters and does not translate, so the translation step (separate branch) must output Hokkien wording, not Mandarin.
  - `synthesise(text)` returns WAV bytes. Input must contain at least one Chinese character and be at most 1000 characters. Errors are `TtsError` with `bad_input`, `unavailable` or `synthesis_failed`; the phone gets generic messages, details go to the server log.
  - TTS dependencies are optional (`tts/requirements.txt`), so the rest of the app runs without torch. WAV is written with the standard library.
  - `/api/tts` is registered in `api_guard` (origin check, `ACCESS_TOKEN`, per-IP rate limit `TTS_RATE_LIMIT_MAX`, default 5, body limit 20 KB); the model call is serialised by a lock.
  - The model is under the MERaLiON-3 Public Licence. Not yet read; check before the demo.
- **Needs from you:** wire translation output into `POST /api/tts` and add the Listen button in the UI. Say which dialect-list and error prompts (e.g. "Photo was blurry") need pre-generated audio.
- **Local-only info:** none. Optional env vars (names only): `TTS_MODEL`, `TTS_DEVICE`, `TTS_REF_AUDIO`, `TTS_REF_TEXT`.

### 2026-11-20, darrenlsx (landing page)
- **Pushed:** branch `feature/landing-page`. Landing page with dialect choice, plus a keynote-style demo stage (all in `static/`; no API changes)
- **State:** Works and was tested in the browser at desktop and phone widths.
  - **First screen:** large 福建话 / 广东话 / 潮州话 cards. Cantonese and Teochew are disabled ("即将推出 coming soon").
  - **Picking Hokkien:** ✓ pops, the photo screen slides in (iOS-style push), and the choice is saved.
  - **换语言:** slides back to the language screen.
  - **Demo stage:** the phone sits on a dark stage with a headline and 3 feature cards. Screen labels are Chinese first, with English underneath.
- **Decisions:**
  - On-screen text is Mandarin-first, per PRODUCT_BRIEF.md.
  - No audio on the language screen yet (no MERaLion yet).
  - The pitch text says "seniors who find official letters hard to read or understand", not only those who can't read English.
- **Needs from you:**
  - The chosen dialect is in the browser at `localStorage['letterReader.dialect']`; it is currently always `"hokkien"`. Please send it with the summary/speech requests.
  - `main` (your Python port and summary) is merged into this branch. Your Summary card is kept as is, with Chinese-first labels (摘要, 正在解释…, 重要资料); the Listen card is still a placeholder.
- **Local-only info:** none

### 2026-11-20, OzzyOw (summary flows into translation in the app)
- **Pushed:** branch `worktree-test-pipeline`: `feature/ocr-summary` (PR #3) merged on top of the latest `main` (translation function), plus `POST /api/translate` and the UI step. Merged into `main` right after.
- **State:** photo → OCR → summary → Chinese translation runs automatically on the page, no tap between steps. 93 tests pass (`python -m pytest`), lint clean. Live check on `samples/sample_letter.jpg` through the browser UI: ✓, translation `confident`, 29s from photo.
- **Decisions:**
  - `/api/translate` takes `{text}` (the English summary) and returns `{text, confident, missing_details, seconds}`. Same guard as `/api/summary` (origin check, `ACCESS_TOKEN`, 5/min/IP, size cap, generic errors).
  - If translation is not confident the Chinese card says so and lists the missing numbers; if the call fails the summary stays and the card asks for a retry.
- **Needs from you:** Hokkien speech is still to do and will take the Chinese text from this card. English names ("Sample Agency of Singapore", "Jane Lim", "NRIC") stay in English in the translation, which a Hokkien voice may misread. Once only, the server process crashed mid-OCR (exit code 5) and worked after a restart; I could not reproduce it.
- **Local-only info:** a worktree needs its own `.env` (copy from `.env.template`) with `OPENCODE_API_KEY`; the translation uses the same key and model.

### 2026-11-20, OzzyOw (review fixes on `feature/ocr-summary`)
- **Pushed:** branch `feature/ocr-summary` (PR #3), fixes from a code review, plus `main` (logo) merged in
- **State:** 64 tests pass (`python -m pytest`), lint clean.
- **Decisions:**
  - **Blurry photos:** `ocr/engine.py` has a new `extract_text_with_confidence(path) -> (text, score)`; `extract_text` is unchanged for callers. `/api/ocr` now also returns `confidence` and `readable`. `readable` needs 20+ characters and confidence ≥ 0.9. Calibrated on `samples/sample_letter.jpg`: blur radius 0-3 scored 0.94-0.97 and read correctly; radius 4 scored 0.83 and misread the date as "20 Noventer 2828", so it now gets the cross instead of a wrong summary. **Please re-check the threshold with real phone photos.**
  - **API guard (middleware) for `/api/ocr` and `/api/summary`:** cross-origin check, optional `ACCESS_TOKEN`, per-IP rate limits (summary 5/min, OCR 10/min), and `Content-Length` required and capped before any body is read.
  - **Phone UI:** a new photo aborts the previous photo's requests, and late replies are ignored, so two letters can't mix on screen.
  - `.env` loading now strips inline comments (`RATE_LIMIT_MAX=5  # note` → `5`) and accepts quotes and `export`.
- **How to run on the phone:** set `ACCESS_TOKEN` in `.env`, run `uvicorn app:app --host 0.0.0.0`, open `http://<your-LAN-IP>:8000/?token=<value>` once on the phone.
- **Needs from you:** review the `ocr/engine.py` change (new function; scores come from PaddleOCR's `rec_scores`).
- **Local-only info:** none new.

### 2026-11-20, OzzyOw (summary ported to Python, wired into the OCR app)
- **Pushed:** branch `feature/ocr-summary` (PR into `main`): photo → OCR → summary in one flow in the Python app
- **State:**
  - `summary/` is a Python port of the Node summariser (`from summary import summarise`), same behaviour and tests, standard library only.
  - `app.py` has `POST /api/summary` (JSON `{text}`), rate-limited per IP, rejects cross-origin POSTs, generic errors to the phone with details in the server log. It loads `.env` itself.
  - `static/`: after OCR, the Summary card fills in automatically: tick/cross, summary, "please ask family" warning when not confident, key details, total time from photo. OCR text under 20 characters shows a cross and "Photo was blurry. Please take the picture again."
  - Tests: `python -m pytest` (`tests/`). Lint: `npm run lint` (ESLint for `static/app.js`).
- **Decisions:**
  - One runtime: the Node server (`server.js`, `src/`, `public/`, `test/`) is removed; Python is the only app.
  - Run with `uvicorn app:app --reload`, open http://localhost:8000. For the phone on the LAN add `--host 0.0.0.0` (the summary endpoint is rate-limited; there's no access token any more).
  - Install with `pip install -r requirements-dev.txt` (adds pytest and httpx for tests).
- **Needs from you:** review `app.py` and `static/` changes, since they're your files. Speech (MERaLion) and Hokkien output are still to do; the summary is English.
- **Local-only info:** `.env` needs `OPENCODE_API_KEY` (copy `.env.template`).

### 2026-11-20, darrenlsx (logo)
- **Pushed:** branch `feature/logo`: app logo `static/logo.svg` (信 in a speech bubble, blue `#0b5ed7`, same as the main button), shown in the phone header and used as the favicon
- **State:** Works in the OCR demo (`static/`). Not yet in `public/index.html` (the Node page).
- **Decisions:** We picked 信 ("letter") because the users read Chinese rather than English. The speech bubble stands for "read aloud to you".
- **Needs from you:** In the Python port, please serve `static/logo.svg` and use it in the header and as the favicon (`<link rel="icon" type="image/svg+xml" href="/static/logo.svg">`).
- **Local-only info:** none

### 2026-11-20, OzzyOw (translation function for Hokkien TTS)
- **Pushed:** `main` (from branch `translation-feature`): `translate/` package and `tests/test_translate.py`
- **State:** `from translate import translate`; `translate(summary_text)` returns `{text, confident, missing_details}`. `text` is plain spoken-style Chinese for the Hokkien TTS: no pinyin, markdown, brackets or English. 14 tests pass (`python -m pytest tests/test_translate.py`). Live check against `deepseek-v4.1-flash` passed (about 7s, all numbers kept, an injected "ignore previous instructions" line was translated as data, not obeyed). Not wired into `app.py`; no endpoint yet.
- **Decisions:**
  - Same model, endpoint and env vars as the summary (`OPENCODE_API_KEY`, optional `LLM_BASE_URL`, `LLM_MODEL`). No new vars. Standard library only.
  - Call it with `summarise(...)["summary"]`. It does not import the summariser: `main` only has the Node one, and the Python port is on `feature/ocr-summary` (not merged). The HTTP helper is duplicated; dedupe once both are merged.
  - Output is Simplified Chinese (Singapore) by default; `translate(text, script="traditional")` switches. Both are standard written Chinese, not Hokkien-specific characters, because the TTS engine isn't chosen yet. If it wants Hokkien Hanji or Tâi-lô, change `SYSTEM_PROMPT` in `translate/engine.py`.
  - Numbers stay as Arabic digits (dates as 2026年4月11日, money as 1,284.50新币). A code check confirms every digit run in the English appears in the Chinese; one retry, then `confident` is False and the missing numbers are listed. The text is never altered after the model returns it.
  - `confident` False (or `TranslateError`) should become the spoken "try once more" / "ask family" prompt from the brief; that endpoint/UI part is not done.
- **Needs from you:** which TTS engine and what text form it wants (Simplified, Traditional, Hanji or Tâi-lô, and whether it reads digits correctly in Hokkien). Whoever merges `feature/ocr-summary` and this branch: add `POST /api/translate` (or extend `/api/summary`) in `app.py`.
- **Local-only info:** `.env` needs `OPENCODE_API_KEY`, same as the summary. Tests use fake model calls and need no key.

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
