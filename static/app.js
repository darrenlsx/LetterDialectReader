// ---------- Dialect choice ----------
const DIALECTS = [
  { id: "hokkien", zh: "福建话", en: "Hokkien", available: true },
  { id: "cantonese", zh: "广东话", en: "Cantonese", available: false },
  { id: "teochew", zh: "潮州话", en: "Teochew", available: false },
];
const STORAGE_KEY = "letterReader.dialect";

function loadDialect() {
  try {
    const id = localStorage.getItem(STORAGE_KEY);
    return DIALECTS.find((d) => d.id === id && d.available) || null;
  } catch {
    return null;
  }
}

function saveDialect(id) {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    /* storage blocked: the choice just won't be remembered */
  }
}

let currentDialect = loadDialect();

const TRANSITION_CLASSES = ["enter-forward", "leave-forward", "enter-back", "leave-back"];
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// direction: "forward" (slide in from the right), "back" (slide back to the left) or null (instant)
function showScreen(id, direction = null) {
  const to = document.getElementById(id);
  const from = [...document.querySelectorAll(".screen")].find((s) => !s.hidden && s !== to);
  to.scrollTop = 0;

  if (!from || !direction || reduceMotion) {
    for (const el of document.querySelectorAll(".screen")) el.hidden = el !== to;
    return;
  }

  to.hidden = false;
  to.classList.add(`enter-${direction}`);
  from.classList.add(`leave-${direction}`);

  // Clean up once the slide (0.5s) and the content settle (0.15s + 0.6s) are done.
  // A timer rather than animationend, so it also works if animations are paused.
  setTimeout(() => {
    from.hidden = true;
    from.classList.remove(...TRANSITION_CLASSES);
    to.classList.remove(...TRANSITION_CLASSES);
  }, 800);
}

function renderDialects() {
  const list = document.getElementById("dialect-list");
  list.innerHTML = "";
  for (const d of DIALECTS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "dialect";
    btn.disabled = !d.available;
    btn.innerHTML =
      `<span><span class="zh">${d.zh}</span><span class="en">${d.en}</span></span>` +
      (d.available
        ? `<span class="check" aria-hidden="true"></span>`
        : `<span class="badge">即将推出<br>Coming soon</span>`);
    btn.addEventListener("click", () => chooseDialect(d, btn));
    list.appendChild(btn);
  }
}

function chooseDialect(dialect, btn) {
  for (const el of document.querySelectorAll(".dialect")) {
    el.classList.remove("selected");
    const check = el.querySelector(".check");
    if (check) check.textContent = "";
  }
  btn.classList.add("selected");
  const check = btn.querySelector(".check");
  check.textContent = "✓";
  check.classList.remove("pop");
  void check.offsetWidth; // restart the pop animation
  check.classList.add("pop");
  currentDialect = dialect;
  saveDialect(dialect.id);
  // Short pause so the tick is seen before the screen changes.
  setTimeout(() => openPhotoScreen("forward"), 650);
}

function openPhotoScreen(direction = null) {
  document.getElementById("dialect-chip").textContent = `${currentDialect.zh} ${currentDialect.en}`;
  showScreen("screen-photo", direction);
}

document.getElementById("change-lang").addEventListener("click", () => {
  renderDialects();
  showScreen("screen-language", "back");
});

// The app always opens on the dialect choice, even if one was picked last time.
renderDialects();
showScreen("screen-language");

// ---------- Photo / OCR ----------
const input = document.getElementById("photo");
const preview = document.getElementById("preview");
const statusEl = document.getElementById("status");
const errorEl = document.getElementById("error");
const textCard = document.getElementById("text-card");
const textEl = document.getElementById("text");

const summaryCard = document.getElementById("summary-card");
const markEl = document.getElementById("mark");
const summaryStatus = document.getElementById("summary-status");
const summaryEl = document.getElementById("summary");
const warnEl = document.getElementById("warn");

// The translation lives inside the summary card: only the Chinese text is shown.
const translationStatus = document.getElementById("translation-status");
const translationEl = document.getElementById("translation");
const translationWarn = document.getElementById("translation-warn");

// Listen card: the real Hokkien voice from POST /api/tts (slow on CPU).
// By default the whole text is made in ONE piece, so it is one consistent voice, and Play
// appears when it is all ready. Sentence chunks (SPEAK_IN_CHUNKS) let playback start
// before the end on a fast machine (GPU), but without a reference voice each chunk can
// sound like a different speaker, and on a CPU they bring no earlier start.
// static/sample_tts.wav is kept in the repo but no longer used here.
const SPEAK_IN_CHUNKS = false;
const listenCard = document.getElementById("listen-card");
const listenStatus = document.getElementById("listen-status");
const listenProgress = document.getElementById("listen-progress");
const playBtn = document.getElementById("play");
const player = document.getElementById("player");
const listenWarn = document.getElementById("listen-warn");

// Roughly one sentence per chunk: a small last chunk lets playback start earlier.
const CHUNK_MIN_CHARS = 12;
const CHUNK_MAX_CHARS = 40;
const SAFETY_MARGIN = 1.15;

let voice = newVoice();

function newVoice() {
  return {
    chunks: [], // [{ url, seconds }]
    total: 0, // number of chunks expected
    charsTotal: 0,
    charsDone: 0,
    genSeconds: 0, // time spent making the chunks so far
    audioSeconds: 0, // length of the audio made so far
    playable: false,
    done: false,
    playing: false, // the user wants it to play
    waiting: false, // playback reached a chunk that is not made yet
    index: 0, // chunk being played
  };
}

// Split after 。！？ and join neighbouring sentences into chunks of about 25-60 characters.
function splitForSpeech(text) {
  const sentences = (text.match(/[^。！？!?]+[。！？!?]*/g) || []).map((s) => s.trim()).filter(Boolean);
  const chunks = [];
  let current = "";
  for (const s of sentences) {
    if (current && (current.length >= CHUNK_MIN_CHARS || current.length + s.length > CHUNK_MAX_CHARS)) {
      chunks.push(current);
      current = "";
    }
    current += s;
  }
  if (current) chunks.push(current);
  return chunks;
}

// Length of a 16-bit PCM WAV (as written by tts/engine.py) from its header.
async function wavSeconds(blob) {
  const view = new DataView(await blob.slice(0, 44).arrayBuffer());
  const rate = view.getUint32(24, true);
  const channels = view.getUint16(22, true);
  const bytes = view.getUint32(40, true);
  return rate && channels ? bytes / (rate * channels * 2) : 0;
}

// Safe to start: the audio already made lasts at least as long as making the rest will take.
function safeToStart(v) {
  if (v.done) return true;
  if (!v.audioSeconds || !v.charsDone) return false;
  const speed = v.genSeconds / v.audioSeconds; // seconds of work per second of audio
  const remainingAudio = (v.charsTotal - v.charsDone) * (v.audioSeconds / v.charsDone);
  return v.audioSeconds >= speed * remainingAudio * SAFETY_MARGIN;
}

function playChunk(i) {
  if (i >= voice.chunks.length) {
    if (voice.done) {
      // Finished: the next tap starts again from the beginning.
      voice.playing = false;
      voice.index = 0;
      setPlaying(false);
    } else {
      voice.waiting = true;
      listenProgress.textContent = "稍等… Just a moment…";
      listenStatus.hidden = false;
    }
    return;
  }
  voice.index = i;
  voice.waiting = false;
  player.src = voice.chunks[i].url;
  player.play().catch(() => {});
}

const BLURRY_MESSAGE = "Photo was blurry. Please take the picture again.";

function showError(message) {
  errorEl.textContent = message;
  errorEl.hidden = false;
}

function resetListen() {
  player.pause();
  player.removeAttribute("src");
  for (const c of voice.chunks) URL.revokeObjectURL(c.url);
  voice = newVoice();
  listenCard.hidden = true;
  listenStatus.hidden = true;
  playBtn.hidden = true;
  setPlaying(false);
  listenWarn.hidden = true;
  listenWarn.textContent = "";
}

function setPlaying(playing) {
  playBtn.classList.toggle("playing", playing);
  playBtn.innerHTML = playing
    ? `<span class="play-icon" aria-hidden="true">❚❚</span> 暂停 <span class="en">Pause</span>`
    : `<span class="play-icon" aria-hidden="true">▶</span> 播放 <span class="en">Play</span>`;
}

playBtn.addEventListener("click", () => {
  if (!voice.playable) return;
  if (voice.playing) {
    voice.playing = false;
    player.pause();
    setPlaying(false);
    return;
  }
  voice.playing = true;
  setPlaying(true);
  if (player.getAttribute("src") && !player.ended) player.play().catch(() => {});
  else playChunk(voice.index);
});
// Chunks play back to back: the next one starts as soon as the current one ends.
player.addEventListener("ended", () => {
  if (voice.playing) playChunk(voice.index + 1);
});

function resetTranslation() {
  translationStatus.hidden = true;
  translationEl.textContent = "";
  translationWarn.hidden = true;
  translationWarn.textContent = "";
}

function resetSummary() {
  resetTranslation();
  resetListen();
  summaryCard.hidden = true;
  markEl.textContent = "";
  markEl.className = "mark";
  summaryStatus.hidden = true;
  summaryEl.textContent = "";
  warnEl.hidden = true;
  warnEl.textContent = "";
}

function setMark(ok) {
  markEl.textContent = ok ? "✓" : "✗";
  markEl.className = `mark ${ok ? "tick" : "cross"}`;
}

function showCross(message) {
  summaryCard.hidden = false;
  summaryStatus.hidden = true;
  setMark(false);
  summaryEl.textContent = message;
}

function renderSummary(data) {
  summaryStatus.hidden = true;
  setMark(Boolean(data.confident));
  // The English summary is not shown; the Chinese translation replaces it.

  const notes = [];
  if (!data.confident) notes.push("I am not fully sure about this letter. Please ask family to check it.");
  if (data.unclear_parts && data.unclear_parts.length) notes.push(`Unclear: ${data.unclear_parts.join(" | ")}`);
  warnEl.textContent = notes.join(" ");
  warnEl.hidden = notes.length === 0;
}

// Only the latest photo may update the screen. A new photo aborts the previous
// photo's requests, and any reply that still arrives late is ignored.
let currentRun = 0;
let controller = null;
const isCurrent = (run) => run === currentRun;

async function summarise(text, run, signal) {
  summaryCard.hidden = false;
  summaryStatus.hidden = false;
  let summarised = null;
  try {
    const res = await fetch("/api/summary", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
      signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!isCurrent(run)) return;
    if (!res.ok) throw new Error(data.detail || "Something went wrong. Please try again.");
    renderSummary(data);
    summarised = data.summary;
  } catch (err) {
    if (!isCurrent(run) || err.name === "AbortError") return;
    showCross(`${err.message} Please try once more.`);
  }
  // The summary flows straight into translation; no tap needed.
  if (summarised) await translateSummary(summarised, run, signal);
}

async function translateSummary(text, run, signal) {
  let translated = null;
  translationStatus.hidden = false;
  try {
    const res = await fetch("/api/translate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
      signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!isCurrent(run)) return;
    if (!res.ok) throw new Error(data.detail || "Something went wrong. Please try again.");
    translationStatus.hidden = true;
    translationEl.textContent = data.text;
    // Not confident: do not present the translation as reliable.
    const missing = data.missing_details || [];
    translationWarn.textContent = data.confident
      ? ""
      : `I could not translate this confidently${missing.length ? ` (missing: ${missing.join(", ")})` : ""}. Please ask family to check it.`;
    translationWarn.hidden = data.confident;
    // The voice reads the Hokkien-wording version (never shown on screen);
    // the Chinese is the fallback if the Hokkien rewrite failed.
    translated = data.hokkien || data.text;
  } catch (err) {
    if (!isCurrent(run) || err.name === "AbortError") return;
    translationStatus.hidden = true;
    translationWarn.textContent = `${err.message} Please try once more.`;
    translationWarn.hidden = false;
  }
  // The voice is prepared straight away (it is slow on CPU); the user taps Play when ready.
  if (translated) await speak(translated, run, signal);
}

async function speak(text, run, signal) {
  const parts = SPEAK_IN_CHUNKS ? splitForSpeech(text) : [text.trim()].filter(Boolean);
  if (!parts.length) return;
  voice.total = parts.length;
  voice.charsTotal = parts.reduce((n, p) => n + p.length, 0);
  listenCard.hidden = false;
  listenStatus.hidden = false;
  listenProgress.textContent =
    parts.length > 1
      ? `正在准备声音… 0/${parts.length} · Preparing the voice…`
      : "正在准备声音，请稍等… Preparing the voice, please wait…";

  for (let i = 0; i < parts.length; i++) {
    const tChunk = performance.now();
    let blob;
    try {
      const res = await fetch("/api/tts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: parts[i] }),
        signal,
      });
      if (!isCurrent(run)) return;
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.detail || "Could not make the voice. Please try again.");
      }
      blob = await res.blob();
      if (!isCurrent(run)) return;
    } catch (err) {
      if (!isCurrent(run) || err.name === "AbortError") return;
      listenStatus.hidden = true;
      listenWarn.textContent = `声音暂时不能用。${err.message}`;
      listenWarn.hidden = false;
      return;
    }

    const seconds = await wavSeconds(blob);
    if (!isCurrent(run)) return;
    voice.chunks.push({ url: URL.createObjectURL(blob), seconds });
    voice.genSeconds += (performance.now() - tChunk) / 1000;
    voice.audioSeconds += seconds;
    voice.charsDone += parts[i].length;
    voice.done = i === parts.length - 1;

    if (!voice.playable && safeToStart(voice)) {
      voice.playable = true;
      playBtn.hidden = false;
    }
    if (voice.waiting && voice.playing) playChunk(voice.index); // playback caught up: resume

    if (!voice.done) {
      listenProgress.textContent = `正在准备声音… ${i + 1}/${parts.length} · Preparing the voice…`;
      listenStatus.hidden = voice.playable && !voice.waiting;
    } else {
      listenStatus.hidden = true;
    }
  }
}

input.addEventListener("change", async () => {
  const file = input.files[0];
  if (!file) return;

  const run = ++currentRun;
  if (controller) controller.abort();
  controller = new AbortController();
  const { signal } = controller;

  errorEl.hidden = true;
  textCard.hidden = true;
  resetSummary();

  if (!["image/png", "image/jpeg"].includes(file.type)) {
    preview.hidden = true;
    showError("请选择照片 (PNG 或 JPEG)。Please choose a PNG or JPEG photo.");
    input.value = "";
    return;
  }

  preview.src = URL.createObjectURL(file);
  preview.hidden = false;
  statusEl.hidden = false;

  const form = new FormData();
  form.append("file", file);
  input.value = "";
  let ocr;
  try {
    const res = await fetch("/api/ocr", { method: "POST", body: form, signal });
    const data = await res.json().catch(() => ({}));
    if (!isCurrent(run)) return;
    if (!res.ok) throw new Error(data.detail || "出了问题，请再试一次。Something went wrong. Please try again.");
    ocr = data;
  } catch (err) {
    if (!isCurrent(run) || err.name === "AbortError") return;
    statusEl.hidden = true;
    showError(err.message);
    return;
  }

  statusEl.hidden = true;
  const text = ocr.text || "";
  textEl.textContent = text || "找不到文字，请拍清楚一点。(No text found. Try a clearer photo.)";
  textCard.hidden = false;

  // The server decides: enough text, read with enough confidence.
  if (!ocr.readable) {
    showCross(BLURRY_MESSAGE);
    return;
  }
  await summarise(text, run, signal);
});
