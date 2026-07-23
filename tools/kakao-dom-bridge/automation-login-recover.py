#!/usr/bin/env python3
"""Best-effort recovery for Village Kakao automation Chrome login.

This script is deliberately limited to non-secret actions:
- find the expected Chrome profile window (🤖 자동화 크롬 / Profile 3)
- reopen the Kakao chat URL in that profile when missing
- click already-available 1Password/passkey UI controls

It never reads, prints, or types passwords/OTP/API keys. If 1Password needs a
master password, Touch ID, or an external 2FA approval, the script reports that
it is waiting for that approval rather than inventing or handling the secret.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import quote

ROOT = Path(__file__).resolve().parents[2]
BRIDGE_DIR = Path(__file__).resolve().parent
DEFAULT_URL = "https://business.kakao.com/_xhPMls/chats?t_src=business_partnercenter&t_ch=lnb&t_obj=%EB%82%B4%EC%B1%84%ED%8C%85_%ED%81%B4%EB%A6%AD"
DEFAULT_CHROME_STORE = Path.home() / "Library/Application Support/Google/Chrome"


def load_env_file(path: Path) -> dict[str, str]:
    env: dict[str, str] = {}
    if not path.exists():
        return env
    for raw in path.read_text(errors="replace").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        value = value.strip().strip('"').strip("'")
        env[key.strip()] = value
    return env


BRIDGE_ENV = load_env_file(BRIDGE_DIR / ".env")
PROFILE_DIR = Path(os.environ.get("VILLAGE_KAKAO_CHROME_DIR") or BRIDGE_ENV.get("VILLAGE_KAKAO_CHROME_DIR") or str(DEFAULT_CHROME_STORE))
PROFILE_DIRECTORY = os.environ.get("VILLAGE_KAKAO_CHROME_PROFILE_DIRECTORY") or BRIDGE_ENV.get("VILLAGE_KAKAO_CHROME_PROFILE_DIRECTORY") or "Profile 3"
KAKAO_URL = os.environ.get("KAKAO_MANAGER_URL") or os.environ.get("KAKAO_CHANNEL_MANAGER_URL") or BRIDGE_ENV.get("KAKAO_MANAGER_URL") or BRIDGE_ENV.get("KAKAO_CHANNEL_MANAGER_URL") or DEFAULT_URL
CUA = os.environ.get("CUA_DRIVER_COMMAND") or BRIDGE_ENV.get("CUA_DRIVER_COMMAND") or "/Users/village6k/.local/bin/cua-driver"
EXTENSION_DIR = os.environ.get("VILLAGE_KAKAO_WATCHER_EXTENSION_DIR") or str(ROOT / "tools/kakao-dom-watcher-extension")
REMOTE_DEBUGGING_PORT = os.environ.get("KAKAO_REMOTE_DEBUGGING_PORT") or BRIDGE_ENV.get("KAKAO_REMOTE_DEBUGGING_PORT") or "9223"


def profile_info() -> tuple[str, str, str]:
    """Return (profile_name, gaia_name, user_name) for expected profile."""
    local_state = DEFAULT_CHROME_STORE / "Local State"
    try:
        data = json.loads(local_state.read_text(errors="replace"))
        info = data.get("profile", {}).get("info_cache", {}).get(PROFILE_DIRECTORY, {})
        return (
            str(info.get("name") or "🤖 자동화 크롬"),
            str(info.get("gaia_name") or ""),
            str(info.get("user_name") or ""),
        )
    except Exception:
        return ("🤖 자동화 크롬", "", "")


PROFILE_NAME, PROFILE_GAIA, PROFILE_USER = profile_info()
EXPECTED_MARKERS = [x for x in {PROFILE_NAME, PROFILE_GAIA, PROFILE_USER, "🤖 자동화 크롬"} if x]
WRONG_PROFILE_MARKERS = ["💁🏻 직원용", "직원용 크롬", "BILL.", "village.6k@gmail.com"]


@dataclass
class WindowState:
    window_id: int
    pid: int
    list_title: str
    ax_title: str
    tree: str
    expected_profile: bool
    wrong_profile: bool
    has_kakao: bool
    has_chat: bool
    is_login: bool
    has_watcher: bool
    has_1password: bool
    has_permission_error: bool


def run(cmd: list[str], timeout: int = 12) -> subprocess.CompletedProcess[str]:
    return subprocess.run(cmd, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)


def run_json(cmd: list[str], timeout: int = 12) -> Any:
    p = run(cmd, timeout=timeout)
    if p.returncode != 0:
        raise RuntimeError((p.stderr or p.stdout or "command failed")[-1000:])
    return json.loads(p.stdout)


def cua(tool: str, payload: dict[str, Any], timeout: int = 15) -> Any:
    return run_json([CUA, "call", tool, json.dumps(payload, ensure_ascii=False)], timeout=timeout)


def list_chrome_windows() -> list[dict[str, Any]]:
    data = cua("list_windows", {}, timeout=20)
    windows = []
    for w in data.get("windows", []):
        if w.get("app_name") != "Google Chrome":
            continue
        b = w.get("bounds") or {}
        # Ignore tiny helper/shell windows; keep hidden/login/chat windows.
        if int(b.get("width") or 0) <= 2 and int(b.get("height") or 0) <= 2:
            continue
        title = str(w.get("title") or "")
        if title and not any(s in title for s in ["카카오", "Kakao", "kakao", "빌리지", "Google Sheets"]):
            continue
        windows.append(w)
    # Prefer visible/recent windows, but also scan hidden/login windows.  The
    # Kakao manager can leave dozens of small/stale Chrome windows behind; a low
    # cap makes the recovery/status check look only at staff-profile windows and
    # miss the real 🤖 automation profile completely.
    return windows[:80]


def ax_title_from_tree(tree: str) -> str:
    m = re.search(r'AXWindow "([^"]+)"', tree)
    return m.group(1) if m else ""


def inspect_window(w: dict[str, Any]) -> WindowState | None:
    window_id = int(w["window_id"])
    pid = int(w["pid"])
    try:
        data = cua("get_window_state", {"pid": pid, "window_id": window_id}, timeout=18)
    except Exception:
        return None
    tree = str(data.get("tree_markdown") or "")
    ax_title = ax_title_from_tree(tree)
    expected = any(marker and marker in ax_title for marker in EXPECTED_MARKERS)
    # Some minimized/off-screen Chrome windows omit the profile marker in the first title;
    # accept a toolbar profile button marker, but never if staff markers are present.
    if not expected:
        expected = any(marker and marker in tree for marker in EXPECTED_MARKERS)
    wrong = any(marker in ax_title for marker in WRONG_PROFILE_MARKERS)
    if wrong and PROFILE_NAME not in ax_title:
        expected = False
    has_kakao = any(s in tree for s in ["business.kakao.com", "center-pf.kakao.com", "accounts.kakao.com", "카카오비즈니스", "카카오계정"])
    has_chat = ("/chats" in tree and ("채팅 목록" in tree or "채팅방 레이어" in tree or "채팅 메시지 입력 폼" in tree))
    is_login = any(s in tree for s in ["카카오계정", "accounts.kakao.com", "계정 정보 입력", "비밀번호 입력", "패스키로 로그인", "저장된 패스키 사용"])
    has_watcher = "Village Kakao Watcher" in tree
    has_1p = "1Password" in tree
    has_permission_error = any(s in tree for s in ["권한이 없습니다", "페이지를 찾을 수 없습니다"])
    return WindowState(
        window_id=window_id,
        pid=pid,
        list_title=str(w.get("title") or ""),
        ax_title=ax_title,
        tree=tree,
        expected_profile=expected,
        wrong_profile=wrong,
        has_kakao=has_kakao,
        has_chat=has_chat,
        is_login=is_login,
        has_watcher=has_watcher,
        has_1password=has_1p,
        has_permission_error=has_permission_error,
    )


def scan() -> list[WindowState]:
    states: list[WindowState] = []
    for w in list_chrome_windows():
        s = inspect_window(w)
        if s and (s.has_kakao or s.expected_profile or s.has_watcher):
            states.append(s)
    return states


def summarize(states: list[WindowState]) -> dict[str, Any]:
    expected = [s for s in states if s.expected_profile]
    wrong_kakao = [s for s in states if s.has_kakao and s.wrong_profile and not s.expected_profile]
    chosen = None
    for s in expected:
        if s.has_chat:
            chosen = s
            break
    if not chosen and expected:
        chosen = expected[0]
    return {
        "profileDirectory": PROFILE_DIRECTORY,
        "profileName": PROFILE_NAME,
        "profileGaia": PROFILE_GAIA,
        "profileUser": PROFILE_USER,
        "expectedWindowCount": len(expected),
        "wrongProfileKakaoWindowCount": len(wrong_kakao),
        "chatOk": bool(chosen and chosen.has_chat and not chosen.is_login and not chosen.has_permission_error),
        "loginScreen": bool(chosen and chosen.is_login),
        "watcherVisible": bool(chosen and chosen.has_watcher),
        "chosen": None if not chosen else {
            "windowId": chosen.window_id,
            "pid": chosen.pid,
            "title": chosen.ax_title,
            "hasChat": chosen.has_chat,
            "isLogin": chosen.is_login,
            "hasWatcher": chosen.has_watcher,
            "has1Password": chosen.has_1password,
            "permissionError": chosen.has_permission_error,
        },
        "windows": [
            {
                "windowId": s.window_id,
                "pid": s.pid,
                "title": s.ax_title,
                "expected": s.expected_profile,
                "wrong": s.wrong_profile,
                "hasKakao": s.has_kakao,
                "hasChat": s.has_chat,
                "isLogin": s.is_login,
                "hasWatcher": s.has_watcher,
                "has1Password": s.has_1password,
                "permissionError": s.has_permission_error,
            }
            for s in states
        ],
    }


def launch_automation_chrome() -> None:
    args = [
        "open", "-na", "Google Chrome", "--args",
        f"--profile-directory={PROFILE_DIRECTORY}",
        "--remote-debugging-address=127.0.0.1",
        f"--remote-debugging-port={REMOTE_DEBUGGING_PORT}",
        "--no-first-run",
        f"--load-extension={EXTENSION_DIR}",
        KAKAO_URL,
    ]
    # If the deployment is isolated-profile mode, include user-data-dir. For the
    # normal Chrome store, omit it to avoid disturbing the staff profile lock.
    if str(PROFILE_DIR) != str(DEFAULT_CHROME_STORE):
        args.insert(5, f"--user-data-dir={PROFILE_DIR}")
    run(args, timeout=10)


_ELEMENT_RE = re.compile(r"\[([0-9]+)\].*?AX(?:Button|PopUpButton|Link|RadioButton|TextField|TextArea).*?(?:\"([^\"]*)\"|\(([^\)]*)\))?")


def elements(tree: str) -> list[tuple[int, str]]:
    found: list[tuple[int, str]] = []
    for line in tree.splitlines():
        m = _ELEMENT_RE.search(line)
        if not m:
            continue
        idx = int(m.group(1))
        label = (m.group(2) or m.group(3) or line).strip()
        found.append((idx, label))
    return found


def click_label(state: WindowState, includes: list[str], excludes: list[str] | None = None) -> str | None:
    excludes = excludes or []
    for idx, label in elements(state.tree):
        if all(x in label for x in includes) and not any(x in label for x in excludes):
            try:
                cua("click", {"pid": state.pid, "window_id": state.window_id, "element_index": idx}, timeout=10)
                return f"clicked [{idx}] {label[:80]}"
            except Exception:
                # Some Kakao React controls expose AX nodes that reject AXPress.
                # Fall through to the DOM click path below.
                break
    return dom_click_text(state, includes, excludes)


def dom_click_text(state: WindowState, includes: list[str], excludes: list[str] | None = None) -> str | None:
    excludes = excludes or []
    js = f"""
(() => {{
  const includes = {json.dumps(includes, ensure_ascii=False)};
  const excludes = {json.dumps(excludes, ensure_ascii=False)};
  const nodes = [...document.querySelectorAll('button,a,[role=button],input[type=button],input[type=submit]')];
  const textOf = e => ((e.innerText || e.value || e.getAttribute('aria-label') || e.title || '') + '').trim();
  const el = nodes.find(e => {{
    const t = textOf(e);
    return includes.every(x => t.includes(x)) && !excludes.some(x => t.includes(x));
  }});
  if (!el) return {{clicked:false}};
  el.click();
  return {{clicked:true, text:textOf(el).slice(0,120)}};
}})()
""".strip()
    try:
        result = cua("page", {"pid": state.pid, "window_id": state.window_id, "action": "execute_javascript", "javascript": js}, timeout=10)
        text = str(result)
        if "clicked:true" in text or "'clicked': True" in text or '"clicked":true' in text:
            return f"dom-clicked {'/'.join(includes)}"
    except Exception:
        return None
    return None


def navigate_logout_for_account_switch(state: WindowState) -> str | None:
    logout_url = f"https://accounts.kakao.com/logout?continue={quote(KAKAO_URL, safe='')}"
    js = f"(() => {{ location.href = {json.dumps(logout_url)}; return location.href; }})()"
    try:
        cua("page", {"pid": state.pid, "window_id": state.window_id, "action": "execute_javascript", "javascript": js}, timeout=10)
        return "navigated Kakao logout/account-switch URL"
    except Exception:
        return None


def press(state: WindowState, key: str, element_index: int | None = None) -> None:
    payload: dict[str, Any] = {"pid": state.pid, "window_id": state.window_id, "key": key}
    if element_index is not None:
        payload["element_index"] = element_index
    cua("press_key", payload, timeout=8)


def choose_state(states: list[WindowState]) -> WindowState | None:
    expected = [s for s in states if s.expected_profile]
    for s in expected:
        if s.has_chat:
            return s
    for s in expected:
        if s.is_login:
            return s
    for s in expected:
        if s.has_kakao:
            return s
    return expected[0] if expected else None


def recover_login(max_steps: int = 8) -> dict[str, Any]:
    actions: list[str] = []
    states = scan()
    state = choose_state(states)
    if not state:
        actions.append("open automation Chrome profile")
        launch_automation_chrome()
        time.sleep(3)
        states = scan()
        state = choose_state(states)
    if not state:
        return {"ok": False, "status": "automation_profile_window_not_found", "actions": actions, "summary": summarize(states)}
    if state.has_chat and not state.is_login and not state.has_permission_error:
        return {"ok": True, "status": "already_on_kakao_chat", "actions": actions, "summary": summarize(states)}

    for _ in range(max_steps):
        # Rescan each step because 1Password/passkey popups mutate the AX tree.
        states = scan()
        state = choose_state(states)
        if not state:
            launch_automation_chrome()
            time.sleep(2)
            continue
        if state.has_chat and not state.is_login and not state.has_permission_error:
            return {"ok": True, "status": "login_recovered", "actions": actions, "summary": summarize(states)}

        clicked = None
        if state.has_permission_error:
            clicked = navigate_logout_for_account_switch(state)
        # Kakao remembered the wrong/unauthorized simple-login account. Choose the
        # full login form so 1Password can fill the authorized BILL/village item.
        if not clicked and "로그인할 카카오계정 선택" in state.tree:
            clicked = click_label(state, ["새로운 계정으로 로그인"])
        # Prefer built-in passkey choices when already displayed. This is a click
        # only; any Touch ID / device approval remains handled by macOS/user policy.
        if not clicked:
            for inc in (["iCloud 키체인"], ["패스키"], ["Passkey"], ["passkey"]):
                clicked = click_label(state, inc, excludes=["닫기", "취소"])
                if clicked:
                    break
        if not clicked:
            clicked = click_label(state, ["1Password 잠금 해제"])
        if not clicked:
            # Open the toolbar extension popup if available.
            clicked = click_label(state, ["1Password"], excludes=["메뉴를 사용할 수 있습니다"])
        if not clicked:
            # When the 1Password menu/list is open, pick a Kakao/business-looking item.
            for inc in (["카카오"], ["Kakao"], ["business.kakao"], ["ssperorecord"], ["village"]):
                clicked = click_label(state, inc, excludes=["비밀번호 찾기", "계정 찾기", "회원가입", "도움말"])
                if clicked:
                    break
        if not clicked:
            # If 1Password has filled the fields, the login button is safe to click.
            clicked = click_label(state, ["로그인"], excludes=["QR코드", "회원가입"])
        if not clicked:
            # Focus login field and try 1Password inline menu keyboard path.
            tf = next((idx for idx, label in elements(state.tree) if "계정 정보 입력" in label), None)
            if tf is not None and "1Password 메뉴를 사용할 수 있습니다" in state.tree:
                press(state, "down", tf)
                time.sleep(0.2)
                press(state, "return")
                clicked = "pressed 1Password inline menu down/return"

        if not clicked:
            return {
                "ok": False,
                "status": "login_ui_needs_secret_or_manual_step",
                "actions": actions,
                "summary": summarize(states),
            }
        actions.append(clicked)
        time.sleep(4)

    states = scan()
    return {"ok": False, "status": "login_recovery_steps_exhausted", "actions": actions, "summary": summarize(states)}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--status-only", action="store_true")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--open-if-missing", action="store_true")
    ap.add_argument("--recover-login", action="store_true")
    args = ap.parse_args()

    if args.recover_login:
        result = recover_login()
    else:
        states = scan()
        if args.open_if_missing and not choose_state(states):
            launch_automation_chrome()
            time.sleep(3)
            states = scan()
        summary = summarize(states)
        result = {"ok": bool(summary.get("chatOk")), "status": "status", "summary": summary}

    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(json.dumps(result, ensure_ascii=False))
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(json.dumps({"ok": False, "status": "exception", "error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        raise SystemExit(2)
