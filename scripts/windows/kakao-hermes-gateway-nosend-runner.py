"""Offline-only native Kakao Gateway lifecycle replay with a loopback fake bridge."""

from __future__ import annotations

import argparse
import asyncio
from collections import deque
from hashlib import sha256
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import sys
import threading
import time
from types import SimpleNamespace
from typing import Any


SAFE_ENVIRONMENT = {
    "AI_WORKER_LIVE": "0",
    "AI_WORKER_AUTO_SEND": "0",
    "AI_WORKER_DRY_RUN": "1",
    "VILLAGE_WINDOWS_WRITES_ENABLED": "0",
    "SLACK_AGENT_CARD_DELIVERY_ENABLED": "0",
    "SLACK_ACTION_POLL_ENABLED": "0",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--fixture", required=True)
    parser.add_argument("--plugin-source", required=True)
    parser.add_argument("--profile-home", required=True)
    return parser.parse_args()


def plugin_manifest(plugin_source: Path) -> tuple[list[dict[str, Any]], str]:
    manifest = []
    for path in sorted(plugin_source.rglob("*"), key=lambda candidate: candidate.as_posix()):
        if not path.is_file() or path.suffix.lower() not in {".py", ".yaml", ".yml", ".md"}:
            continue
        relative = path.relative_to(plugin_source).as_posix()
        if "__pycache__" in path.parts or "/tests/" in f"/{relative}/":
            continue
        digest = sha256(path.read_bytes()).hexdigest()
        manifest.append({"path": relative, "sha256": digest})
    canonical = json.dumps(manifest, separators=(",", ":"), ensure_ascii=True).encode("ascii")
    return manifest, sha256(canonical).hexdigest()


class FakeBridge:
    def __init__(self, events: list[dict[str, Any]]) -> None:
        self.events = deque(events)
        self.token = "offline-token-not-a-secret"
        self.confirmations: list[dict[str, Any]] = []
        self.results: list[dict[str, Any]] = []
        self.outcomes: list[dict[str, Any]] = []
        self.operations: list[str] = []
        self._server = ThreadingHTTPServer(("127.0.0.1", 0), self._handler())
        self._thread = threading.Thread(target=self._server.serve_forever, name="fake-kakao-bridge", daemon=True)

    @property
    def url(self) -> str:
        host, port = self._server.server_address[:2]
        return f"http://{host}:{port}"

    @property
    def thread_id(self) -> int | None:
        return self._thread.ident

    def __enter__(self) -> "FakeBridge":
        self._thread.start()
        return self

    def __exit__(self, *_unused: object) -> None:
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(timeout=2)
        if self._thread.is_alive():
            raise RuntimeError("fake bridge did not stop")

    def _handler(self) -> type[BaseHTTPRequestHandler]:
        bridge = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:  # noqa: N802
                if not self._authorized():
                    self._respond(401, {"error": "unauthorized"})
                    return
                event = bridge.events.popleft() if bridge.events else None
                self._respond(200, {"event": event})

            def do_POST(self) -> None:  # noqa: N802
                if not self._authorized():
                    self._respond(401, {"error": "unauthorized"})
                    return
                payload = self._body()
                if self.path == "/hermes/v1/tools/confirmation-request":
                    bridge.operations.append("confirmation")
                    receipt = {
                        "schema": "village-confirmation-receipt/v1",
                        "receipt_id": f"offline-receipt-{payload['job_id']}",
                        "job_id": payload["job_id"],
                        "room_key": payload["room_key"],
                        "room_revision": payload["room_revision"],
                        "lease_id": payload["lease_id"],
                        "status": "owner_review_required",
                        "availability_report": [
                            {"equipment": "합성카메라", "status": "available"},
                            {"equipment": "합성렌즈", "status": "warning"},
                            {"equipment": "합성배터리", "status": "unavailable"},
                        ],
                        "authoritative_sheet_result": None,
                        "created_at": "2099-01-01T00:00:10Z",
                        "error": None,
                    }
                    bridge.confirmations.append(receipt)
                    self._respond(200, receipt)
                    return
                if self.path == "/hermes/v1/results":
                    bridge.operations.append("result")
                    bridge.results.append(payload)
                    self._respond(200, {"ok": True})
                    return
                if self.path == "/hermes/v1/outcomes":
                    bridge.outcomes.append(payload)
                    self._respond(200, {"ok": True})
                    return
                self._respond(404, {"error": "not_found"})

            def log_message(self, _format: str, *_args: object) -> None:
                return

            def _authorized(self) -> bool:
                return self.headers.get("Authorization") == f"Bearer {bridge.token}"

            def _body(self) -> dict[str, Any]:
                length = int(self.headers.get("Content-Length", "0"))
                value = json.loads(self.rfile.read(length).decode("utf-8"))
                if not isinstance(value, dict):
                    raise ValueError("body must be an object")
                return value

            def _respond(self, status: int, payload: dict[str, Any]) -> None:
                body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        return Handler


def validate_environment(profile_home: Path) -> None:
    for name, expected in SAFE_ENVIRONMENT.items():
        if os.environ.get(name) != expected:
            raise RuntimeError(f"unsafe offline environment: {name}")
    resolved_profile = profile_home.resolve()
    temp_root = Path(os.environ.get("TEMP", os.environ.get("TMP", ""))).resolve()
    if temp_root not in resolved_profile.parents or not resolved_profile.name.startswith("kakao-hermes-nosend-"):
        raise RuntimeError("profile home is not an isolated temporary Kakao replay profile")


async def run_replay(
    fixture: dict[str, Any],
    adapter: Any,
    bridge: FakeBridge,
    confirmation_handler: Any,
    processing_outcome: Any,
) -> tuple[list[dict[str, Any]], list[dict[str, str]], int]:
    turns: list[dict[str, Any]] = []
    sessions: list[dict[str, str]] = []
    active_native_turns = 0
    max_native_turns = 0
    event_sequence = {
        event["lease_id"]: index for index, event in enumerate(fixture["events"])
    }

    async def fake_native_agent(message: Any) -> None:
        nonlocal active_native_turns, max_native_turns
        started = time.perf_counter_ns()
        active_native_turns += 1
        max_native_turns = max(max_native_turns, active_native_turns)
        await adapter.on_processing_start(message)
        raw = message.raw_message["raw"]
        scenario = raw["scenario"]
        attempt = raw["attempt"]
        session_key = adapter._native_session_key(message)
        sequence = event_sequence[message.metadata["_kakao_bridge_lease_id"]]
        sessions.append({"_sequence": sequence, "job_id": message.message_id, "room_key": message.source.chat_id, "session_key": session_key})
        turn = {
            "_sequence": sequence,
            "job_id": message.message_id,
            "room_key": message.source.chat_id,
            "scenario": scenario,
            "attempt": attempt,
            "session_key": session_key,
            "native_agent_runs": 1,
            "confirmation_tool_calls": 0,
            "post_action_agent_runs": 0,
            "owner_review_required": scenario not in {"faq", "faq_parallel_room"},
            "availability_statuses": [],
            "terminal": "success",
        }
        outcome = processing_outcome.SUCCESS
        try:
            if raw.get("parallel_group"):
                await asyncio.sleep(0.02)
            if scenario in {"faq", "faq_parallel_room"}:
                await adapter.send(message.source.chat_id, json.dumps({"answer": "합성 FAQ 응답"}), metadata={"notify": True})
            elif scenario == "schedule_mixed_availability":
                before = len(bridge.confirmations)
                result = json.loads(confirmation_handler({
                    "job_id": message.message_id,
                    "room_key": message.source.chat_id,
                    "room_revision": message.raw_message["room_revision"],
                    "decision": {
                        "should_write_to_sheet": False,
                        "sheet_row_candidate": {"equipment": "합성카메라 세트"},
                    },
                }, bridge_client=adapter._bridge))
                if result.get("error") is not None:
                    raise RuntimeError(f"offline confirmation tool failed: {result['error']}")
                turn["confirmation_tool_calls"] = len(bridge.confirmations) - before
                turn["availability_statuses"] = [row["status"] for row in result["availability_report"]]
                await adapter.send(
                    message.source.chat_id,
                    json.dumps({"answer": "일정 확인 결과는 담당자 검토 후 안내됩니다.", "owner_review_required": True}),
                    metadata={"notify": True},
                )
            elif scenario == "malformed_final":
                await adapter.send(message.source.chat_id, '{"answer":', metadata={"notify": True})
                turn["terminal"] = "human_review"
            elif scenario == "stale_revision":
                result = json.loads(confirmation_handler({
                    "job_id": message.message_id,
                    "room_key": message.source.chat_id,
                    "room_revision": message.raw_message["room_revision"] + 1,
                    "decision": {"should_write_to_sheet": False, "sheet_row_candidate": {}},
                }, bridge_client=adapter._bridge))
                if "error" not in result:
                    raise RuntimeError("stale revision was not rejected")
                turn["terminal"] = "human_review"
                outcome = processing_outcome.FAILURE
            elif scenario == "timeout_then_success" and attempt == 1:
                turn["terminal"] = "retry"
                outcome = processing_outcome.FAILURE
            elif scenario == "timeout_then_success" and attempt == 2:
                await adapter.send(
                    message.source.chat_id,
                    json.dumps({"answer": "재시도 완료, 담당자 검토 대기", "owner_review_required": True}),
                    metadata={"notify": True},
                )
            elif scenario == "timeout_terminal":
                turn["terminal"] = "retry" if attempt == 1 else "human_review"
                outcome = processing_outcome.FAILURE
            else:
                raise RuntimeError(f"unsupported replay scenario: {scenario}")
        finally:
            await adapter.on_processing_complete(message, outcome)
            turn["elapsed_ms"] = round((time.perf_counter_ns() - started) / 1_000_000, 3)
            turns.append(turn)
            active_native_turns -= 1

    adapter.handle_message = fake_native_agent
    index = 0
    events = fixture["events"]
    while index < len(events):
        group = events[index].get("raw", {}).get("parallel_group")
        if group:
            group_size = 1
            while index + group_size < len(events) and events[index + group_size].get("raw", {}).get("parallel_group") == group:
                group_size += 1
            claimed = await asyncio.gather(*(adapter._poll_once() for _ in range(group_size)))
            if not all(claimed):
                raise RuntimeError("fake bridge lost a parallel replay event")
            index += group_size
            continue
        if not await adapter._poll_once():
            raise RuntimeError("fake bridge lost a replay event")
        index += 1
    if await adapter._poll_once():
        raise RuntimeError("fake bridge returned an unexpected extra event")
    turns.sort(key=lambda turn: turn.pop("_sequence"))
    sessions.sort(key=lambda session: session.pop("_sequence"))
    return turns, sessions, max_native_turns


def main() -> int:
    args = parse_args()
    fixture_path = Path(args.fixture).resolve()
    plugin_source = Path(args.plugin_source).resolve()
    profile_home = Path(args.profile_home).resolve()
    validate_environment(profile_home)
    fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
    if fixture.get("schema") != "village-kakao-hermes-replay/v1":
        raise RuntimeError("unsupported offline replay fixture")

    sys.path.insert(0, str(plugin_source.parent))
    from gateway.platforms.base import ProcessingOutcome  # pylint: disable=import-outside-toplevel
    from gateway.platform_registry import PlatformEntry, platform_registry  # pylint: disable=import-outside-toplevel
    from kakao_village.adapter import KakaoVillageAdapter  # pylint: disable=import-outside-toplevel
    from kakao_village.confirmation_tool import handle_confirmation_request  # pylint: disable=import-outside-toplevel
    from kakao_village.http_client import BridgeClient  # pylint: disable=import-outside-toplevel

    manifest, manifest_digest = plugin_manifest(plugin_source)
    started = time.perf_counter_ns()
    platform_registry.register(
        PlatformEntry(
            name="kakao_village",
            label="Kakao Village offline replay",
            adapter_factory=lambda config: None,
            check_fn=lambda: True,
        )
    )
    with FakeBridge(fixture["events"]) as bridge:
        client = BridgeClient(bridge.url, bridge.token)
        adapter = KakaoVillageAdapter(
            config=SimpleNamespace(extra={}, typing_indicator=False),
            bridge_client=client,
            consumer_id="offline-nosend-replay",
        )
        turns, sessions, max_native_turns = asyncio.run(
            run_replay(fixture, adapter, bridge, handle_confirmation_request, ProcessingOutcome)
        )
        evidence = {
            "schema": "village-kakao-hermes-nosend-evidence/v1",
            "profile": {"name": "kakaoworker-offline", "isolated": True},
            "plugin": {
                "loaded_from_reviewed_source": True,
                "path": str(plugin_source),
                "manifest_sha256": manifest_digest,
                "manifest": manifest,
            },
            "loads": {"plugin": 1, "agent": 1},
            "concurrency": {"max_native_turns": max_native_turns},
            "processes": [
                {"role": "gateway_lifecycle_harness", "pid": os.getpid(), "command": f"{Path(sys.executable).name} kakao-hermes-gateway-nosend-runner.py"},
                {"role": "loopback_fake_bridge", "pid": os.getpid(), "thread_id": bridge.thread_id, "command": "in-process loopback HTTP fake bridge"},
            ],
            "sessions": sessions,
            "turns": turns,
            "confirmations": bridge.confirmations,
            "outcomes": {"results": bridge.results, "terminals": bridge.outcomes, "operations": bridge.operations},
            "timings": {"total_elapsed_ms": round((time.perf_counter_ns() - started) / 1_000_000, 3)},
            "safety": {
                "kakao_send_count": 0,
                "slack_send_count": 0,
                "gas_write_count": 0,
                "windows_write_count": 0,
                "forbidden_processes_started": [],
            },
        }
    # ASCII-only JSON survives Windows PowerShell 5.1's legacy stdout decoding.
    print(json.dumps(evidence, ensure_ascii=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
