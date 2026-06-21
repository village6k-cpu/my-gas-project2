#!/usr/bin/env python3
"""Inject the Village Kakao DOM watcher into the automation Chrome tab via CDP.

This is a fallback/guard for cases where Chrome's unpacked extension is missing,
disabled, or loaded under the wrong Chrome sub-profile. It injects the same
content.js watcher into the Kakao chat-list page and provides a tiny chrome.storage
shim so the extension script can run outside the extension isolated world.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import secrets
import socket
import struct
import sys
import time
from typing import Any
from urllib.request import urlopen
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CONTENT_JS = ROOT / "kakao-dom-watcher-extension" / "content.js"


class CDPWebSocket:
    def __init__(self, ws_url: str, timeout: float = 5.0) -> None:
        self.ws_url = ws_url
        self.timeout = timeout
        self.sock: socket.socket | None = None
        self.next_id = 0

    def connect(self) -> None:
        parsed = urlparse(self.ws_url)
        host = parsed.hostname or "127.0.0.1"
        port = parsed.port or (443 if parsed.scheme == "wss" else 80)
        path = parsed.path or "/"
        if parsed.query:
            path += "?" + parsed.query
        key = base64.b64encode(secrets.token_bytes(16)).decode("ascii")
        sock = socket.create_connection((host, port), timeout=self.timeout)
        request = (
            f"GET {path} HTTP/1.1\r\n"
            f"Host: {host}:{port}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n"
            "\r\n"
        )
        sock.sendall(request.encode("ascii"))
        response = b""
        while b"\r\n\r\n" not in response:
            chunk = sock.recv(4096)
            if not chunk:
                raise RuntimeError("WebSocket handshake closed")
            response += chunk
            if len(response) > 65536:
                raise RuntimeError("WebSocket handshake too large")
        header = response.split(b"\r\n\r\n", 1)[0].decode("iso-8859-1", "replace")
        if " 101 " not in header.split("\r\n", 1)[0]:
            raise RuntimeError(f"WebSocket handshake failed: {header.splitlines()[0] if header else header}")
        accept_expected = base64.b64encode(
            hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode("ascii")).digest()
        ).decode("ascii")
        if accept_expected not in header:
            raise RuntimeError("WebSocket handshake accept key mismatch")
        self.sock = sock

    def close(self) -> None:
        if self.sock:
            try:
                self.sock.close()
            finally:
                self.sock = None

    def _read_exact(self, n: int) -> bytes:
        assert self.sock is not None
        chunks = []
        remaining = n
        while remaining:
            chunk = self.sock.recv(remaining)
            if not chunk:
                raise RuntimeError("WebSocket closed")
            chunks.append(chunk)
            remaining -= len(chunk)
        return b"".join(chunks)

    def _send_text(self, text: str) -> None:
        assert self.sock is not None
        payload = text.encode("utf-8")
        header = bytearray([0x81])
        length = len(payload)
        if length < 126:
            header.append(0x80 | length)
        elif length < 65536:
            header.append(0x80 | 126)
            header.extend(struct.pack("!H", length))
        else:
            header.append(0x80 | 127)
            header.extend(struct.pack("!Q", length))
        mask = secrets.token_bytes(4)
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        self.sock.sendall(bytes(header) + mask + masked)

    def _recv_text(self) -> str:
        while True:
            b1, b2 = self._read_exact(2)
            opcode = b1 & 0x0F
            masked = bool(b2 & 0x80)
            length = b2 & 0x7F
            if length == 126:
                length = struct.unpack("!H", self._read_exact(2))[0]
            elif length == 127:
                length = struct.unpack("!Q", self._read_exact(8))[0]
            mask = self._read_exact(4) if masked else b""
            payload = self._read_exact(length) if length else b""
            if masked:
                payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
            if opcode == 0x1:
                return payload.decode("utf-8", "replace")
            if opcode == 0x8:
                raise RuntimeError("WebSocket close frame received")
            if opcode in (0x9, 0xA):
                continue

    def call(self, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        self.next_id += 1
        msg_id = self.next_id
        self._send_text(json.dumps({"id": msg_id, "method": method, "params": params or {}}, separators=(",", ":")))
        while True:
            msg = json.loads(self._recv_text())
            if msg.get("id") == msg_id:
                return msg


def load_pages(port: int) -> list[dict[str, Any]]:
    with urlopen(f"http://127.0.0.1:{port}/json/list", timeout=3) as r:
        return json.loads(r.read().decode("utf-8"))


def choose_kakao_page(pages: list[dict[str, Any]]) -> dict[str, Any]:
    for page in pages:
        url = page.get("url", "")
        if page.get("type") == "page" and "business.kakao.com" in url and "/chats" in url:
            return page
    for page in pages:
        url = page.get("url", "")
        if page.get("type") == "page" and "center-pf.kakao.com" in url and "chats" in url:
            return page
    raise RuntimeError("No Kakao chat-list page found in automation Chrome DevTools")


def build_injection(content_js: str) -> str:
    shim = r"""
(() => {
  const existing = globalThis.chrome && typeof globalThis.chrome === 'object' ? globalThis.chrome : {};
  const storage = existing.storage && typeof existing.storage === 'object' ? existing.storage : {};
  if (!storage.sync) {
    storage.sync = { get(defaults, callback) { callback({ ...(defaults || {}) }); } };
  } else if (!storage.sync.get) {
    storage.sync.get = function(defaults, callback) { callback({ ...(defaults || {}) }); };
  }
  if (!storage.onChanged) {
    storage.onChanged = { addListener() {} };
  } else if (!storage.onChanged.addListener) {
    storage.onChanged.addListener = function() {};
  }
  existing.storage = storage;
  globalThis.chrome = existing;
})();
"""
    return shim + "\n" + content_js + "\n//# sourceURL=village-kakao-dom-watcher-cdp-injected.js\n"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=int(os.environ.get("KAKAO_REMOTE_DEBUGGING_PORT", "9223")))
    parser.add_argument("--content-js", default=str(DEFAULT_CONTENT_JS))
    parser.add_argument("--wait", type=float, default=10.0, help="seconds to wait for the Kakao tab")
    args = parser.parse_args()

    content_path = Path(args.content_js)
    content_js = content_path.read_text(encoding="utf-8")

    deadline = time.time() + args.wait
    last_error: Exception | None = None
    page: dict[str, Any] | None = None
    while time.time() < deadline:
        try:
            page = choose_kakao_page(load_pages(args.port))
            break
        except Exception as exc:  # noqa: BLE001
            last_error = exc
            time.sleep(0.5)
    if not page:
        raise RuntimeError(str(last_error) if last_error else "Kakao page not found")

    ws_url = page.get("webSocketDebuggerUrl")
    if not ws_url:
        raise RuntimeError("Kakao page has no webSocketDebuggerUrl")

    cdp = CDPWebSocket(ws_url)
    cdp.connect()
    try:
        cdp.call("Runtime.enable")
        cdp.call("Page.enable")
        injection = build_injection(content_js)
        cdp.call("Page.addScriptToEvaluateOnNewDocument", {"source": injection})
        result = cdp.call("Runtime.evaluate", {
            "expression": injection,
            "awaitPromise": True,
            "returnByValue": True,
        })
        if result.get("result", {}).get("exceptionDetails"):
            raise RuntimeError(json.dumps(result["result"]["exceptionDetails"], ensure_ascii=False))
        verify = cdp.call("Runtime.evaluate", {
            "expression": "(() => ({hasWatcher: !!window.__villageKakaoWatcherInstance, started: window.__villageKakaoWatcherInstance?.state?.started ?? null, href: location.href, title: document.title, visibility: document.visibilityState}))()",
            "awaitPromise": True,
            "returnByValue": True,
        })
        value = verify.get("result", {}).get("result", {}).get("value")
        print(json.dumps({"ok": bool(value and value.get("hasWatcher") and value.get("started")), "pageTitle": page.get("title"), "pageUrl": page.get("url"), "watcher": value}, ensure_ascii=False))
        return 0 if value and value.get("hasWatcher") and value.get("started") else 2
    finally:
        cdp.close()


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        raise SystemExit(1)
