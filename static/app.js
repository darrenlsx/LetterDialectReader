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

// Same minimum as the server: shorter OCR text means the photo was unreadable.
const MIN_TEXT_CHARS = 20;
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

async function summarise(text, startedAt) {
  summaryCard.hidden = false;
  summaryStatus.hidden = false;
  try {
    const res = await fetch("/api/summary", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || "Something went wrong. Please try again.");
    renderSummary(data, (performance.now() - startedAt) / 1000);
  } catch (err) {
    showCross(`${err.message} Please try once more.`);
  }
}

input.addEventListener("change", async () => {
  const file = input.files[0];
  if (!file) return;

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
  let text;
  try {
    const res = await fetch("/api/ocr", { method: "POST", body: form });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || "Something went wrong. Please try again.");
    text = data.text || "";
    textEl.textContent = text || "(No text found. Try a clearer photo.)";
    timingEl.textContent = `Read in ${data.seconds}s`;
    textCard.hidden = false;
  } catch (err) {
    showError(err.message);
    return;
  } finally {
    statusEl.hidden = true;
    input.value = "";
  }

  if (text.trim().length < MIN_TEXT_CHARS) {
    showCross(BLURRY_MESSAGE);
    return;
  }
  await summarise(text, startedAt);
});
