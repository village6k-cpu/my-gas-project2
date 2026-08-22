#!/usr/bin/env python3
"""Run a provider-backed, no-send Kakao Hermes CLI/Gateway A/B benchmark."""

from __future__ import annotations

from collections import deque
import argparse
from hashlib import sha256
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import math
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import statistics
import sys
import threading
import time
from typing import Any
import uuid


EVIDENCE_SCHEMA = "village-kakao-hermes-benchmark-evidence/v1"
MODEL_CONFIG = {
    "provider": "xai-oauth",
    "model": "grok-4.5",
    "reasoning_effort": "xhigh",
    "max_turns": 90,
    "disabled_toolsets": ["computer_use"],
}
SAFE_ENVIRONMENT = {
    "AI_WORKER_LIVE": "0",
    "AI_WORKER_AUTO_SEND": "0",
    "AI_WORKER_DRY_RUN": "1",
    "VILLAGE_WINDOWS_WRITES_ENABLED": "0",
    "SLACK_AGENT_CARD_DELIVERY_ENABLED": "0",
    "SLACK_ACTION_POLL_ENABLED": "0",
    "KAKAO_HERMES_TRANSPORT": "gateway_no_send",
}
PROVIDER_ERROR_MARKERS = (
    "provider error",
    "authentication failed",
    "failed to generate",
    "unable to generate",
    "rate limit",
)


def _p95(values: list[float]) -> float:
    ordered = sorted(values)
    if not ordered:
        return 0.0
    return float(ordered[max(0, math.ceil(len(ordered) * 0.95) - 1)])


def build_evidence(
    common_config: dict[str, Any],
    baseline_samples: list[dict[str, Any]],
    gateway_samples: list[dict[str, Any]],
) -> dict[str, Any]:
    """Build analyzer input only after both arms have provider-call proof."""
    if len(baseline_samples) < 20 or len(gateway_samples) < 20:
        raise ValueError("provider benchmark requires at least 20 samples per arm")
    provider_proven = all(
        isinstance(sample, dict) and int(sample.get("provider_calls", 0)) > 0
        for sample in baseline_samples + gateway_samples
    )
    baseline_totals = [float(sample["total_ms"]) for sample in baseline_samples]
    config = dict(common_config)
    return {
        "schema": EVIDENCE_SCHEMA,
        "measurement_kind": "provider_backed" if provider_proven else "unproven_provider",
        "baseline": {
            "sample_count": len(baseline_samples),
            "total_median_ms": float(statistics.median(baseline_totals)),
            "total_p95_ms": _p95(baseline_totals),
            "config": dict(config),
            "samples": baseline_samples,
        },
        "gateway": {"config": dict(config), "samples": gateway_samples},
    }


def write_profile_config(profile_home: Path, *, workspace: Path) -> None:
    """Write the exact common model/tool contract into an isolated profile."""
    profile_home.mkdir(parents=True, exist_ok=True)
    workspace.mkdir(parents=True, exist_ok=True)
    workspace_yaml = str(workspace.resolve()).replace("\\", "/")
    content = f"""model:
  default: grok-4.5
  provider: xai-oauth
providers:
  xai-oauth:
    stale_timeout_seconds: 480
agent:
  reasoning_effort: xhigh
  max_turns: 90
  disabled_toolsets: [computer_use]
terminal:
  cwd: \"{workspace_yaml}\"
  home_mode: profile
curator:
  enabled: false
plugins:
  enabled: [kakao_village]
platforms:
  kakao_village:
    enabled: true
    allow_from: [village-kakao-bridge]
platform_toolsets:
  cli: [skills, village]
  kakao_village: [skills, village]
"""
    (profile_home / "config.yaml").write_text(content, encoding="utf-8", newline="")


class LoopbackBenchmarkBridge:
    """One-at-a-time loopback bridge that cannot reach Kakao, Slack, or GAS."""

    def __init__(self, events: list[dict[str, Any]]) -> None:
        self._events = deque(dict(event) for event in events)
        self._claimed: dict[str, dict[str, Any]] = {}
        self._terminals: dict[str, dict[str, Any]] = {}
        self._condition = threading.Condition()
        self._confirmations: dict[str, int] = {}
        self.token = secrets.token_urlsafe(24)
        self._server = ThreadingHTTPServer(("127.0.0.1", 0), self._handler())
        self._thread = threading.Thread(
            target=self._server.serve_forever,
            name="kakao-provider-benchmark-loopback",
            daemon=True,
        )

    @property
    def url(self) -> str:
        host, port = self._server.server_address[:2]
        return f"http://{host}:{port}"

    def __enter__(self) -> "LoopbackBenchmarkBridge":
        self._thread.start()
        return self

    def __exit__(self, *_unused: object) -> None:
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(timeout=3)
        if self._thread.is_alive():
            raise RuntimeError("benchmark loopback bridge did not stop")

    def wait_for_terminal(self, job_id: str, *, timeout_seconds: float) -> dict[str, Any]:
        deadline = time.monotonic() + timeout_seconds
        with self._condition:
            while job_id not in self._terminals:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError(f"benchmark turn did not complete: {job_id}")
                self._condition.wait(remaining)
            return dict(self._terminals[job_id])

    def _handler(self) -> type[BaseHTTPRequestHandler]:
        bridge = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:  # noqa: N802
                if not self._authorized():
                    self._respond(401, {"error": "unauthorized"})
                    return
                event = None
                with bridge._condition:
                    if bridge._events and not bridge._claimed:
                        event = bridge._events.popleft()
                        bridge._claimed[event["job_id"]] = {
                            "event": event,
                            "claimed_ns": time.perf_counter_ns(),
                        }
                self._respond(200, {"event": event})

            def do_POST(self) -> None:  # noqa: N802
                if not self._authorized():
                    self._respond(401, {"error": "unauthorized"})
                    return
                body = self._body()
                job_id = str(body.get("job_id") or "")
                with bridge._condition:
                    claimed = bridge._claimed.get(job_id)
                if claimed is None:
                    self._respond(409, {"error": "unknown_or_unclaimed_job"})
                    return
                event = claimed["event"]
                if any(
                    body.get(field) != event[field]
                    for field in ("job_id", "room_key", "room_revision", "lease_id")
                ):
                    self._respond(409, {"error": "stale_lease"})
                    return
                if self.path == "/hermes/v1/tools/confirmation-request":
                    bridge._confirmations[job_id] = bridge._confirmations.get(job_id, 0) + 1
                    self._respond(
                        200,
                        {
                            "schema": "village-confirmation-receipt/v1",
                            "receipt_id": f"benchmark-receipt-{job_id}",
                            "job_id": event["job_id"],
                            "room_key": event["room_key"],
                            "room_revision": event["room_revision"],
                            "lease_id": event["lease_id"],
                            "status": "owner_review_required",
                            "availability_report": [],
                            "authoritative_sheet_result": None,
                            "created_at": "2099-01-01T00:00:00Z",
                            "error": None,
                        },
                    )
                    return
                if self.path == "/hermes/v1/results":
                    self._finish(job_id, event, claimed, "result", body)
                    return
                if self.path == "/hermes/v1/outcomes":
                    self._finish(
                        job_id,
                        event,
                        claimed,
                        str(body.get("outcome") or "outcome"),
                        body,
                    )
                    return
                self._respond(404, {"error": "not_found"})

            def _finish(
                self,
                job_id: str,
                event: dict[str, Any],
                claimed: dict[str, Any],
                terminal: str,
                body: dict[str, Any],
            ) -> None:
                elapsed_ms = (time.perf_counter_ns() - claimed["claimed_ns"]) / 1_000_000
                scenario = str(event.get("raw", {}).get("scenario") or "")
                schedule = "schedule" in scenario
                content = str(body.get("content") or "")
                provider_result = bool(content.strip()) and not any(
                    marker in content.casefold() for marker in PROVIDER_ERROR_MARKERS
                )
                sample = {
                    "case_id": str(event.get("raw", {}).get("case_id") or job_id),
                    "total_ms": round(elapsed_ms, 3),
                    "agent_ms": round(elapsed_ms, 3),
                    "process_starts": 0,
                    "post_action_agent_runs": 0,
                    "session_reused": bool(event.get("raw", {}).get("session_reused")),
                    "schedule": schedule,
                    "owner_review_required": (
                        not schedule or bridge._confirmations.get(job_id, 0) == 1
                    ),
                    "send_count": 0,
                    "write_count": 0,
                    "provider_calls": 1 if terminal == "result" and provider_result else 0,
                    "terminal": terminal,
                    "response_sha256": sha256(content.encode("utf-8")).hexdigest() if content else None,
                }
                with bridge._condition:
                    bridge._terminals[job_id] = sample
                    bridge._claimed.pop(job_id, None)
                    bridge._condition.notify_all()
                self._respond(200, {"ok": True})

            def _authorized(self) -> bool:
                return self.headers.get("Authorization") == f"Bearer {bridge.token}"

            def _body(self) -> dict[str, Any]:
                length = int(self.headers.get("Content-Length", "0"))
                decoded = json.loads(self.rfile.read(length).decode("utf-8"))
                if not isinstance(decoded, dict):
                    raise ValueError("benchmark bridge request must be an object")
                return decoded

            def _respond(self, status: int, payload: dict[str, Any]) -> None:
                body = json.dumps(payload, ensure_ascii=True, separators=(",", ":")).encode("ascii")
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, _format: str, *_args: object) -> None:
                return

        return Handler


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--hermes-python", type=Path, required=True)
    parser.add_argument("--plugin-source", type=Path, required=True)
    parser.add_argument("--live-profile", type=Path, required=True)
    parser.add_argument("--fixture", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--results-root", type=Path, required=True)
    parser.add_argument("--sample-count", type=int, default=20)
    parser.add_argument("--warmup-count", type=int, default=1)
    parser.add_argument("--timeout-seconds", type=int, default=900)
    parser.add_argument("--smoke", action="store_true")
    return parser.parse_args()


def _digest_tree(root: Path) -> str:
    rows: list[dict[str, Any]] = []
    for path in sorted(root.rglob("*"), key=lambda item: item.as_posix()):
        if not path.is_file() or "__pycache__" in path.parts or path.suffix.lower() == ".pyc":
            continue
        rows.append(
            {
                "path": path.relative_to(root).as_posix(),
                "sha256": sha256(path.read_bytes()).hexdigest(),
            }
        )
    return sha256(json.dumps(rows, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()


def _copy_tree(source: Path, target: Path) -> None:
    def ignored(_directory: str, names: list[str]) -> set[str]:
        return {name for name in names if name == "__pycache__" or name.endswith(".pyc")}

    shutil.copytree(source, target, ignore=ignored)


def _prepare_profile(
    profile_home: Path,
    *,
    live_profile: Path,
    plugin_source: Path,
    run_id: str,
    arm: str,
) -> None:
    if profile_home.exists():
        raise FileExistsError(f"refusing existing benchmark profile: {profile_home}")
    profile_home.mkdir(parents=True)
    (profile_home / ".village-provider-benchmark-profile").write_text(
        json.dumps({"run_id": run_id, "arm": arm}), encoding="utf-8", newline=""
    )
    write_profile_config(profile_home, workspace=profile_home / "workspace")
    skills_source = live_profile / "skills"
    if not skills_source.is_dir():
        raise FileNotFoundError(f"live kakaoworker skills missing: {skills_source}")
    _copy_tree(skills_source, profile_home / "skills")
    _copy_tree(plugin_source, profile_home / "plugins" / "kakao_village")


def _cleanup_profile(profile_home: Path, profiles_root: Path, run_id: str) -> None:
    resolved = profile_home.resolve()
    if resolved.parent != profiles_root.resolve():
        raise RuntimeError("refusing benchmark cleanup outside the Hermes profiles root")
    if not resolved.name.startswith(f"native-provider-bench-{run_id}-"):
        raise RuntimeError("refusing benchmark cleanup with an unexpected profile name")
    marker = resolved / ".village-provider-benchmark-profile"
    if not marker.is_file():
        raise RuntimeError("refusing benchmark cleanup without ownership marker")
    payload = json.loads(marker.read_text(encoding="utf-8"))
    if payload.get("run_id") != run_id:
        raise RuntimeError("refusing benchmark cleanup with a mismatched marker")
    last_error: OSError | None = None
    for _attempt in range(20):
        try:
            shutil.rmtree(resolved)
            return
        except FileNotFoundError:
            return
        except OSError as error:
            last_error = error
            time.sleep(0.25)
    if last_error is not None:
        raise last_error


def _terminate_owned_process_tree(process: subprocess.Popen[str]) -> None:
    """Stop only the Gateway process tree this benchmark started."""
    if process.poll() is not None:
        return
    if os.name == "nt":
        completed = subprocess.run(
            ["taskkill", "/PID", str(process.pid), "/T", "/F"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=False,
        )
        if completed.returncode not in {0, 128} and process.poll() is None:
            raise RuntimeError("failed to terminate the owned Gateway process tree")
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired as error:
            raise RuntimeError("owned Gateway process tree did not exit") from error
        return
    process.terminate()
    try:
        process.wait(timeout=15)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=10)


def _capture_gateway_diagnostics(profile_home: Path, results_root: Path) -> None:
    """Preserve synthetic-only Gateway diagnostics before profile cleanup."""
    target = results_root / "gateway-profile-diagnostics"
    target.mkdir(parents=True, exist_ok=True)
    logs = profile_home / "logs"
    if logs.is_dir():
        shutil.copytree(logs, target / "logs", dirs_exist_ok=True)
    for name in ("state.db", "gateway_state.json"):
        source = profile_home / name
        if source.is_file():
            shutil.copy2(source, target / name)


def _benchmark_prompt(event: dict[str, Any], ordinal: int) -> str:
    scenario = str(event.get("raw", {}).get("scenario") or "faq")
    schedule_instruction = ""
    if "schedule" in scenario:
        schedule_instruction = (
            "\nThis is a schedule/availability request. Use village_confirmation_request exactly once. "
            "The result is owner-review only and must never be marked for customer auto-send."
        )
    return (
        "ISOLATED PROVIDER-BACKED KAKAOWORKER BENCHMARK. Synthetic facts only.\n"
        "Never contact a customer, send Kakao/Slack, write GAS/Sheets, browse, or run terminal commands.\n"
        "Use native Hermes reasoning and the minimum matching Village skill.\n"
        f"Benchmark ordinal: {ordinal}.\n"
        f"{event['prompt']}"
        f"{schedule_instruction}\n"
        "Return a concise answer for the worker."
    )


def _make_events(fixture_path: Path, count: int) -> list[dict[str, Any]]:
    fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
    source = [
        event
        for event in fixture.get("events", [])
        if event.get("raw", {}).get("scenario") in {"faq", "schedule_mixed_availability"}
    ]
    if not source or not any("schedule" in str(item.get("raw", {}).get("scenario")) for item in source):
        raise ValueError("benchmark fixture requires FAQ and schedule scenarios")
    events: list[dict[str, Any]] = []
    for index in range(count):
        template = source[index % len(source)]
        raw = dict(template.get("raw") or {})
        raw.update(
            {
                "synthetic": True,
                "case_id": template["job_id"],
                "session_reused": index > 0,
            }
        )
        event = {
            "schema": "village-kakao-gateway-event/v1",
            "job_id": f"provider-benchmark-{index + 1:03d}",
            "room_key": "provider-benchmark-room",
            "room_revision": index + 1,
            "prompt": _benchmark_prompt(template, index + 1),
            "detected_at": "2099-01-01T00:00:00Z",
            "raw": raw,
            "lease_id": str(uuid.uuid4()),
        }
        events.append(event)
    return events


def _safe_environment(profile_home: Path) -> dict[str, str]:
    environment = os.environ.copy()
    environment.update(SAFE_ENVIRONMENT)
    environment["HERMES_HOME"] = str(profile_home)
    environment.pop("HERMES_PROFILE", None)
    return environment


def _run_baseline(
    events: list[dict[str, Any]],
    *,
    measured_from: int,
    hermes_python: Path,
    profile_home: Path,
    results_root: Path,
    timeout_seconds: int,
) -> list[dict[str, Any]]:
    samples: list[dict[str, Any]] = []
    environment = _safe_environment(profile_home)
    arm_root = results_root / "baseline"
    arm_root.mkdir(parents=True, exist_ok=True)
    for index, event in enumerate(events):
        run_root = arm_root / f"{index + 1:03d}"
        run_root.mkdir()
        usage_path = run_root / "usage.json"
        stdout_path = run_root / "stdout.log"
        stderr_path = run_root / "stderr.log"
        command = [
            str(hermes_python),
            "-m",
            "hermes_cli.main",
            "-z",
            event["prompt"],
            "--usage-file",
            str(usage_path),
            "--model",
            MODEL_CONFIG["model"],
            "--provider",
            MODEL_CONFIG["provider"],
            "--reasoning",
            MODEL_CONFIG["reasoning_effort"],
            "--toolsets",
            "skills,village",
            "--ignore-rules",
        ]
        started = time.perf_counter_ns()
        completed = subprocess.run(
            command,
            env=environment,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout_seconds,
            check=False,
        )
        elapsed_ms = round((time.perf_counter_ns() - started) / 1_000_000, 3)
        stdout_path.write_text(completed.stdout, encoding="utf-8", newline="")
        stderr_path.write_text(completed.stderr, encoding="utf-8", newline="")
        usage = json.loads(usage_path.read_text(encoding="utf-8")) if usage_path.is_file() else {}
        provider_calls = int(usage.get("api_calls", 0)) if completed.returncode == 0 else 0
        sample = {
            "case_id": event["raw"]["case_id"],
            "total_ms": elapsed_ms,
            "provider_calls": provider_calls,
            "process_starts": 1,
            "exit_code": completed.returncode,
            "failed": bool(usage.get("failed", True)),
        }
        print(
            json.dumps(
                {
                    "progress": "baseline",
                    "ordinal": index + 1,
                    "measured": index >= measured_from,
                    "elapsed_ms": elapsed_ms,
                    "provider_calls": provider_calls,
                },
                separators=(",", ":"),
            ),
            flush=True,
        )
        if completed.returncode != 0 or provider_calls <= 0 or sample["failed"]:
            raise RuntimeError(f"baseline provider turn failed at ordinal {index + 1}")
        if index >= measured_from:
            samples.append(sample)
    return samples


def _wait_gateway_terminal(
    bridge: LoopbackBenchmarkBridge,
    process: subprocess.Popen[str],
    job_id: str,
    timeout_seconds: int,
) -> dict[str, Any]:
    deadline = time.monotonic() + timeout_seconds
    while True:
        if process.poll() is not None:
            raise RuntimeError(f"native Gateway exited before {job_id}: {process.returncode}")
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError(f"native Gateway turn timed out: {job_id}")
        try:
            return bridge.wait_for_terminal(job_id, timeout_seconds=min(1.0, remaining))
        except TimeoutError:
            continue


def _run_gateway(
    events: list[dict[str, Any]],
    *,
    measured_from: int,
    hermes_python: Path,
    profile_home: Path,
    results_root: Path,
    timeout_seconds: int,
    verbose: bool = False,
) -> list[dict[str, Any]]:
    environment = _safe_environment(profile_home)
    stdout_path = results_root / "gateway.stdout.log"
    stderr_path = results_root / "gateway.stderr.log"
    samples: list[dict[str, Any]] = []
    with LoopbackBenchmarkBridge(events) as bridge:
        environment["VILLAGE_KAKAO_BRIDGE_URL"] = bridge.url
        environment["VILLAGE_KAKAO_BRIDGE_TOKEN"] = bridge.token
        environment["VILLAGE_KAKAO_CONSUMER_ID"] = "provider-benchmark"
        with stdout_path.open("w", encoding="utf-8", newline="") as stdout_handle, stderr_path.open(
            "w", encoding="utf-8", newline=""
        ) as stderr_handle:
            gateway_command = [
                str(hermes_python), "-m", "hermes_cli.main", "gateway", "run"
            ]
            if verbose:
                gateway_command.append("-vv")
            process = subprocess.Popen(
                gateway_command,
                env=environment,
                stdout=stdout_handle,
                stderr=stderr_handle,
                text=True,
            )
            try:
                for index, event in enumerate(events):
                    sample = _wait_gateway_terminal(
                        bridge, process, event["job_id"], timeout_seconds
                    )
                    print(
                        json.dumps(
                            {
                                "progress": "gateway",
                                "ordinal": index + 1,
                                "measured": index >= measured_from,
                                "elapsed_ms": sample["total_ms"],
                                "provider_calls": sample["provider_calls"],
                                "owner_review_required": sample["owner_review_required"],
                                "terminal": sample["terminal"],
                            },
                            separators=(",", ":"),
                        ),
                        flush=True,
                    )
                    if sample["provider_calls"] <= 0:
                        raise RuntimeError(f"Gateway provider turn was not proven at ordinal {index + 1}")
                    if sample["schedule"] and not sample["owner_review_required"]:
                        raise RuntimeError(f"Gateway schedule escaped owner review at ordinal {index + 1}")
                    if index >= measured_from:
                        samples.append(sample)
            finally:
                _terminate_owned_process_tree(process)
                _capture_gateway_diagnostics(profile_home, results_root)
    return samples


def _validate_paths(args: argparse.Namespace) -> tuple[Path, Path, Path, Path]:
    hermes_python = args.hermes_python.resolve()
    plugin_source = args.plugin_source.resolve()
    live_profile = args.live_profile.resolve()
    fixture = args.fixture.resolve()
    for path in (hermes_python, plugin_source / "plugin.yaml", live_profile / "config.yaml", fixture):
        if not path.exists():
            raise FileNotFoundError(f"provider benchmark dependency missing: {path}")
    hermes_root = hermes_python.parents[3]
    expected_live = hermes_root / "profiles" / "kakaoworker"
    if live_profile != expected_live.resolve():
        raise ValueError("live profile must be the resolved kakaoworker profile")
    return hermes_python, plugin_source, live_profile, fixture


def main() -> int:
    args = _parse_args()
    if args.warmup_count < 1:
        raise ValueError("warmup count must be at least 1")
    if args.smoke:
        if args.sample_count != 1:
            raise ValueError("smoke mode requires sample-count 1")
    elif args.sample_count < 20:
        raise ValueError("full provider benchmark requires at least 20 samples")
    hermes_python, plugin_source, live_profile, fixture = _validate_paths(args)
    run_id = time.strftime("%Y%m%d-%H%M%S") + "-" + secrets.token_hex(3)
    hermes_root = hermes_python.parents[3]
    profiles_root = hermes_root / "profiles"
    baseline_profile = profiles_root / f"native-provider-bench-{run_id}-baseline"
    gateway_profile = profiles_root / f"native-provider-bench-{run_id}-gateway"
    results_root = args.results_root.resolve()
    if results_root.exists():
        raise FileExistsError(f"refusing existing benchmark results root: {results_root}")
    results_root.mkdir(parents=True)
    (results_root / ".village-provider-benchmark-results").write_text(
        run_id, encoding="utf-8", newline=""
    )
    event_count = args.warmup_count + args.sample_count
    events = _make_events(fixture, event_count)
    profiles_created: list[Path] = []
    try:
        for profile, arm in ((baseline_profile, "baseline"), (gateway_profile, "gateway")):
            _prepare_profile(
                profile,
                live_profile=live_profile,
                plugin_source=plugin_source,
                run_id=run_id,
                arm=arm,
            )
            profiles_created.append(profile)
        skills_signature = _digest_tree(baseline_profile / "skills")
        if skills_signature != _digest_tree(gateway_profile / "skills"):
            raise RuntimeError("benchmark arm skill manifests differ")
        tools_signature = sha256(
            json.dumps(
                {"enabled": ["skills", "village"], "disabled": ["computer_use"]},
                sort_keys=True,
                separators=(",", ":"),
            ).encode("utf-8")
        ).hexdigest()
        common_config = {
            **MODEL_CONFIG,
            "tools_signature": tools_signature,
            "skills_signature": skills_signature,
            "plugin_signature": _digest_tree(plugin_source),
        }
        baseline_samples = _run_baseline(
            events,
            measured_from=args.warmup_count,
            hermes_python=hermes_python,
            profile_home=baseline_profile,
            results_root=results_root,
            timeout_seconds=args.timeout_seconds,
        )
        gateway_samples = _run_gateway(
            events,
            measured_from=args.warmup_count,
            hermes_python=hermes_python,
            profile_home=gateway_profile,
            results_root=results_root,
            timeout_seconds=args.timeout_seconds,
            verbose=args.smoke,
        )
        if args.smoke:
            evidence = {
                "schema": EVIDENCE_SCHEMA,
                "measurement_kind": "provider_backed_smoke",
                "baseline": {"sample_count": 1, "samples": baseline_samples, "config": common_config},
                "gateway": {"samples": gateway_samples, "config": common_config},
            }
        else:
            evidence = build_evidence(common_config, baseline_samples, gateway_samples)
        evidence["run_id"] = run_id
        evidence["safety"] = {
            "loopback_bridge_only": True,
            "kakao_send_count": 0,
            "slack_send_count": 0,
            "gas_write_count": 0,
            "profiles_isolated": True,
        }
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(
            json.dumps(evidence, ensure_ascii=True, indent=2) + "\n",
            encoding="utf-8",
            newline="",
        )
        print(json.dumps({"ok": True, "output": str(args.output), "run_id": run_id}), flush=True)
        return 0
    finally:
        for profile in reversed(profiles_created):
            _cleanup_profile(profile, profiles_root, run_id)


if __name__ == "__main__":
    sys.exit(main())
