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

const BLURRY_MESSAGE = "Photo was blurry. Please take the picture again.";

function showError(message) {
  errorEl.textContent = message;
  errorEl.hidden = false;
}

function resetSummary() {
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

function renderSummary(data, totalSeconds) {
  summaryStatus.hidden = true;
  setMark(Boolean(data.confident));
  summaryEl.textContent = data.summary;

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
  summaryTiming.textContent = `Explained in ${data.seconds}s · ${totalSeconds.toFixed(1)}s from photo`;
}

// Only the latest photo may update the screen. A new photo aborts the previous
// photo's requests, and any reply that still arrives late is ignored.
let currentRun = 0;
let controller = null;
const isCurrent = (run) => run === currentRun;

async function summarise(text, startedAt, run, signal) {
  summaryCard.hidden = false;
  summaryStatus.hidden = false;
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
    renderSummary(data, (performance.now() - startedAt) / 1000);
  } catch (err) {
    if (!isCurrent(run) || err.name === "AbortError") return;
    showCross(`${err.message} Please try once more.`);
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
    showError("Please choose a PNG or JPEG photo.");
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
    if (!res.ok) throw new Error(data.detail || "Something went wrong. Please try again.");
    ocr = data;
  } catch (err) {
    if (!isCurrent(run) || err.name === "AbortError") return;
    statusEl.hidden = true;
    showError(err.message);
    return;
  }

  statusEl.hidden = true;
  const text = ocr.text || "";
  textEl.textContent = text || "(No text found. Try a clearer photo.)";
  timingEl.textContent = `Read in ${ocr.seconds}s`;
  textCard.hidden = false;

  // The server decides: enough text, read with enough confidence.
  if (!ocr.readable) {
    showCross(BLURRY_MESSAGE);
    return;
  }
  await summarise(text, startedAt, run, signal);
});
