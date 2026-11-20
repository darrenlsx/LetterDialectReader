"""Command-line test for the Hokkien TTS module.

Usage:  python tts_cli.py "你阿母煮的菜真好食" [--out output/hello.wav]
Input must be Hokkien written in Chinese characters (it is not translated).
"""

import argparse
import sys
import time
from pathlib import Path

from tts import TtsError, synthesise


def main() -> int:
    parser = argparse.ArgumentParser(description="Speak Hokkien text and save it as a WAV file.")
    parser.add_argument("text", help="Hokkien in Chinese characters")
    parser.add_argument("--out", default="output/tts.wav", help="WAV file to write (default output/tts.wav)")
    args = parser.parse_args()

    start = time.perf_counter()
    try:
        wav = synthesise(args.text)
    except TtsError as exc:
        print(f"Error ({exc.code}): {exc.message}", file=sys.stderr)
        if exc.detail:
            print(f"Detail: {exc.detail}", file=sys.stderr)
        return 1
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(wav)
    print(f"Wrote {out} ({len(wav) / 1024:.0f} KB) in {time.perf_counter() - start:.1f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
