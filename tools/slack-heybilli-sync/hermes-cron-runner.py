#!/usr/bin/env python3
"""Cross-platform Hermes cron entrypoint for Slack -> Heybilli reconciliation.

Hermes cron executes Python scripts with its own interpreter on Windows.  This
wrapper deliberately loads Slack credentials from the existing Hermes files via
the Node scanner, and calls Hermes oneshot in-process so a long Slack prompt is
not constrained by Windows' command-line length limit.
"""

from __future__ import annotations

import os
from pathlib import Path
import shutil
import subprocess
import sys


def repo_root() -> Path:
    configured = os.environ.get("SLACK_HEYBILLI_REPO_ROOT", "").strip()
    candidates = []
    if configured:
        candidates.append(Path(configured))
    if os.name == "nt":
        candidates.append(Path(r"C:\Village\my-gas-project2"))
    # This makes direct development/test execution work before the runner is
    # copied into ~/.hermes/scripts.
    candidates.append(Path(__file__).resolve().parents[2])

    for candidate in candidates:
        worker = candidate / "tools" / "slack-heybilli-sync" / "slack-heybilli-sync.mjs"
        if worker.is_file():
            return candidate.resolve()
    raise RuntimeError("Slack-Heybilli worker repo를 찾지 못했습니다")


def run() -> int:
    # This dedicated reconciliation job is independent of the Kakao/general
    # AI worker.  Keep those global live switches fail-closed on AX2.
    os.environ["AI_WORKER_LIVE"] = "0"
    os.environ["AI_WORKER_AUTO_SEND"] = "0"

    root = repo_root()
    worker = root / "tools" / "slack-heybilli-sync" / "slack-heybilli-sync.mjs"
    node = shutil.which("node")
    if not node:
        raise RuntimeError("node 실행 파일을 찾지 못했습니다")

    scan = subprocess.run(
        [node, str(worker), "scan", "--hermes"],
        cwd=root,
        text=True,
        capture_output=True,
        timeout=180,
        check=False,
    )
    if scan.returncode != 0:
        detail = (scan.stderr or scan.stdout or "scan 실패").strip()
        raise RuntimeError(detail[:2_000])

    prompt = scan.stdout.strip()
    if not prompt:
        return 0

    os.chdir(root)
    from hermes_cli.oneshot import run_oneshot

    return int(run_oneshot(prompt, toolsets="terminal"))


if __name__ == "__main__":
    try:
        raise SystemExit(run())
    except subprocess.TimeoutExpired:
        sys.stderr.write("slack-heybilli-sync: scan 시간 초과\n")
        raise SystemExit(1)
    except Exception as exc:  # noqa: BLE001 - cron needs one concise error
        sys.stderr.write(f"slack-heybilli-sync: {exc}\n")
        raise SystemExit(1)
