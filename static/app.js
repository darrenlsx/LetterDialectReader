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

renderDialects();
if (currentDialect) openPhotoScreen();
else showScreen("screen-language");

// ---------- Photo / OCR ----------
const input = document.getElementById("photo");
const preview = document.getElementById("preview");
const statusEl = document.getElementById("status");
const errorEl = document.getElementById("error");
const textCard = document.getElementById("text-card");
const textEl = document.getElementById("text");
const timingEl = document.getElementById("timing");

const summaryCard = document.getElementById("summary-card");
const markEl = document.getElementById("mark");
const summaryStatus = document.getElementById("summary-status");
const summaryEl = document.getElementById("summary");
const warnEl = document.getElementById("warn");
const detailsHeading = document.getElementById("details-heading");
const detailsEl = document.getElementById("details");
const summaryTiming = document.getElementById("summary-timing");

// The translation lives inside the summary card: only the Chinese text is shown.
const translationStatus = document.getElementById("translation-status");
const translationEl = document.getElementById("translation");
const translationWarn = document.getElementById("translation-warn");

const BLURRY_MESSAGE = "Photo was blurry. Please take the picture again.";

function showError(message) {
  errorEl.textContent = message;
  errorEl.hidden = false;
}

function resetTranslation() {
  translationStatus.hidden = true;
  translationEl.textContent = "";
  translationWarn.hidden = true;
  translationWarn.textContent = "";
}

function resetSummary() {
  resetTranslation();
  summaryCard.hidden = true;
  markEl.textContent = "";
  markEl.className = "mark";
  summaryStatus.hidden = true;
  summaryEl.textContent = "";
  warnEl.hidden = true;
  warnEl.textContent = "";
  detailsHeading.hidden = true;
  detailsEl.textContent = "";
  summaryTiming.textContent = "";
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

  const details = data.key_details || [];
  detailsHeading.hidden = details.length === 0;
  for (const d of details) {
    const li = document.createElement("li");
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = d.type;
    li.append(tag, d.text);
    detailsEl.append(li);
  }
}

// Only the latest photo may update the screen. A new photo aborts the previous
// photo's requests, and any reply that still arrives late is ignored.
let currentRun = 0;
let controller = null;
const isCurrent = (run) => run === currentRun;

async function summarise(text, startedAt, run, signal) {
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
    summaryTiming.textContent = `Explained in ${data.seconds}s`;
  } catch (err) {
    if (!isCurrent(run) || err.name === "AbortError") return;
    showCross(`${err.message} Please try once more.`);
  }
  // The summary flows straight into translation; no tap needed.
  if (summarised) await translateSummary(summarised, startedAt, run, signal);
}

async function translateSummary(text, startedAt, run, signal) {
  translationStatus.hidden = false;
  const explained = summaryTiming.textContent;
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
    summaryTiming.textContent = `${explained} · Translated in ${data.seconds}s · ${((performance.now() - startedAt) / 1000).toFixed(1)}s from photo`;
  } catch (err) {
    if (!isCurrent(run) || err.name === "AbortError") return;
    translationStatus.hidden = true;
    translationWarn.textContent = `${err.message} Please try once more.`;
    translationWarn.hidden = false;
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
  const startedAt = performance.now();

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
  timingEl.textContent = `Read in ${ocr.seconds}s`;
  textCard.hidden = false;

  // The server decides: enough text, read with enough confidence.
  if (!ocr.readable) {
    showCross(BLURRY_MESSAGE);
    return;
  }
  await summarise(text, startedAt, run, signal);
});
