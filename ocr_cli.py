"""Command-line test for the OCR module.

Usage:  python ocr_cli.py path/to/letter.jpg [--out result.txt]
"""

import argparse
import sys
import time
from pathlib import Path

from ocr import extract_text


def main() -> int:
    parser = argparse.ArgumentParser(description="Extract text from a letter image.")
    parser.add_argument("image", help="PNG or JPEG file")
    parser.add_argument("--out", help="also save the text to this file")
    args = parser.parse_args()

    start = time.perf_counter()
    try:
        text = extract_text(args.image)
    except (FileNotFoundError, ValueError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1
    seconds = time.perf_counter() - start

    print(text)
    print(f"\n--- {seconds:.1f}s ---", file=sys.stderr)
    if args.out:
        Path(args.out).write_text(text, encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
