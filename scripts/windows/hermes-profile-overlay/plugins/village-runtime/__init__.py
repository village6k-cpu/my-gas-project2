"""Village live-operation boundary and capability-learning coordinator."""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import threading
from pathlib import Path
from typing import Any, Dict, Optional


_ACTIVE_LIVE_OPERATIONS: Dict[str, Dict[str, Any]] = {}
_STATE_LOCK = threading.RLock()

_EXECUTION_BLOCKED_TOOLS = {
    "terminal",
    "process",
    "execute_code",
    "read_file",
    "search_files",
    "write_file",
    "patch",
    "browser_navigate",
    "browser_snapshot",
    "browser_click",
    "browser_type",
    "browser_scroll",
    "browser_back",
    "browser_press",
    "browser_get_images",
    "browser_vision",
    "browser_console",
    "browser_cdp",
    "browser_dialog",
    "computer_use",
}

_DISCOVERY_ALWAYS_ALLOWED_TOOLS = {
    "read_file",
    "search_files",
    "session_search",
    "skill_view",
    "skills_list",
    "skill_manage",
    "memory",
    "todo",
    "clarify",
}

_DISCOVERY_EDIT_TOOLS = {"write_file", "patch"}

_DISCOVERY_READ_ONLY_COMMAND_RE = re.compile(
    r"^(?:"
    r"git\s+status(?:\s+--(?:short|branch|porcelain(?:=v1)?))*|"
    r"git\s+diff\s+--(?:check|stat|name-only)(?:\s+--\s+[A-Za-z0-9_./*? -]+)?|"
    r"git\s+rev-parse\s+(?:HEAD|--show-toplevel|--abbrev-ref\s+HEAD)|"
    r"git\s+branch\s+--show-current"
    r")$",
    re.IGNORECASE,
)

_SHELL_CONTROL_RE = re.compile(r"(?:[;&|><`]|\$\(|\r|\n)")

_SCHEMA = {
    "name": "village_operation",
    "description": (
        "Primary tool for every direct Village business operation. The AI remains the semantic "
        "planner: understand images and conversation, resolve meaning, split schedules, and choose "
        "the capability. Use phase=execute directly when the plan is complete, or phase=prepare to "
        "validate it. If prepare returns CAPABILITY_GAP, do not abandon the user's task: enter the "
        "development discovery lane, implement the missing typed capability, validate it without network, "
        "promote it through the controlled installer, confirm both catalogs, record the learning, then "
        "prepare/execute again in the original turn. Never use raw live "
        "writes while developing a capability. Known capabilities execute through one canonical "
        "path and compact verified output. Customer sends and final registration require their "
        "separate current-request authorization flags."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "phase": {
                "type": "string",
                "enum": [
                    "catalog",
                    "prepare",
                    "validate_candidate",
                    "promote",
                    "confirm_registration",
                    "reconcile",
                    "execute",
                    "record_learning",
                    "complete",
                ],
                "description": "Lifecycle phase. A capability gap must be developed and then resumed, not reported as a finished task.",
            },
            "capability": {"type": "string", "description": "Typed capability id selected by AI reasoning."},
            "parameters": {"type": "object", "description": "Capability-specific typed parameters.", "additionalProperties": True},
            "authorization": {
                "type": "object",
                "properties": {
                    "ownerApproved": {"type": "boolean"},
                    "customerSendApproved": {"type": "boolean"},
                    "finalRegistrationApproved": {"type": "boolean"},
                    "systemAdminApproved": {"type": "boolean"},
                    "retryAfterReconciliationApproved": {"type": "boolean"},
                },
                "additionalProperties": False,
            },
            "policy": {"type": "string", "description": "Optional catalog policy filter."},
            "candidateRoot": {"type": "string"},
            "runtimeFiles": {"type": "array", "items": {"type": "string"}},
            "gasFiles": {"type": "array", "items": {"type": "string"}},
            "testFiles": {"type": "array", "items": {"type": "string"}},
            "validationId": {"type": "string"},
            "promotionId": {"type": "string"},
            "deploymentId": {"type": "string"},
            "deploymentDescription": {"type": "string"},
            "reconciliationEvidence": {"type": "object", "additionalProperties": True},
            "summary": {"type": "string", "description": "Learning summary for phase=record_learning."},
            "evidence": {"type": "object", "description": "Compact evidence for a learned capability.", "additionalProperties": True},
        },
        "required": ["phase"],
        "additionalProperties": False,
    },
}


def _session_key(*, session_id: str = "", task_id: str = "", **_: Any) -> str:
    return str(session_id or task_id or "").strip()


def _broker_path() -> Path:
    hermes_home = os.environ.get("HERMES_HOME", "").strip()
    if not hermes_home:
        raise RuntimeError("HERMES_HOME is required for village_operation")
    path = Path(hermes_home) / "scripts" / "village" / "village-operation-broker.js"
    if not path.is_file():
        raise RuntimeError(f"Village operation broker is missing: {path}")
    return path


def _node_path() -> str:
    node = shutil.which("node.exe") or shutil.which("node")
    if not node:
        raise RuntimeError("node.exe is required for village_operation")
    return node


def _run_broker(args: Dict[str, Any]) -> Dict[str, Any]:
    creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    try:
        completed = subprocess.run(
            [_node_path(), str(_broker_path())],
            input=json.dumps(args, ensure_ascii=False),
            text=True,
            encoding="utf-8",
            capture_output=True,
            timeout=300,
            check=False,
            creationflags=creationflags,
        )
    except subprocess.TimeoutExpired:
        return {
            "ok": False,
            "status": "BROKER_ERROR",
            "error": "broker timed out; the result must be reconciled before any retry",
            "mutationMayHaveOccurred": True,
            "retryAllowed": False,
        }
    except (OSError, RuntimeError) as error:
        return {"ok": False, "status": "BROKER_ERROR", "error": str(error)[:2000]}
    stdout = (completed.stdout or "").strip()
    stderr = (completed.stderr or "").strip()
    if completed.returncode != 0:
        try:
            structured = json.loads(stdout) if stdout else None
        except ValueError:
            structured = None
        if isinstance(structured, dict):
            return structured
        try:
            detail = json.loads(stderr.splitlines()[-1]) if stderr else {}
        except (ValueError, IndexError):
            detail = {}
        return {
            "ok": False,
            "status": "BROKER_ERROR",
            "error": str(detail.get("error") or stderr or f"broker exited {completed.returncode}")[:2000],
        }
    try:
        payload = json.loads(stdout)
    except ValueError:
        return {"ok": False, "status": "BROKER_ERROR", "error": "broker returned invalid JSON"}
    return payload if isinstance(payload, dict) else {"ok": False, "status": "BROKER_ERROR", "error": "broker returned a non-object"}


def _handle_village_operation(args: Dict[str, Any], **kwargs: Any) -> str:
    if not isinstance(args, dict):
        return json.dumps({"ok": False, "status": "INVALID_INPUT", "error": "arguments must be an object"})
    key = _session_key(**kwargs)
    phase = str(args.get("phase") or "")
    capability = str(args.get("capability") or "")
    authorization = args.get("authorization") if isinstance(args.get("authorization"), dict) else {}

    with _STATE_LOCK:
        prior = dict(_ACTIVE_LIVE_OPERATIONS.get(key) or {}) if key else {}

    if phase == "execute" and prior.get("mode") == "uncertain_write":
        retry_approved = (
            capability == str(prior.get("capability") or "")
            and
            authorization.get("ownerApproved") is True
            and authorization.get("retryAfterReconciliationApproved") is True
            and isinstance(args.get("reconciliationEvidence"), dict)
            and bool(args.get("reconciliationEvidence"))
        )
        if not retry_approved:
            return json.dumps(
                {
                    "ok": False,
                    "status": "RETRY_BLOCKED",
                    "capability": capability,
                    "retryAllowed": False,
                    "mutationMayHaveOccurred": True,
                    "next": "reconcile_authoritative_state_and_obtain_fresh_approval",
                },
                ensure_ascii=False,
                separators=(",", ":"),
            )

    if phase == "complete" and prior.get("mode") == "uncertain_write":
        if not isinstance(args.get("reconciliationEvidence"), dict) or not args.get("reconciliationEvidence"):
            return json.dumps(
                {
                    "ok": False,
                    "status": "RECONCILIATION_REQUIRED",
                    "capability": capability,
                    "retryAllowed": False,
                },
                ensure_ascii=False,
                separators=(",", ":"),
            )

    if key and phase == "execute":
        with _STATE_LOCK:
            _ACTIVE_LIVE_OPERATIONS[key] = {
                **prior,
                "mode": "executing",
                "capability": capability,
                "mustResumeOriginalRequest": True,
            }

    payload = _run_broker(args)

    if key:
        with _STATE_LOCK:
            state = dict(_ACTIVE_LIVE_OPERATIONS.get(key) or prior)
            if phase == "execute":
                if payload.get("ok") is True:
                    _ACTIVE_LIVE_OPERATIONS.pop(key, None)
                elif payload.get("status") == "CAPABILITY_GAP":
                    _ACTIVE_LIVE_OPERATIONS[key] = {
                        "mode": "discover",
                        "capability": capability,
                        "originalRequest": {
                            "capability": capability,
                            "parameters": dict(args.get("parameters") or {}),
                            "authorization": dict(authorization),
                        },
                        "mustResumeOriginalRequest": True,
                    }
                else:
                    _ACTIVE_LIVE_OPERATIONS[key] = {
                        **state,
                        "mode": "uncertain_write",
                        "capability": capability,
                        "lastStatus": str(payload.get("status") or "BROKER_ERROR"),
                        "mutationMayHaveOccurred": True,
                        "mustResumeOriginalRequest": True,
                    }
            elif phase == "prepare":
                if payload.get("ready") is True:
                    _ACTIVE_LIVE_OPERATIONS[key] = {
                        **state,
                        "mode": "execute",
                        "capability": capability,
                        "policy": str(payload.get("policy") or ""),
                        "mustResumeOriginalRequest": True,
                    }
                elif payload.get("status") == "CAPABILITY_GAP":
                    _ACTIVE_LIVE_OPERATIONS[key] = {
                        "mode": "discover",
                        "capability": capability,
                        "originalRequest": {
                            "capability": capability,
                            "parameters": dict(args.get("parameters") or {}),
                            "authorization": dict(authorization),
                        },
                        "mustResumeOriginalRequest": True,
                    }
            elif phase == "validate_candidate" and payload.get("validated") is True:
                _ACTIVE_LIVE_OPERATIONS[key] = {
                    **state,
                    "mode": "tested",
                    "capability": capability,
                    "validationId": str(payload.get("validationId") or ""),
                    "mustResumeOriginalRequest": True,
                }
            elif phase == "promote" and payload.get("promoted") is True:
                _ACTIVE_LIVE_OPERATIONS[key] = {
                    **state,
                    "mode": "promoted",
                    "capability": capability,
                    "promotionId": str(payload.get("promotionId") or ""),
                    "mustResumeOriginalRequest": True,
                }
            elif phase == "confirm_registration" and payload.get("confirmed") is True:
                _ACTIVE_LIVE_OPERATIONS[key] = {
                    **state,
                    "mode": "resume",
                    "capability": capability,
                    "mustResumeOriginalRequest": True,
                }
            elif phase == "reconcile" and payload.get("ok") is True:
                _ACTIVE_LIVE_OPERATIONS[key] = {
                    **state,
                    "mode": "uncertain_write",
                    "lastReconciliation": payload,
                    "mustResumeOriginalRequest": True,
                }
            elif phase == "complete":
                _ACTIVE_LIVE_OPERATIONS.pop(key, None)

    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))


def _args_text(args: Any) -> str:
    try:
        return json.dumps(args, ensure_ascii=False)
    except (TypeError, ValueError):
        return str(args or "")


def _block(message: str) -> Dict[str, str]:
    return {"action": "block", "message": message}


def _development_roots() -> tuple[str, ...]:
    configured = os.environ.get("VILLAGE_DEVELOPMENT_ROOTS", "").strip()
    values = [item for item in configured.split(os.pathsep) if item] if configured else [
        "C:/Village/my-gas-project2",
        "C:/Village/my-gas-project2-worktrees",
    ]
    return tuple(os.path.normcase(os.path.abspath(item)) for item in values)


def _development_edit_allowed(args: Any) -> bool:
    if not isinstance(args, dict):
        return False
    raw_path = str(args.get("path") or "").strip()
    if not raw_path or not os.path.isabs(raw_path):
        return False
    candidate = os.path.normcase(os.path.abspath(raw_path))
    for root in _development_roots():
        try:
            if os.path.commonpath((candidate, root)) == root:
                return True
        except ValueError:
            continue
    return False


def _read_only_terminal_allowed(args: Any) -> bool:
    if not isinstance(args, dict):
        return False
    command = str(args.get("command") or "").strip()
    if not command or _SHELL_CONTROL_RE.search(command):
        return False
    return _DISCOVERY_READ_ONLY_COMMAND_RE.match(command) is not None


def _on_pre_tool_call(
    tool_name: str = "",
    args: Any = None,
    session_id: str = "",
    task_id: str = "",
    **_: Any,
) -> Optional[Dict[str, str]]:
    key = _session_key(session_id=session_id, task_id=task_id)
    with _STATE_LOCK:
        state = dict(_ACTIVE_LIVE_OPERATIONS.get(key) or {})
    if not state or tool_name == "village_operation":
        return None

    mode = state.get("mode")
    capability = state.get("capability") or "the selected capability"
    if mode == "execute" and tool_name in _EXECUTION_BLOCKED_TOOLS:
        return _block(
            f"Known Village capability {capability} is in canonical execution mode. "
            "Use village_operation phase=execute; do not rediscover source, browser, shell, or raw API paths. "
            "AI reasoning, vision, clarification, session evidence, and skill learning remain available."
        )

    if mode == "discover":
        if tool_name in _DISCOVERY_ALWAYS_ALLOWED_TOOLS or tool_name == "vision_analyze":
            return None
        if tool_name in _DISCOVERY_EDIT_TOOLS:
            if _development_edit_allowed(args):
                return None
            return _block(
                "Capability development may edit only the canonical Village development worktrees. "
                "Do not modify the installed runtime or another live path directly."
            )
        if tool_name == "terminal" and _read_only_terminal_allowed(args):
            return None
        if tool_name == "terminal":
            return _block(
                "The development discovery terminal is fail-closed and permits only a small set of read-only Git checks. "
                "Run network-isolated tests with village_operation phase=validate_candidate, then use the controlled promotion phases."
            )
        return _block(
            "This tool is outside the fail-closed capability-development allowlist. Source inspection and development edits remain "
            "available; testing, deployment, runtime installation, and live catalog confirmation must use village_operation."
        )
    return None


def _on_pre_verify(session_id: str = "", task_id: str = "", **_: Any) -> Optional[Dict[str, str]]:
    key = _session_key(session_id=session_id, task_id=task_id)
    with _STATE_LOCK:
        state = dict(_ACTIVE_LIVE_OPERATIONS.get(key) or {})
    if state.get("mode") == "discover":
        return {
            "action": "continue",
            "message": (
                "The original Village request is still unfinished. Do not stop at the capability gap. "
                "Finish source edits, then call village_operation validate_candidate. Continue through controlled "
                "promotion and live catalog confirmation, then resume the preserved original request."
            ),
        }
    if state.get("mode") == "tested":
        return {
            "action": "continue",
            "message": (
                "The new capability passed network-isolated tests but is not installed. Use village_operation phase=promote "
                "with the validation receipt and explicit system-admin authorization; do not deploy through shell or browser tools."
            ),
        }
    if state.get("mode") == "promoted":
        return {
            "action": "continue",
            "message": (
                "The capability was promoted but the original request remains unfinished. Call village_operation "
                "phase=confirm_registration and require both installed-runtime and live-server catalog confirmation."
            ),
        }
    if state.get("mode") == "resume":
        return {
            "action": "continue",
            "message": (
                "The new capability is registered in both runtime and live catalog. Resume the preserved original request now: "
                "call village_operation phase=prepare with its original capability and parameters, then execute once."
            ),
        }
    if state.get("mode") == "uncertain_write":
        return {
            "action": "continue",
            "message": (
                "The write result is uncertain and must not be executed again automatically. Use village_operation phase=reconcile "
                "with a read-only capability. Any retry requires non-empty reconciliationEvidence plus fresh owner approval using "
                "authorization.retryAfterReconciliationApproved=true."
            ),
        }
    if state.get("mode") == "execute":
        return {
            "action": "continue",
            "message": (
                "The AI plan is ready but the original Village request is not yet executed. "
                "Call village_operation phase=execute, verify its result, then finish."
            ),
        }
    return None


def _on_session_end(session_id: str = "", task_id: str = "", **_: Any) -> None:
    key = _session_key(session_id=session_id, task_id=task_id)
    if key:
        with _STATE_LOCK:
            _ACTIVE_LIVE_OPERATIONS.pop(key, None)


def register(ctx: Any) -> None:
    ctx.register_tool(
        name="village_operation",
        toolset="hermes-slack",
        schema=_SCHEMA,
        handler=_handle_village_operation,
        description=_SCHEMA["description"],
        emoji="🏗️",
    )
    ctx.register_hook("pre_tool_call", _on_pre_tool_call)
    ctx.register_hook("pre_verify", _on_pre_verify)
    ctx.register_hook("on_session_end", _on_session_end)
    ctx.register_hook("on_session_finalize", _on_session_end)
    ctx.register_hook("on_session_reset", _on_session_end)
