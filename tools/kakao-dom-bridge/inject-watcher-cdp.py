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
import re
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
DEFAULT_SHIM_JS = ROOT / "kakao-dom-bridge" / "watcher-cdp-shim.js"
WATCHER_VERSION_RE = re.compile(r"const\s+WATCHER_VERSION\s*=\s*['\"]([^'\"]+)['\"]")
CHAT_LIST_PATH_RE = re.compile(r"/(?:_[^/]+/chats|_chats)/?")
CHAT_DETAIL_PATH_RE = re.compile(r"/_[^/]+/chats/[^/]+/?")


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


def is_authenticated_chat_path(path: str) -> bool:
    return bool(CHAT_LIST_PATH_RE.fullmatch(path) or CHAT_DETAIL_PATH_RE.fullmatch(path))


def chat_list_url(value: str) -> str:
    parsed = urlparse(value)
    host = (parsed.hostname or "").lower()
    if host not in {"business.kakao.com", "center-pf.kakao.com"}:
        raise RuntimeError("Kakao chat target host changed")
    match = re.fullmatch(r"(/_[^/]+/chats)(?:/[^/]+)?/?", parsed.path)
    if not match:
        if re.fullmatch(r"/_chats/?", parsed.path):
            return f"{parsed.scheme}://{parsed.netloc}/_chats"
        raise RuntimeError("Kakao chat target path changed")
    return f"{parsed.scheme}://{parsed.netloc}{match.group(1)}"


def classify_kakao_targets(pages: list[dict[str, Any]]) -> dict[str, Any]:
    page_count = 0
    authenticated = False
    login_required = False
    challenge_type: str | None = None
    for page in pages:
        if page.get("type") != "page":
            continue
        page_count += 1
        parsed = urlparse(str(page.get("url") or ""))
        host = (parsed.hostname or "").lower()
        path = parsed.path.lower()
        if host in {"business.kakao.com", "center-pf.kakao.com"} and is_authenticated_chat_path(path):
            authenticated = True
            continue
        if host != "accounts.kakao.com":
            continue
        if re.search(r"(?:two[-_]?step|two[-_]?factor|otp|verification)", path):
            challenge_type = "otp"
        elif "captcha" in path:
            challenge_type = "captcha"
        elif re.search(r"(?:device|approve)", path):
            challenge_type = "device"
        else:
            login_required = True
    state = "degraded"
    if authenticated:
        state = "watcher_repair_required"
    elif challenge_type:
        state = "second_factor_required"
    elif login_required:
        state = "login_required"
    return {
        "state": state,
        "cdpReady": True,
        "authenticated": authenticated,
        "watcherReady": False,
        "targetCount": page_count,
        "challengeType": challenge_type,
    }


def choose_kakao_page(pages: list[dict[str, Any]]) -> dict[str, Any]:
    detail_page: dict[str, Any] | None = None
    for page in pages:
        if page.get("type") != "page":
            continue
        parsed = urlparse(page.get("url", ""))
        is_kakao_host = parsed.hostname in {"business.kakao.com", "center-pf.kakao.com"}
        is_main_list = bool(
            re.fullmatch(r"/_[^/]+/chats/?", parsed.path)
            or re.fullmatch(r"/_chats/?", parsed.path)
        )
        if is_kakao_host and is_main_list:
            return page
        if is_kakao_host and CHAT_DETAIL_PATH_RE.fullmatch(parsed.path) and detail_page is None:
            detail_page = page
    if detail_page:
        return detail_page
    raise RuntimeError("No Kakao chat-list page found in automation Chrome DevTools")


def build_injection(content_js: str) -> str:
    shim = DEFAULT_SHIM_JS.read_text(encoding="utf-8")
    return shim + "\n" + content_js + "\n//# sourceURL=village-kakao-dom-watcher-cdp-injected.js\n"


def extract_watcher_version(content_js: str) -> str:
    match = WATCHER_VERSION_RE.search(content_js)
    if not match:
        raise RuntimeError("content.js WATCHER_VERSION is missing")
    return match.group(1)


def probe_watcher(cdp: CDPWebSocket) -> dict[str, Any] | None:
    verify = cdp.call("Runtime.evaluate", {
        "expression": r"""(async () => {
            const w = window.__villageKakaoWatcherInstance;
            const s = w?.state;
            const eligible = /^(?:\/_?[^/]+)?\/chats\/?$/.test(location.pathname);
            const scanAt = Number(s?.lastTopRowsScanAt || 0);
            let liveListProbeOk = false;
            let liveListItemCount = null;
            let liveListUnreadCount = null;
            let liveListHeadExpectedCount = null;
            let liveListHeadMatchCount = null;
            let liveListError = null;
            try {
                const profileMatch = /^\/([^/]+)\/chats\/?$/.exec(location.pathname);
                if (!profileMatch) throw new Error('profile_path_unavailable');
                const response = await fetch(
                    `/api/profiles/${encodeURIComponent(profileMatch[1])}/chats/search?size=100`,
                    {
                        method: 'POST',
                        credentials: 'include',
                        headers: {'Content-Type': 'application/json'},
                        body: '{}'
                    }
                );
                if (!response.ok) throw new Error(`http_${response.status}`);
                const payload = await response.json();
                const items = Array.isArray(payload?.items) ? payload.items : [];
                const liveHeadIds = items.slice(0, 5).map((item) => String(item?.id || '')).filter(Boolean);
                const domIds = new Set(
                    [...document.querySelectorAll('input[id^="chat-select-"]')]
                        .map((input) => String(input.id || '').slice('chat-select-'.length))
                        .filter(Boolean)
                );
                liveListProbeOk = true;
                liveListItemCount = items.length;
                liveListUnreadCount = items.filter(
                    (item) => Number(item?.unread_count || 0) > 0 || item?.is_read === false
                ).length;
                liveListHeadExpectedCount = liveHeadIds.length;
                liveListHeadMatchCount = liveHeadIds.filter((id) => domIds.has(id)).length;
            } catch (error) {
                liveListError = String(error?.message || error || 'live_list_probe_failed').slice(0, 120);
            }
            return ({
                hasWatcher: !!w,
                watcherVersion: w?.version || '',
                started: s?.started ?? false,
                observer: !!s?.observer,
                heartbeatTimer: !!s?.heartbeatTimer,
                topRowPollTimer: !!s?.topRowPollTimer,
                transportReady: typeof globalThis.__villageKakaoBridgeSend === 'function',
                pageEligible: eligible,
                topRowsCount: Number(s?.lastTopRowsCount || 0),
                topRowsScanAgeMs: scanAt > 0 ? Math.max(0, Date.now() - scanAt) : null,
                liveListProbeOk,
                liveListItemCount,
                liveListUnreadCount,
                liveListHeadExpectedCount,
                liveListHeadMatchCount,
                liveListError,
                extensionVersion: document.documentElement?.dataset?.villageKakaoExtensionWatcherVersion || '',
                extensionStatus: document.documentElement?.dataset?.villageKakaoExtensionWatcherStatus || ''
            });
        })()""",
        "awaitPromise": True,
        "returnByValue": True,
    })
    value = verify.get("result", {}).get("result", {}).get("value")
    return value if isinstance(value, dict) else None


def watcher_is_healthy(value: dict[str, Any] | None, expected_extension_version: str | None = None) -> bool:
    live_item_count = int((value or {}).get("liveListItemCount") or 0)
    visible_row_count = int((value or {}).get("topRowsCount") or 0)
    minimum_visible_rows = min(live_item_count, 5)
    expected_head_count = int((value or {}).get("liveListHeadExpectedCount") or 0)
    matched_head_count = int((value or {}).get("liveListHeadMatchCount") or 0)
    return bool(
        value
        and value.get("hasWatcher")
        and value.get("started")
        and value.get("observer")
        and value.get("heartbeatTimer")
        and value.get("topRowPollTimer")
        and value.get("transportReady")
        and value.get("pageEligible")
        and value.get("liveListProbeOk") is True
        and visible_row_count >= minimum_visible_rows
        and matched_head_count >= expected_head_count
        and value.get("topRowsScanAgeMs") is not None
        and int(value.get("topRowsScanAgeMs") or 0) <= 120_000
        and (
            not expected_extension_version
            or value.get("watcherVersion") == expected_extension_version
        )
    )


def watcher_probe_state(
    value: dict[str, Any] | None,
    expected_extension_version: str | None = None,
) -> str:
    if watcher_is_healthy(value, expected_extension_version):
        return "healthy"
    if value and value.get("liveListProbeOk") is False:
        return "live_list_probe_failed"
    return "watcher_repair_required"


def watcher_should_reload(
    value: dict[str, Any] | None,
    expected_extension_version: str | None = None,
) -> bool:
    return watcher_probe_state(value, expected_extension_version) == "watcher_repair_required"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=int(os.environ.get("KAKAO_REMOTE_DEBUGGING_PORT", "9223")))
    parser.add_argument("--content-js", default=str(DEFAULT_CONTENT_JS))
    parser.add_argument("--wait", type=float, default=10.0, help="seconds to wait for the Kakao tab")
    parser.add_argument("--probe-only", action="store_true", help="check watcher health without injecting or reloading")
    args = parser.parse_args()

    content_path = Path(args.content_js)
    content_js = content_path.read_text(encoding="utf-8")
    expected_extension_version = extract_watcher_version(content_js)

    deadline = time.time() + args.wait
    last_error: Exception | None = None
    page: dict[str, Any] | None = None
    classification: dict[str, Any] = {
        "state": "cdp_unavailable",
        "cdpReady": False,
        "authenticated": False,
        "watcherReady": False,
        "targetCount": 0,
        "challengeType": None,
    }
    while time.time() < deadline:
        try:
            pages = load_pages(args.port)
            classification = classify_kakao_targets(pages)
            page = choose_kakao_page(pages)
            break
        except Exception as exc:  # noqa: BLE001
            last_error = exc
            if classification["state"] in {"login_required", "second_factor_required"}:
                print(json.dumps({"ok": False, **classification}, ensure_ascii=False))
                return 3
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
        destination = chat_list_url(str(page.get("url") or ""))
        current = urlparse(str(page.get("url") or ""))
        if current.path.rstrip("/") != urlparse(destination).path.rstrip("/"):
            if args.probe_only:
                print(json.dumps({"ok": False, **classification, "state": "watcher_repair_required", "watcherReady": False}, ensure_ascii=False))
                return 2
            navigation = cdp.call("Page.navigate", {"url": destination})
            if navigation.get("error"):
                raise RuntimeError("Kakao chat-list navigation failed")
            navigation_deadline = time.time() + args.wait
            while time.time() < navigation_deadline:
                location = cdp.call("Runtime.evaluate", {
                    "expression": "location.pathname",
                    "returnByValue": True,
                })
                path = location.get("result", {}).get("result", {}).get("value")
                if isinstance(path, str) and CHAT_LIST_PATH_RE.fullmatch(path):
                    break
                time.sleep(0.25)
            else:
                raise RuntimeError("Kakao chat-list navigation timed out")
        if args.probe_only:
            value = probe_watcher(cdp)
            healthy = watcher_is_healthy(value, expected_extension_version)
            state = watcher_probe_state(value, expected_extension_version)
            print(json.dumps({"ok": healthy, **classification, "state": state, "watcherReady": healthy, "watcher": value}, ensure_ascii=False))
            return 0 if healthy else 2
        injection = build_injection(content_js)
        cdp.call("Page.addScriptToEvaluateOnNewDocument", {"source": injection})
        result = cdp.call("Runtime.evaluate", {
            "expression": injection,
            "awaitPromise": True,
            "returnByValue": True,
        })
        if result.get("result", {}).get("exceptionDetails"):
            raise RuntimeError(json.dumps(result["result"]["exceptionDetails"], ensure_ascii=False))
        value = probe_watcher(cdp)
        reloaded = False
        if watcher_should_reload(value, expected_extension_version):
            reloaded = True
            cdp.call("Page.reload", {"ignoreCache": True})
            repair_deadline = time.time() + args.wait
            while time.time() < repair_deadline:
                time.sleep(0.25)
                value = probe_watcher(cdp)
                if watcher_is_healthy(value, expected_extension_version):
                    break
        healthy = watcher_is_healthy(value, expected_extension_version)
        state = watcher_probe_state(value, expected_extension_version)
        print(json.dumps({"ok": healthy, **classification, "state": state, "watcherReady": healthy, "reloaded": reloaded, "watcher": value}, ensure_ascii=False))
        return 0 if healthy else 2
    finally:
        cdp.close()


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        raise SystemExit(1)
