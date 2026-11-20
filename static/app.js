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
    showError("Please choose a PNG or JPEG photo.");
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
    if (!res.ok) throw new Error(data.detail || "Something went wrong. Please try again.");
    textEl.textContent = data.text || "(No text found. Try a clearer photo.)";
    timingEl.textContent = `Read in ${data.seconds}s`;
    textCard.hidden = false;
  } catch (err) {
    showError(err.message);
  } finally {
    statusEl.hidden = true;
    input.value = "";
  }
});
