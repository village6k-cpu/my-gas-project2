#!/usr/bin/env python3
"""Invoke one Hermes benchmark prompt without Windows shell argument rewriting."""

from __future__ import annotations

import argparse
from hashlib import sha256
import json
import os
from pathlib import Path
import subprocess
import sys


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--ab-plan", action="store_true")
    parser.add_argument("--replay-fixture")
    parser.add_argument("--model-contract")
    parser.add_argument("--output-plan")
    parser.add_argument("--sample-count", type=int, default=20)
    parser.add_argument("--warmup-count", type=int, default=1)
    parser.add_argument("--hermes-python")
    parser.add_argument("--prompt-file")
    parser.add_argument("--usage-file")
    parser.add_argument("--stdout-file")
    parser.add_argument("--stderr-file")
    parser.add_argument("--model")
    parser.add_argument("--provider")
    parser.add_argument("--reasoning")
    parser.add_argument("--timeout-seconds", type=int, default=900)
    return parser.parse_args()


def require_arguments(args: argparse.Namespace, names: list[str], mode: str) -> None:
    missing = [name for name in names if not getattr(args, name)]
    if missing:
        formatted = ", ".join(f"--{name.replace('_', '-')}" for name in missing)
        raise ValueError(f"{mode} requires {formatted}")


def write_ab_plan(args: argparse.Namespace) -> int:
    require_arguments(args, ["replay_fixture", "model_contract", "output_plan"], "--ab-plan")
    if args.sample_count < 20:
        raise ValueError("--sample-count must be at least 20")
    if args.warmup_count < 1:
        raise ValueError("--warmup-count must be at least 1")
    fixture_path = Path(args.replay_fixture).resolve()
    contract_path = Path(args.model_contract).resolve()
    fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
    contract = json.loads(contract_path.read_text(encoding="utf-8"))
    events = fixture.get("events") if isinstance(fixture, dict) else None
    config = contract.get("kakaoworker") if isinstance(contract, dict) else None
    if fixture.get("schema") != "village-kakao-hermes-replay/v1" or not isinstance(events, list) or not events:
        raise ValueError("unsupported or empty replay fixture")
    if not isinstance(config, dict):
        raise ValueError("model contract has no kakaoworker config")
    preserved_config = {
        "provider": config.get("provider"),
        "model": config.get("model"),
        "reasoning_effort": config.get("reasoning_effort"),
        "max_turns": config.get("max_turns"),
        "disabled_toolsets": config.get("disabled_toolsets", []),
    }
    if preserved_config != {
        "provider": "xai-oauth",
        "model": "grok-4.5",
        "reasoning_effort": "xhigh",
        "max_turns": 90,
        "disabled_toolsets": ["computer_use"],
    }:
        raise ValueError("kakaoworker model/provider/reasoning/tool contract drifted")

    invocation_count = args.warmup_count + args.sample_count
    invocations = []
    for index in range(invocation_count):
        event = events[index % len(events)]
        raw = event.get("raw") if isinstance(event, dict) else {}
        invocations.append(
            {
                "ordinal": index + 1,
                "case_id": event.get("job_id"),
                "scenario": raw.get("scenario") if isinstance(raw, dict) else None,
                "measured": index >= args.warmup_count,
            }
        )
    fixture_digest = sha256(fixture_path.read_bytes()).hexdigest()
    plan = {
        "schema": "village-kakao-hermes-benchmark-plan/v1",
        "fixture_sha256": fixture_digest,
        "config": preserved_config,
        "warmup_count": args.warmup_count,
        "sample_count": args.sample_count,
        "transports": [
            {
                "name": "baseline",
                "transport": "cli",
                "process_model": "one_shot_cli",
                "invocations": invocations,
            },
            {
                "name": "gateway",
                "transport": "gateway_no_send",
                "process_model": "persistent_native_gateway",
                "invocations": [dict(item) for item in invocations],
            },
        ],
    }
    Path(args.output_plan).write_text(
        json.dumps(plan, ensure_ascii=True, indent=2) + "\n", encoding="utf-8", newline=""
    )
    print(json.dumps({"ok": True, "mode": "ab_plan", "sample_count": args.sample_count}))
    return 0


def write_text(path: str, content: str) -> None:
    Path(path).write_text(content, encoding="utf-8", newline="")


def main() -> int:
    args = parse_args()
    if args.ab_plan:
        return write_ab_plan(args)
    require_arguments(
        args,
        [
            "hermes_python",
            "prompt_file",
            "usage_file",
            "stdout_file",
            "stderr_file",
            "model",
            "provider",
            "reasoning",
        ],
        "legacy single invocation",
    )
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
