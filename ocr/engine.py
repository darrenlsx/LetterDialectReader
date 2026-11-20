"""OCR engine: turn a photo of a letter (PNG/JPEG) into plain text.

The public entry point is `extract_text`. The PaddleOCR-specific code lives in
`_run_paddleocr`, so another engine (e.g. PaddleOCR-VL on a GPU) can be swapped
in later without changing the function your teammate calls.
"""

from __future__ import annotations

import os
import threading
from pathlib import Path

import numpy as np
from PIL import Image

# Skip PaddleX's online model-host check on every start-up (models are cached).
os.environ.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True")

SUPPORTED_EXTENSIONS = {".png", ".jpg", ".jpeg"}

_ocr = None
_ocr_lock = threading.Lock()


class UnsupportedImageError(ValueError):
    """Raised when the input is not a PNG or JPEG file."""


def _get_ocr():
    """Load the PP-OCRv5 pipeline once and keep it in memory."""
    global _ocr
    with _ocr_lock:
        if _ocr is None:
            from paddleocr import PaddleOCR

            _ocr = PaddleOCR(
                # "mobile" models are much faster than "server" ones on CPU.
                text_detection_model_name="PP-OCRv5_mobile_det",
                text_recognition_model_name="PP-OCRv5_mobile_rec",
                # Needs paddlepaddle 3.2.x: 3.3's oneDNN (CPU speed-up) path
                # crashes ("ConvertPirAttribute2RuntimeAttribute not support").
                # Phone photos in the POC are upright portrait shots, so the
                # extra orientation/unwarping models are switched off for speed.
                use_doc_orientation_classify=False,
                use_doc_unwarping=False,
                use_textline_orientation=False,
            )
        return _ocr


def _run_paddleocr(image: np.ndarray) -> list[tuple[str, list[float]]]:
    """Return (text, [x0, y0, x1, y1]) for every recognised text line."""
    ocr = _get_ocr()
    with _ocr_lock:  # the pipeline is not guaranteed to be thread-safe
        results = ocr.predict(image)
    lines: list[tuple[str, list[float]]] = []
    for res in results:
        texts = res["rec_texts"]
        boxes = res["rec_boxes"]
        for text, box in zip(texts, boxes):
            if text.strip():
                lines.append((text, [float(v) for v in box]))
    return lines


def _to_reading_order(lines: list[tuple[str, list[float]]]) -> str:
    """Group boxes into rows (top to bottom), then sort each row left to right."""
    if not lines:
        return ""
    items = sorted(lines, key=lambda item: (item[1][1] + item[1][3]) / 2)
    rows: list[list[tuple[str, list[float]]]] = []
    for item in items:
        _, (x0, y0, x1, y1) = item
        centre = (y0 + y1) / 2
        if rows:
            last = rows[-1]
            ly0 = min(b[1] for _, b in last)
            ly1 = max(b[3] for _, b in last)
            if ly0 <= centre <= ly1:
                last.append(item)
                continue
        rows.append([item])
    return "\n".join(
        " ".join(text for text, _ in sorted(row, key=lambda it: it[1][0]))
        for row in rows
    )


def extract_text(image_path: str | Path) -> str:
    """Read a PNG/JPEG image of a letter and return its text in reading order."""
    path = Path(image_path)
    if not path.is_file():
        raise FileNotFoundError(f"Image not found: {path}")
    if path.suffix.lower() not in SUPPORTED_EXTENSIONS:
        raise UnsupportedImageError(
            f"Unsupported file type '{path.suffix}'. Please use a PNG or JPEG image."
        )
    try:
        with Image.open(path) as img:
            rgb = img.convert("RGB")
    except Exception as exc:  # corrupt or mislabelled file
        raise UnsupportedImageError(f"Could not open image: {exc}") from exc

    # PaddleOCR expects BGR pixel order (OpenCV convention).
    bgr = np.ascontiguousarray(np.asarray(rgb)[:, :, ::-1])
    return _to_reading_order(_run_paddleocr(bgr))
