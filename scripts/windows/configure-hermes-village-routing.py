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


def is_configured(config: object) -> bool:
    if not isinstance(config, dict) or not isinstance(config.get("slack"), dict):
        return False
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
        and str(model.get("default", "")) == "gpt-5.6-terra"
        and isinstance(agent, dict)
        and str(agent.get("reasoning_effort", "")) == "xhigh"
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
    config = load_config(config_path, yaml)
    configured = is_configured(config)

    result = {"ok": configured, "mode": "mac_style_ai_first", "channels": len(ROUTER_CHANNELS)}
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
    config["model"]["default"] = "gpt-5.6-terra"
    config["agent"]["reasoning_effort"] = "xhigh"
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

    verified = is_configured(load_config(config_path, yaml))
    print(json.dumps({"ok": verified, "changed": True, "mode": "mac_style_ai_first", "channels": len(ROUTER_CHANNELS)}))
    return 0 if verified else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(json.dumps({"ok": False, "error": type(error).__name__}), file=sys.stderr)
        raise SystemExit(1)
