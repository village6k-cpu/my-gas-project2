#!/usr/bin/env python3
"""Restore Mac-style AI-first Hermes Slack behavior without exposing secrets."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path

from ruamel.yaml import YAML
from ruamel.yaml.comments import CommentedMap, CommentedSeq


ROUTER_SKILL = "village-runtime-router"
RUNTIME_CWD = r"C:\Village\my-gas-project2-worktrees\ax2-hermes-final"
ROUTING_PROMPT_START = "[VILLAGE_WINDOWS_RUNTIME_ROUTER_V1]"
ROUTING_PROMPT_END = "[/VILLAGE_WINDOWS_RUNTIME_ROUTER_V1]"

# 모델/프로바이더 단일 소스: hermes-model-contract.json.
# 파일이 없으면 검증된 기본값(gpt-5.6-terra / openai-codex / xhigh)으로 동작한다.
# 모델 교체는 계약 파일 수정 → 이 스크립트 재실행. default와 provider를 항상 함께
# 기록해 provider만 남고 model만 되돌아가는 혼합 상태를 구조적으로 차단한다.
MODEL_CONTRACT_PATH = Path(__file__).with_name("hermes-model-contract.json")
DEFAULT_ROOT_MODEL_CONTRACT = {
    "provider": "openai-codex",
    "model": "gpt-5.6-terra",
    "reasoning_effort": "xhigh",
}


def load_root_model_contract() -> dict:
    contract = dict(DEFAULT_ROOT_MODEL_CONTRACT)
    try:
        raw = json.loads(MODEL_CONTRACT_PATH.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return contract
    root = raw.get("root") if isinstance(raw, dict) else None
    if not isinstance(root, dict):
        raise ValueError("hermes-model-contract.json must contain a root mapping")
    for key in ("provider", "model", "reasoning_effort"):
        value = str(root.get(key, "")).strip()
        if not value:
            raise ValueError(f"hermes-model-contract.json root.{key} must be a non-empty string")
        contract[key] = value
    return contract

ROUTER_CHANNELS = {
    "C03F11EU0RE": "inventory",
    "C0B6WAR7R7H": "settlement",
    "C0B6ZJZ2XU3": "general-group",
    "C0B769B394K": "schedule",
    "C0B7AQN01BQ": "other-inquiries",
    "C0B7CLP4KDY": "documents",
    "C0BB07SM3EH": "business-heyvilly",
}


def remove_managed_bindings(existing: object) -> CommentedSeq:
    """Remove only our forced router while preserving every other binding."""
    preserved = CommentedSeq()
    if not isinstance(existing, list):
        return preserved
    for entry in existing:
        if not isinstance(entry, dict) or str(entry.get("id", "")) not in ROUTER_CHANNELS:
            preserved.append(entry)
            continue
        skills = entry.get("skills")
        if not isinstance(skills, list):
            preserved.append(entry)
            continue
        remaining = CommentedSeq(skill for skill in skills if str(skill) != ROUTER_SKILL)
        if remaining:
            entry["skills"] = remaining
            preserved.append(entry)
    return preserved


def remove_managed_prompt(existing: object) -> str:
    """Remove only managed prompt blocks, retaining user-owned instructions."""
    prompt = str(existing or "")
    while True:
        start = prompt.find(ROUTING_PROMPT_START)
        if start < 0:
            break
        end = prompt.find(ROUTING_PROMPT_END, start + len(ROUTING_PROMPT_START))
        if end < 0:
            prompt = prompt[:start]
            break
        prompt = prompt[:start] + prompt[end + len(ROUTING_PROMPT_END) :]
    return prompt.strip()


def prompts_are_clean(prompts: object) -> bool:
    if prompts is None:
        return True
    if not isinstance(prompts, dict):
        return False
    return all(
        ROUTING_PROMPT_START not in str(prompt) and ROUTING_PROMPT_END not in str(prompt)
        for prompt in prompts.values()
    )


def is_configured(config: object, contract: dict | None = None) -> bool:
    if not isinstance(config, dict) or not isinstance(config.get("slack"), dict):
        return False
    contract = contract or load_root_model_contract()
    bindings = config["slack"].get("channel_skill_bindings")
    bindings = bindings if isinstance(bindings, list) else []
    has_managed_router = any(
        isinstance(entry, dict)
        and str(entry.get("id", "")) in ROUTER_CHANNELS
        and ROUTER_SKILL in [str(skill) for skill in entry.get("skills", [])]
        for entry in bindings
    )
    model = config.get("model")
    agent = config.get("agent")
    guardrails = config.get("tool_loop_guardrails")
    terminal = config.get("terminal")
    return (
        isinstance(model, dict)
        and str(model.get("default", "")) == contract["model"]
        and str(model.get("provider", "")) == contract["provider"]
        and isinstance(agent, dict)
        and str(agent.get("reasoning_effort", "")) == contract["reasoning_effort"]
        and agent.get("gateway_wall_timeout") == 1800
        and isinstance(guardrails, dict)
        and guardrails.get("hard_stop_enabled") is False
        and not has_managed_router
        and prompts_are_clean(config["slack"].get("channel_prompts"))
        and isinstance(terminal, dict)
        and str(terminal.get("cwd", "")) == RUNTIME_CWD
    )


def load_config(path: Path, yaml: YAML) -> CommentedMap:
    with path.open("r", encoding="utf-8") as handle:
        config = yaml.load(handle)
    if not isinstance(config, dict):
        raise ValueError("Hermes config root must be a mapping")
    if "slack" not in config or not isinstance(config["slack"], dict):
        raise ValueError("Hermes config must contain a top-level slack mapping")
    if "terminal" not in config or not isinstance(config["terminal"], dict):
        raise ValueError("Hermes config must contain a top-level terminal mapping")
    return config


def atomic_write(path: Path, config: CommentedMap, yaml: YAML) -> None:
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.mac-parity.", suffix=".tmp", dir=path.parent
    )
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="") as handle:
            yaml.dump(config, handle)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_name, path)
    except BaseException:
        try:
            os.unlink(temporary_name)
        except FileNotFoundError:
            pass
        raise


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args(argv)

    yaml = YAML(typ="rt")
    yaml.preserve_quotes = True
    yaml.width = 4096
    config_path = args.config.resolve(strict=True)
    contract = load_root_model_contract()
    config = load_config(config_path, yaml)
    configured = is_configured(config, contract)

    result = {
        "ok": configured,
        "mode": "mac_style_ai_first",
        "channels": len(ROUTER_CHANNELS),
        "model": contract["model"],
        "provider": contract["provider"],
    }
    if args.check:
        print(json.dumps(result))
        return 0 if configured else 2
    if configured:
        print(json.dumps({**result, "changed": False}))
        return 0

    backup_path = config_path.with_name(f"{config_path.name}.before-mac-parity.backup")
    if not backup_path.exists():
        shutil.copy2(config_path, backup_path)

    for key in ("model", "agent", "tool_loop_guardrails"):
        if key not in config or not isinstance(config[key], dict):
            config[key] = CommentedMap()
    config["model"]["default"] = contract["model"]
    config["model"]["provider"] = contract["provider"]
    config["agent"]["reasoning_effort"] = contract["reasoning_effort"]
    config["agent"]["gateway_wall_timeout"] = 1800
    config["tool_loop_guardrails"]["hard_stop_enabled"] = False

    cleaned_bindings = remove_managed_bindings(config["slack"].get("channel_skill_bindings"))
    if cleaned_bindings:
        config["slack"]["channel_skill_bindings"] = cleaned_bindings
    else:
        config["slack"].pop("channel_skill_bindings", None)

    prompts = config["slack"].get("channel_prompts")
    if prompts is not None and not isinstance(prompts, dict):
        raise ValueError("slack.channel_prompts must be a mapping when present")
    if isinstance(prompts, dict):
        for channel_id in list(prompts):
            cleaned = remove_managed_prompt(prompts[channel_id])
            if cleaned:
                prompts[channel_id] = cleaned
            else:
                prompts.pop(channel_id, None)
        if not prompts:
            config["slack"].pop("channel_prompts", None)

    config["terminal"]["cwd"] = RUNTIME_CWD
    atomic_write(config_path, config, yaml)

    verified = is_configured(load_config(config_path, yaml), contract)
    print(json.dumps({
        "ok": verified,
        "changed": True,
        "mode": "mac_style_ai_first",
        "channels": len(ROUTER_CHANNELS),
        "model": contract["model"],
        "provider": contract["provider"],
    }))
    return 0 if verified else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(json.dumps({"ok": False, "error": type(error).__name__}), file=sys.stderr)
        raise SystemExit(1)
