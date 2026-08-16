#!/usr/bin/env python3
"""Invoke one Hermes benchmark prompt without Windows shell argument rewriting."""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import subprocess
import sys


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--hermes-python", required=True)
    parser.add_argument("--prompt-file", required=True)
    parser.add_argument("--usage-file", required=True)
    parser.add_argument("--stdout-file", required=True)
    parser.add_argument("--stderr-file", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--provider", required=True)
    parser.add_argument("--reasoning", required=True)
    parser.add_argument("--timeout-seconds", type=int, default=900)
    return parser.parse_args()


def write_text(path: str, content: str) -> None:
    Path(path).write_text(content, encoding="utf-8", newline="")


def main() -> int:
    args = parse_args()
    prompt = Path(args.prompt_file).read_text(encoding="utf-8")
    command = [
        args.hermes_python,
        "-m",
        "hermes_cli.main",
        "-z",
        prompt,
        "--usage-file",
        args.usage_file,
        "-m",
        args.model,
        "--provider",
        args.provider,
        "--reasoning",
        args.reasoning,
        "-t",
        "skills",
        "--ignore-rules",
    ]
    try:
        completed = subprocess.run(
            command,
            env=os.environ.copy(),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=args.timeout_seconds,
            check=False,
        )
    except subprocess.TimeoutExpired as error:
        stdout = error.stdout or ""
        stderr = error.stderr or ""
        if isinstance(stdout, bytes):
            stdout = stdout.decode("utf-8", errors="replace")
        if isinstance(stderr, bytes):
            stderr = stderr.decode("utf-8", errors="replace")
        write_text(args.stdout_file, stdout)
        write_text(
            args.stderr_file,
            stderr + f"\nHermes benchmark timed out after {args.timeout_seconds} seconds.\n",
        )
        return 124

    write_text(args.stdout_file, completed.stdout)
    write_text(args.stderr_file, completed.stderr)
    return completed.returncode


if __name__ == "__main__":
    sys.exit(main())
