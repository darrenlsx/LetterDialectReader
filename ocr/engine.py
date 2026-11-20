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


def _run_paddleocr(image: np.ndarray) -> list[tuple[str, list[float], float]]:
    """Return (text, [x0, y0, x1, y1], score) for every recognised text line."""
    ocr = _get_ocr()
    with _ocr_lock:  # the pipeline is not guaranteed to be thread-safe
        results = ocr.predict(image)
    lines: list[tuple[str, list[float], float]] = []
    for res in results:
        texts = res["rec_texts"]
        boxes = res["rec_boxes"]
        scores = res.get("rec_scores") or [1.0] * len(texts)
        for text, box, score in zip(texts, boxes, scores):
            if text.strip():
                lines.append((text, [float(v) for v in box], float(score)))
    return lines


def _to_reading_order(lines: list[tuple[str, list[float], float]]) -> str:
    """Group boxes into rows (top to bottom), then sort each row left to right."""
    if not lines:
        return ""
    items = sorted(lines, key=lambda item: (item[1][1] + item[1][3]) / 2)
    rows: list[list[tuple[str, list[float], float]]] = []
    for item in items:
        x0, y0, x1, y1 = item[1]
        centre = (y0 + y1) / 2
        if rows:
            last = rows[-1]
            ly0 = min(it[1][1] for it in last)
            ly1 = max(it[1][3] for it in last)
            if ly0 <= centre <= ly1:
                last.append(item)
                continue
        rows.append([item])
    return "\n".join(
        " ".join(item[0] for item in sorted(row, key=lambda it: it[1][0]))
        for row in rows
    )


def extract_text(image_path: str | Path) -> str:
    """Read a PNG/JPEG image of a letter and return its text in reading order."""
    return extract_text_with_confidence(image_path)[0]


def extract_text_with_confidence(image_path: str | Path) -> tuple[str, float]:
    """Like `extract_text`, plus the mean recognition score (0-1) of the lines,
    weighted by line length. 0.0 when no text was found. A low score usually
    means a blurry or badly lit photo."""
    lines = _read_lines(image_path)
    total = sum(len(text) for text, _, _ in lines)
    confidence = sum(len(text) * score for text, _, score in lines) / total if total else 0.0
    return _to_reading_order(lines), confidence


def _read_lines(image_path: str | Path) -> list[tuple[str, list[float], float]]:
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
    return _run_paddleocr(bgr)
