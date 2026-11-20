"""extract_text_with_confidence: reading order and length-weighted score.
The PaddleOCR model is replaced with fixed lines, so this runs fast."""

from PIL import Image

from ocr import engine


def _image(tmp_path):
    p = tmp_path / "letter.png"
    Image.new("RGB", (40, 20), "white").save(p)
    return p


def test_reading_order_and_weighted_confidence(tmp_path, monkeypatch):
    lines = [
        ("world", [60, 0, 100, 10], 0.5),
        ("Hello", [0, 0, 50, 10], 1.0),
        ("Second line here", [0, 20, 100, 30], 0.9),
    ]
    monkeypatch.setattr(engine, "_run_paddleocr", lambda image: lines)
    text, conf = engine.extract_text_with_confidence(_image(tmp_path))
    assert text == "Hello world\nSecond line here"
    expected = (5 * 0.5 + 5 * 1.0 + 16 * 0.9) / 26
    assert abs(conf - expected) < 1e-9
    assert engine.extract_text(_image(tmp_path)) == text


def test_no_text_gives_zero_confidence(tmp_path, monkeypatch):
    monkeypatch.setattr(engine, "_run_paddleocr", lambda image: [])
    assert engine.extract_text_with_confidence(_image(tmp_path)) == ("", 0.0)
