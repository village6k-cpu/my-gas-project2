"""Village live-operation boundary and capability-learning coordinator."""

from __future__ import annotations

import json
import hashlib
import os
import re
import shutil
import subprocess
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Dict, Optional


_ACTIVE_LIVE_OPERATIONS: Dict[str, Dict[str, Any]] = {}
_CAPABILITY_POLICIES: Dict[str, str] = {}
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
    "memory",
    "todo",
    "clarify",
}

_DISCOVERY_EDIT_TOOLS = {"write_file", "patch"}

_ACTIVE_REASONING_TOOLS = {
    "vision_analyze",
    "clarify",
    "session_search",
    "memory",
    "todo",
    "skill_view",
    "skills_list",
}

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
                    "rollback_promotion",
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


def _state_path(key: str) -> Optional[Path]:
    hermes_home = os.environ.get("HERMES_HOME", "").strip()
    if not hermes_home or not key:
        return None
    digest = hashlib.sha256(key.encode("utf-8")).hexdigest()
    return Path(hermes_home) / "learning" / "village-live-operations" / f"{digest}.json"


def _get_state(key: str) -> Dict[str, Any]:
    if not key:
        return {}
    memory = _ACTIVE_LIVE_OPERATIONS.get(key)
    if isinstance(memory, dict):
        return dict(memory)
    state_path = _state_path(key)
    if not state_path or not state_path.is_file():
        return {}
    try:
        envelope = json.loads(state_path.read_text(encoding="utf-8"))
        if envelope.get("sessionKeyHash") != hashlib.sha256(key.encode("utf-8")).hexdigest():
            return {}
        state = envelope.get("state")
        if not isinstance(state, dict):
            return {}
    except (OSError, ValueError, TypeError):
        return {}
    _ACTIVE_LIVE_OPERATIONS[key] = dict(state)
    return dict(state)


def _write_state_file(key: str, durable: Dict[str, Any]) -> None:
    state_path = _state_path(key)
    if not state_path:
        return
    state_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = state_path.with_name(f"{state_path.name}.{os.getpid()}.{uuid.uuid4()}.tmp")
    envelope = {
        "version": 1,
        "sessionKeyHash": hashlib.sha256(key.encode("utf-8")).hexdigest(),
        "state": durable,
    }
    try:
        with temporary.open("w", encoding="utf-8", newline="\n") as handle:
            json.dump(envelope, handle, ensure_ascii=False, separators=(",", ":"))
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, state_path)
    finally:
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass


def _set_state(key: str, state: Dict[str, Any]) -> None:
    if not key:
        return
    durable = dict(state)
    durable["updatedAt"] = time.time()
    _ACTIVE_LIVE_OPERATIONS[key] = durable
    _write_state_file(key, durable)


def _set_transient_state(
    key: str, transient: Dict[str, Any], recovery: Dict[str, Any]
) -> None:
    if not key:
        return
    transient_state = dict(transient)
    transient_state["updatedAt"] = time.time()
    _ACTIVE_LIVE_OPERATIONS[key] = transient_state
    recovery_state = dict(recovery)
    recovery_state["updatedAt"] = transient_state["updatedAt"]
    _write_state_file(key, recovery_state)


def _clear_state(key: str) -> None:
    if not key:
        return
    _ACTIVE_LIVE_OPERATIONS.pop(key, None)
    state_path = _state_path(key)
    if state_path:
        try:
            state_path.unlink(missing_ok=True)
        except OSError:
            pass


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


def _broker_policy_marker(value: Any) -> str:
    if isinstance(value, bytes):
        value = value.decode("utf-8", errors="replace")
    match = re.search(r"VILLAGE_EXECUTION_POLICY:(read_only|internal_write|customer_send|final_registration)", str(value or ""))
    return str(match.group(1) if match else "")


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
    except subprocess.TimeoutExpired as error:
        policy = _broker_policy_marker(getattr(error, "stderr", ""))
        read_only = policy == "read_only"
        return {
            "ok": False,
            "status": "READ_FAILED" if read_only else "BROKER_ERROR",
            "policy": policy or "unknown",
            "error": "broker timed out; a write result must be reconciled before any retry" if not read_only else "read-only broker timed out",
            "mutationMayHaveOccurred": not read_only,
            "retryAllowed": read_only,
            "retrySafe": read_only,
        }
    except (OSError, RuntimeError) as error:
        return {
            "ok": False,
            "status": "BROKER_ERROR",
            "error": str(error)[:2000],
            "mutationMayHaveOccurred": False,
            "retryAllowed": True,
            "retrySafe": True,
        }
    stdout = (completed.stdout or "").strip()
    stderr = (completed.stderr or "").strip()
    policy = _broker_policy_marker(stderr)
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
            "policy": policy or "unknown",
            "error": str(detail.get("error") or stderr or f"broker exited {completed.returncode}")[:2000],
            "mutationMayHaveOccurred": policy != "read_only",
        }
    try:
        payload = json.loads(stdout)
    except ValueError:
        return {
            "ok": False,
            "status": "READ_FAILED" if policy == "read_only" else "BROKER_ERROR",
            "policy": policy or "unknown",
            "error": "broker returned invalid JSON",
            "mutationMayHaveOccurred": policy != "read_only",
            "retryAllowed": policy == "read_only",
            "retrySafe": policy == "read_only",
        }
    if isinstance(payload, dict):
        return payload
    return {
        "ok": False,
        "status": "READ_FAILED" if policy == "read_only" else "BROKER_ERROR",
        "policy": policy or "unknown",
        "error": "broker returned a non-object",
        "mutationMayHaveOccurred": policy != "read_only",
        "retryAllowed": policy == "read_only",
        "retrySafe": policy == "read_only",
    }


def _json_result(payload: Dict[str, Any]) -> str:
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))


def _capability_policy(capability: str) -> tuple[str, bool]:
    cached = str(_CAPABILITY_POLICIES.get(capability) or "")
    if cached:
        return cached, True
    catalog_payload = _run_broker({"phase": "catalog"})
    if catalog_payload.get("ok") is not True or not isinstance(
        catalog_payload.get("capabilities"), list
    ):
        return "", False
    for item in catalog_payload["capabilities"]:
        if not isinstance(item, dict):
            continue
        capability_id = str(item.get("id") or "")
        policy = str(item.get("policy") or "")
        if capability_id and policy:
            _CAPABILITY_POLICIES[capability_id] = policy
    return str(_CAPABILITY_POLICIES.get(capability) or ""), True


def _handle_village_operation(args: Dict[str, Any], **kwargs: Any) -> str:
    if not isinstance(args, dict):
        return json.dumps({"ok": False, "status": "INVALID_INPUT", "error": "arguments must be an object"})
    key = _session_key(**kwargs)
    phase = str(args.get("phase") or "")
    capability = str(args.get("capability") or "")
    authorization = args.get("authorization") if isinstance(args.get("authorization"), dict) else {}
    broker_args = dict(args)

    lifecycle_phases = {
        "discover": {"validate_candidate"},
        "tested": {"validate_candidate", "promote"},
        "promoted": {"confirm_registration", "rollback_promotion"},
        "confirmation_pending": {"confirm_registration", "rollback_promotion"},
        "promotion_failed": {"rollback_promotion"},
        "resume": {"record_learning", "prepare"},
        "execute": {"execute"},
        "uncertain_write": {"reconcile", "execute", "complete"},
    }

    with _STATE_LOCK:
        prior = _get_state(key)
        mode = str(prior.get("mode") or "")
        original_capability = str(prior.get("capability") or "")

        if prior and phase != "catalog":
            if mode in {"executing", "reconciling", "completing"}:
                return _json_result(
                    {
                        "ok": False,
                        "status": "OPERATION_IN_PROGRESS",
                        "capability": original_capability,
                        "mode": mode,
                    }
                )
            if phase == "complete" and mode != "uncertain_write":
                return _json_result(
                    {
                        "ok": False,
                        "status": "INCOMPLETE_LIFECYCLE",
                        "capability": original_capability,
                        "mode": mode,
                        "mustResumeOriginalRequest": True,
                    }
                )
            allowed = lifecycle_phases.get(mode, set())
            if phase not in allowed:
                return _json_result(
                    {
                        "ok": False,
                        "status": "LIFECYCLE_MISMATCH",
                        "capability": original_capability,
                        "mode": mode,
                        "allowedPhases": sorted(allowed),
                        "mustResumeOriginalRequest": True,
                    }
                )
            if phase != "reconcile" and capability != original_capability:
                return _json_result(
                    {
                        "ok": False,
                        "status": "LIFECYCLE_MISMATCH",
                        "capability": original_capability,
                        "requestedCapability": capability,
                        "mode": mode,
                        "mustResumeOriginalRequest": True,
                    }
                )
            if phase in {"confirm_registration", "rollback_promotion"}:
                expected_promotion = str(prior.get("promotionId") or "")
                if not expected_promotion or str(args.get("promotionId") or "") != expected_promotion:
                    return _json_result(
                        {
                            "ok": False,
                            "status": "PROMOTION_RECEIPT_MISMATCH",
                            "capability": original_capability,
                        }
                    )
            if phase == "promote":
                expected_validation = str(prior.get("validationId") or "")
                if not expected_validation or str(args.get("validationId") or "") != expected_validation:
                    return _json_result(
                        {
                            "ok": False,
                            "status": "VALIDATION_RECEIPT_MISMATCH",
                            "capability": original_capability,
                        }
                    )

        if not prior and phase == "reconcile":
            return _json_result(
                {"ok": False, "status": "RECONCILIATION_NOT_ACTIVE", "capability": capability}
            )
        if not prior and phase == "complete":
            return _json_result(
                {"ok": False, "status": "NO_ACTIVE_OPERATION", "capability": capability}
            )
        if phase == "execute" and isinstance(args.get("reconciliationEvidence"), dict):
            if mode != "uncertain_write":
                return _json_result(
                    {
                        "ok": False,
                        "status": "RETRY_BLOCKED",
                        "capability": capability,
                        "retryAllowed": False,
                    }
                )

        if phase == "execute" and mode == "uncertain_write":
            retry_approved = (
                capability == original_capability
                and authorization.get("ownerApproved") is True
                and authorization.get("retryAfterReconciliationApproved") is True
                and _valid_reconciliation(prior, args, expected_outcome="not_applied")
            )
            if not retry_approved:
                return _json_result(
                    {
                        "ok": False,
                        "status": "RETRY_BLOCKED",
                        "capability": capability,
                        "retryAllowed": False,
                        "mutationMayHaveOccurred": True,
                        "next": "reconcile_authoritative_state_and_obtain_fresh_approval",
                    }
                )

        if phase == "complete" and not _valid_reconciliation(
            prior, args, expected_outcome="already_applied"
        ):
            return _json_result(
                {
                    "ok": False,
                    "status": "RECONCILIATION_REQUIRED",
                    "capability": capability,
                    "retryAllowed": False,
                }
            )

        if phase == "reconcile":
            broker_args["originalCapability"] = original_capability
            broker_args["originalParameters"] = dict(
                (prior.get("originalRequest") or {}).get("parameters") or {}
            )
            broker_args["originalOperationId"] = str(prior.get("operationId") or "")
            if capability == "operation.receipt":
                broker_args["parameters"] = {
                    "operationId": str(prior.get("operationId") or "")
                }
            if key:
                _set_transient_state(
                    key,
                    {**prior, "mode": "reconciling"},
                    prior,
                )
        elif phase == "complete" and key:
            completing_state = {**prior}
            completing_state.pop("lastReconciliation", None)
            _set_transient_state(
                key,
                {**completing_state, "mode": "completing"},
                prior,
            )
        elif phase == "execute" and key:
            executing_state = {**prior}
            executing_state.pop("lastReconciliation", None)
            policy = str(executing_state.get("policy") or "")
            if not policy:
                if mode == "uncertain_write":
                    # Recovery is already conservatively classified as a write.
                    # Keep it recoverable even if the local catalog is unavailable,
                    # and consume the reconciliation receipt under this state lock.
                    policy = "unknown"
                else:
                    policy, catalog_available = _capability_policy(capability)
                    if not catalog_available:
                        return _json_result(
                            {
                                "ok": False,
                                "status": "CAPABILITY_POLICY_UNAVAILABLE",
                                "capability": capability,
                                "mutationMayHaveOccurred": False,
                                "retryAllowed": True,
                            }
                        )
                    if not policy:
                        gap_state = {
                            "mode": "discover",
                            "capability": capability,
                            "originalRequest": {
                                "capability": capability,
                                "parameters": dict(args.get("parameters") or {}),
                                "authorization": dict(authorization),
                            },
                            "mustResumeOriginalRequest": True,
                        }
                        _set_state(key, gap_state)
                        return _json_result(
                            {
                                "ok": False,
                                "ready": False,
                                "status": "CAPABILITY_GAP",
                                "capability": capability,
                                "liveSourceDiscoveryAllowed": False,
                                "developmentDiscoveryAllowed": True,
                                "mustResumeOriginalRequest": True,
                                "next": "discover_validate_promote_confirm_resume",
                                "recordLearning": True,
                            }
                        )
                if not policy:
                    return _json_result(
                        {
                            "ok": False,
                            "status": "CAPABILITY_POLICY_UNAVAILABLE",
                            "capability": capability,
                            "mutationMayHaveOccurred": mode == "uncertain_write",
                            "retryAllowed": False,
                        }
                    )
                executing_state["policy"] = policy
            operation_id = str(
                executing_state.get("operationId")
                or f"{int(time.time())}-{uuid.uuid4()}"
            )
            broker_args["operationId"] = operation_id
            if not isinstance(executing_state.get("originalRequest"), dict):
                executing_state["originalRequest"] = {
                    "capability": capability,
                    "parameters": dict(args.get("parameters") or {}),
                    "authorization": dict(authorization),
                }
            transient_state = {
                **executing_state,
                "mode": "executing",
                "capability": capability,
                "operationId": operation_id,
                "mustResumeOriginalRequest": True,
            }
            if str(executing_state.get("policy") or "") == "read_only":
                recovery_state = {
                    **transient_state,
                    "mode": "execute",
                    "lastStatus": "READ_EXECUTION_INTERRUPTED",
                    "mutationMayHaveOccurred": False,
                }
            else:
                recovery_state = {
                    **transient_state,
                    "mode": "uncertain_write",
                    "lastStatus": "EXECUTION_INTERRUPTED",
                    "mutationMayHaveOccurred": True,
                }
            _set_transient_state(key, transient_state, recovery_state)

    payload = _run_broker(broker_args)
    reconciliation_id = ""
    if phase == "reconcile" and payload.get("ok") is True:
        reconciliation_id = str(uuid.uuid4())
        payload = {
            **payload,
            "reconciliationId": reconciliation_id,
            "originalCapability": str(prior.get("capability") or ""),
            "validForSeconds": 600,
        }

    if key:
        with _STATE_LOCK:
            state = _get_state(key) or prior
            if phase == "execute":
                if payload.get("ok") is True:
                    _clear_state(key)
                elif payload.get("status") == "CAPABILITY_GAP":
                    _set_state(key, {
                        "mode": "discover",
                        "capability": capability,
                        "originalRequest": {
                            "capability": capability,
                            "parameters": dict(args.get("parameters") or {}),
                            "authorization": dict(authorization),
                        },
                        "mustResumeOriginalRequest": True,
                    })
                elif (
                    payload.get("mutationMayHaveOccurred") is False
                    or payload.get("policy") == "read_only"
                    or state.get("policy") == "read_only"
                ):
                    _clear_state(key)
                else:
                    _set_state(key, {
                        **state,
                        "mode": "uncertain_write",
                        "capability": capability,
                        "lastStatus": str(payload.get("status") or "BROKER_ERROR"),
                        "mutationMayHaveOccurred": True,
                        "mustResumeOriginalRequest": True,
                    })
            elif phase == "prepare":
                if payload.get("ready") is True:
                    _set_state(key, {
                        **state,
                        "mode": "execute",
                        "capability": capability,
                        "policy": str(payload.get("policy") or ""),
                        "originalRequest": {
                            "capability": capability,
                            "parameters": dict(args.get("parameters") or {}),
                            "authorization": dict(authorization),
                        },
                        "mustResumeOriginalRequest": True,
                    })
                elif payload.get("status") == "CAPABILITY_GAP":
                    _set_state(key, {
                        "mode": "discover",
                        "capability": capability,
                        "originalRequest": {
                            "capability": capability,
                            "parameters": dict(args.get("parameters") or {}),
                            "authorization": dict(authorization),
                        },
                        "mustResumeOriginalRequest": True,
                    })
            elif phase == "validate_candidate" and payload.get("validated") is True:
                _set_state(key, {
                    **state,
                    "mode": "tested",
                    "capability": capability,
                    "validationId": str(payload.get("validationId") or ""),
                    "mustResumeOriginalRequest": True,
                })
            elif phase == "promote" and payload.get("promoted") is True:
                _set_state(key, {
                    **state,
                    "mode": "promoted",
                    "capability": capability,
                    "promotionId": str(payload.get("promotionId") or ""),
                    "mustResumeOriginalRequest": True,
                })
            elif phase == "promote" and payload.get("recoveryRequired") is True:
                recovery_capability = str(payload.get("capability") or capability)
                _set_state(key, {
                    **state,
                    "mode": "promotion_failed",
                    "capability": recovery_capability,
                    "promotionId": str(payload.get("promotionId") or ""),
                    "mustResumeOriginalRequest": True,
                })
            elif phase == "confirm_registration" and payload.get("confirmed") is True:
                _set_state(key, {
                    **state,
                    "mode": "resume",
                    "capability": capability,
                    "mustResumeOriginalRequest": True,
                })
            elif phase == "confirm_registration" and payload.get("status") == "REGISTRATION_NOT_CONFIRMED":
                _set_state(key, {
                    **state,
                    "mode": "confirmation_pending",
                    "capability": capability,
                    "promotionId": str(payload.get("promotionId") or state.get("promotionId") or ""),
                    "mustResumeOriginalRequest": True,
                })
            elif phase == "reconcile" and payload.get("ok") is True:
                _set_state(key, {
                    **state,
                    "mode": "uncertain_write",
                    "lastReconciliation": {
                        "reconciliationId": reconciliation_id,
                        "reconciledAt": time.time(),
                        "readCapability": capability,
                        "result": payload,
                    },
                    "mustResumeOriginalRequest": True,
                })
            elif phase == "reconcile":
                _set_state(key, {
                    **state,
                    "mode": "uncertain_write",
                    "lastStatus": str(payload.get("status") or "RECONCILIATION_FAILED"),
                    "mustResumeOriginalRequest": True,
                })
            elif phase == "rollback_promotion" and payload.get("rolledBack") is True:
                original_request = state.get("originalRequest") if isinstance(state.get("originalRequest"), dict) else {}
                resume_capability = str(original_request.get("capability") or capability)
                _set_state(key, {
                    **state,
                    "mode": "discover",
                    "capability": resume_capability,
                    "mustResumeOriginalRequest": True,
                })
            elif phase == "complete" and payload.get("ok") is True:
                _clear_state(key)
            elif phase == "complete":
                _set_state(key, {
                    **state,
                    "mode": "uncertain_write",
                    "lastStatus": str(payload.get("status") or "COMPLETION_FAILED"),
                    "mustResumeOriginalRequest": True,
                })

    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))


def _args_text(args: Any) -> str:
    try:
        return json.dumps(args, ensure_ascii=False)
    except (TypeError, ValueError):
        return str(args or "")


def _block(message: str) -> Dict[str, str]:
    return {"action": "block", "message": message}


def _valid_reconciliation(
    state: Dict[str, Any], args: Dict[str, Any], *, expected_outcome: str
) -> bool:
    receipt = state.get("lastReconciliation")
    evidence = args.get("reconciliationEvidence")
    if not isinstance(receipt, dict) or not isinstance(evidence, dict):
        return False
    receipt_id = str(receipt.get("reconciliationId") or "")
    reconciled_at = float(receipt.get("reconciledAt") or 0)
    result = receipt.get("result") if isinstance(receipt.get("result"), dict) else {}
    parameters_match = True
    if expected_outcome == "not_applied":
        original_request = state.get("originalRequest") if isinstance(state.get("originalRequest"), dict) else {}
        original_parameters = original_request.get("parameters") if isinstance(original_request.get("parameters"), dict) else {}
        retry_parameters = args.get("parameters") if isinstance(args.get("parameters"), dict) else {}
        parameters_match = json.dumps(original_parameters, sort_keys=True, ensure_ascii=False) == json.dumps(
            retry_parameters, sort_keys=True, ensure_ascii=False
        )
    return bool(
        receipt_id
        and str(evidence.get("reconciliationId") or "") == receipt_id
        and str(evidence.get("originalCapability") or "") == str(state.get("capability") or "")
        and str(result.get("reconciliationOutcome") or "") == expected_outcome
        and parameters_match
        and time.time() - reconciled_at <= 600
    )


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
        state = _get_state(key)
    if not state or tool_name == "village_operation":
        return None

    mode = state.get("mode")
    capability = state.get("capability") or "the selected capability"
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
    if tool_name in _ACTIVE_REASONING_TOOLS:
        return None
    return _block(
        f"Village capability {capability} is in lifecycle mode {mode}. "
        "This phase is fail-closed: continue with village_operation or use only reasoning, vision, clarification, session evidence, "
        "and read-only learning context. Delegation, scheduling, skill mutation, shell, source, browser, and computer paths are blocked."
    )


def _on_pre_verify(session_id: str = "", task_id: str = "", **_: Any) -> Optional[Dict[str, str]]:
    key = _session_key(session_id=session_id, task_id=task_id)
    with _STATE_LOCK:
        state = _get_state(key)
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
    if state.get("mode") == "confirmation_pending":
        return {
            "action": "continue",
            "message": (
                "Runtime and live catalog confirmation do not yet agree. Retry phase=confirm_registration only for a bounded "
                "deployment-settling check; if the mismatch persists, call phase=rollback_promotion with the retained promotionId. "
                "Do not abandon the original request or invent another live path."
            ),
        }
    if state.get("mode") == "promotion_failed":
        return {
            "action": "continue",
            "message": (
                "Capability promotion did not finish and has a recovery receipt. Do not redeploy or abandon the original request. "
                "Call village_operation phase=rollback_promotion with the promotionId, verify rollback, fix the candidate, then validate again."
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
                "with the original capability's catalog-declared authoritative reader and exact original target. Complete only from "
                "an already_applied receipt; retry only from a not_applied receipt. Use the returned one-time reconciliationId as "
                "reconciliationEvidence; any retry also requires fresh owner approval using "
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
    # Unfinished Village state is deliberately retained. Terminal operation
    # paths clear it themselves; a session boundary must not erase an
    # uncertain receipt or an in-progress capability-learning lifecycle.
    return None


def _on_session_reset(session_id: str = "", task_id: str = "", **_: Any) -> None:
    # A UI/session reset is not proof that a live write did not happen. Keep
    # the durable envelope so the next turn must reconcile or resume it.
    return None


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
    ctx.register_hook("on_session_reset", _on_session_reset)
