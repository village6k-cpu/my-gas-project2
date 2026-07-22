#!/usr/bin/env python3
"""Small, shell-free Tesseract adapter used by the Windows sync worker."""

from __future__ import annotations

from pathlib import Path
import shutil
import subprocess
import sys


def find_tesseract() -> str | None:
    found = shutil.which("tesseract")
    if found:
        return found
    candidates = [
        Path(r"C:\Program Files\Tesseract-OCR\tesseract.exe"),
        Path(r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe"),
    ]
    return next((str(path) for path in candidates if path.is_file()), None)


def main() -> int:
    if len(sys.argv) != 2:
        sys.stderr.write("usage: slack-image-ocr.py <image-path>\n")
        return 2
    image = Path(sys.argv[1])
    if not image.is_file():
        sys.stderr.write("이미지를 찾지 못했습니다\n")
        return 3
    tesseract = find_tesseract()
    if not tesseract:
        sys.stderr.write("tesseract를 찾지 못했습니다\n")
        return 4

    languages = subprocess.run(
        [tesseract, "--list-langs"],
        text=True,
        capture_output=True,
        timeout=15,
        check=False,
    )
    available = {line.strip() for line in languages.stdout.splitlines() if line.strip()}
    selected = "+".join(language for language in ("kor", "eng") if language in available)
    if not selected:
        sys.stderr.write("kor 또는 eng Tesseract 언어 데이터가 없습니다\n")
        return 5

    result = subprocess.run(
        [tesseract, str(image), "stdout", "-l", selected, "--psm", "6"],
        text=True,
        capture_output=True,
        timeout=40,
        check=False,
    )
    if result.returncode != 0:
        sys.stderr.write((result.stderr or "OCR 실패")[:1_000])
        return result.returncode or 6
    sys.stdout.write(result.stdout.strip())
    if result.stdout.strip():
        sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except subprocess.TimeoutExpired:
        sys.stderr.write("OCR 시간 초과\n")
        raise SystemExit(7)
