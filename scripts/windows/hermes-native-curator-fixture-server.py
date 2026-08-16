#!/usr/bin/env python3
"""Local OpenAI-compatible fixture used only by the isolated curator test."""

from __future__ import annotations

import argparse
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Lock
from time import time


FINAL_TEXT = """## Isolated curator review

No consolidation is appropriate for these deliberately distinct fixture skills.

```yaml
consolidations: []
prunings: []
```
"""


def _atomic_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(text, encoding="utf-8")
    temporary.replace(path)


def build_handler(request_log: Path):
    log_lock = Lock()

    class FixtureHandler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, _format: str, *_args) -> None:
            return

        def _record(self, *, model: str = "", stream: bool = False) -> None:
            record = {
                "at": time(),
                "method": self.command,
                "path": self.path,
                "model": model,
                "stream": stream,
            }
            with log_lock:
                request_log.parent.mkdir(parents=True, exist_ok=True)
                with request_log.open("a", encoding="utf-8") as handle:
                    handle.write(json.dumps(record, ensure_ascii=True) + "\n")

        def _send_json(self, status: int, payload: dict) -> None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
            self._record()
            if self.path.rstrip("/").endswith("models"):
                self._send_json(
                    200,
                    {
                        "object": "list",
                        "data": [
                            {
                                "id": "lifecycle-fixture-model",
                                "object": "model",
                                "owned_by": "isolated-test",
                            }
                        ],
                    },
                )
                return
            self._send_json(200, {"ok": True})

        def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
            length = int(self.headers.get("Content-Length", "0") or "0")
            raw = self.rfile.read(length) if length else b"{}"
            try:
                request = json.loads(raw.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                self._send_json(400, {"error": {"message": "invalid JSON"}})
                return

            model = str(request.get("model") or "lifecycle-fixture-model")
            stream = bool(request.get("stream"))
            self._record(model=model, stream=stream)

            if not self.path.rstrip("/").endswith("chat/completions"):
                self._send_json(404, {"error": {"message": "fixture endpoint not found"}})
                return

            if not stream:
                self._send_json(
                    200,
                    {
                        "id": "chatcmpl-lifecycle-fixture",
                        "object": "chat.completion",
                        "created": int(time()),
                        "model": model,
                        "choices": [
                            {
                                "index": 0,
                                "message": {"role": "assistant", "content": FINAL_TEXT},
                                "finish_reason": "stop",
                            }
                        ],
                        "usage": {
                            "prompt_tokens": 1,
                            "completion_tokens": 1,
                            "total_tokens": 2,
                        },
                    },
                )
                return

            created = int(time())
            chunks = [
                {
                    "id": "chatcmpl-lifecycle-fixture",
                    "object": "chat.completion.chunk",
                    "created": created,
                    "model": model,
                    "choices": [
                        {
                            "index": 0,
                            "delta": {"role": "assistant", "content": FINAL_TEXT},
                            "finish_reason": None,
                        }
                    ],
                },
                {
                    "id": "chatcmpl-lifecycle-fixture",
                    "object": "chat.completion.chunk",
                    "created": created,
                    "model": model,
                    "choices": [
                        {"index": 0, "delta": {}, "finish_reason": "stop"}
                    ],
                    "usage": {
                        "prompt_tokens": 1,
                        "completion_tokens": 1,
                        "total_tokens": 2,
                    },
                },
            ]
            body = "".join(
                f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n" for chunk in chunks
            ) + "data: [DONE]\n\n"
            encoded = body.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Content-Length", str(len(encoded)))
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(encoded)

    return FixtureHandler


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port-file", required=True, type=Path)
    parser.add_argument("--request-log", required=True, type=Path)
    args = parser.parse_args()

    server = ThreadingHTTPServer(("127.0.0.1", 0), build_handler(args.request_log))
    _atomic_text(args.port_file, str(server.server_address[1]))
    try:
        server.serve_forever(poll_interval=0.1)
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
