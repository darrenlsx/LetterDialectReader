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

function showError(message) {
  errorEl.textContent = message;
  errorEl.hidden = false;
}

input.addEventListener("change", async () => {
  const file = input.files[0];
  if (!file) return;

  errorEl.hidden = true;
  textCard.hidden = true;

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
  try {
    const res = await fetch("/api/ocr", { method: "POST", body: form });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || "出了问题，请再试一次。Something went wrong. Please try again.");
    textEl.textContent = data.text || "找不到文字，请拍清楚一点。(No text found. Try a clearer photo.)";
    timingEl.textContent = `Read in ${data.seconds}s`;
    textCard.hidden = false;
  } catch (err) {
    showError(err.message);
  } finally {
    statusEl.hidden = true;
    input.value = "";
  }
});
