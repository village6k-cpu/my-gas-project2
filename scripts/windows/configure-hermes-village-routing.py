#!/usr/bin/env python3
"""Install intelligence-preserving Village Slack routing without exposing secrets."""

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
ROUTING_PROMPT = f"""{ROUTING_PROMPT_START}
Windows Village routing override for every turn, including an existing session:
- Current Village fact: start with the most relevant read-only lookup:
  node 'C:/Village/my-gas-project2-worktrees/ax2-hermes-final/scripts/windows/village-live-query.js' lookup --domain <inventory|schedule|customer|finance|documents> --query '<identifier>'
  Use additional focused queries, relevant skills, and source evidence whenever the first result is incomplete. Routing is a navigation optimization, never a reduction in AI reasoning or tool access needed for correctness.
- Decision, policy, or history: read C:/Village/VILLAGE_Brain/Ops/brain-context-latest.md directly. Load village-brain-first only when a complex protocol is actually required.
- New 확인요청 creation from owner text/screenshot: load village-operations and use the same full AI reasoning as the successful screenshot-quote path. Resolve aliases with broad catalog/master searches and context; a failed raw exact search is not ambiguity. If equipment groups have different return times, split them automatically into the minimum number of requests. Use C:/Village/my-gas-project2-worktrees/ax2-hermes-final/scripts/windows/village-confirm-request.js only for final bounded mutation/readback, with create-batch for multiple groups. Do not disable normal self-improvement for speed.
- Other requested internal action only: load village-operations once, perform the action, and verify live readback.
This block supersedes older per-channel discovery and path instructions. Do not send a customer-facing message without separate approval.
{ROUTING_PROMPT_END}"""
ROUTER_CHANNELS = CommentedMap(
    {
        "C03F11EU0RE": "inventory",
        "C0B6WAR7R7H": "settlement",
        "C0B6ZJZ2XU3": "general-group",
        "C0B769B394K": "schedule",
        "C0B7AQN01BQ": "other-inquiries",
        "C0B7CLP4KDY": "documents",
        "C0BB07SM3EH": "business-heyvilly",
    }
)


def desired_bindings(existing: object) -> CommentedSeq:
    managed = set(ROUTER_CHANNELS)
    preserved = CommentedSeq()
    if isinstance(existing, list):
        for entry in existing:
            if not isinstance(entry, dict) or str(entry.get("id", "")) not in managed:
                preserved.append(entry)
    for channel_id, label in ROUTER_CHANNELS.items():
        item = CommentedMap({"id": channel_id, "skills": CommentedSeq([ROUTER_SKILL])})
        item.yaml_add_eol_comment(label, key="id")
        preserved.append(item)
    return preserved


def desired_channel_prompt(existing: object) -> str:
    """Preserve user-owned instructions and replace only our managed block."""
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
    prompt = prompt.strip()
    return f"{prompt}\n\n{ROUTING_PROMPT}" if prompt else ROUTING_PROMPT


def prompts_are_configured(prompts: object) -> bool:
    if not isinstance(prompts, dict):
        return False
    for channel_id in ROUTER_CHANNELS:
        prompt = str(prompts.get(channel_id, ""))
        if (
            prompt.count(ROUTING_PROMPT_START) != 1
            or prompt.count(ROUTING_PROMPT_END) != 1
            or "village-live-query.js" not in prompt
            or "village-confirm-request.js" not in prompt
            or "village-confirm-request" not in prompt
            or "same full AI reasoning" not in prompt
            or "create-batch" not in prompt
            or "load village-operations" not in prompt
            or "existing session" not in prompt
        ):
            return False
    return True


def is_configured(config: object) -> bool:
    if not isinstance(config, dict) or not isinstance(config.get("slack"), dict):
        return False
    bindings = config["slack"].get("channel_skill_bindings")
    if not isinstance(bindings, list):
        return False
    actual = {
        str(entry.get("id")): list(entry.get("skills", []))
        for entry in bindings
        if isinstance(entry, dict) and str(entry.get("id", "")) in ROUTER_CHANNELS
    }
    terminal = config.get("terminal")
    return (
        actual == {channel_id: [ROUTER_SKILL] for channel_id in ROUTER_CHANNELS}
        and prompts_are_configured(config["slack"].get("channel_prompts"))
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
        prefix=f".{path.name}.village-routing.", suffix=".tmp", dir=path.parent
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

    if args.check:
        print(json.dumps({"ok": configured, "router": ROUTER_SKILL, "channels": len(ROUTER_CHANNELS)}))
        return 0 if configured else 2
    if configured:
        print(json.dumps({"ok": True, "changed": False, "router": ROUTER_SKILL, "channels": len(ROUTER_CHANNELS)}))
        return 0

    backup_path = config_path.with_name(f"{config_path.name}.before-village-routing.backup")
    if not backup_path.exists():
        shutil.copy2(config_path, backup_path)
    config["slack"]["channel_skill_bindings"] = desired_bindings(
        config["slack"].get("channel_skill_bindings")
    )
    prompts = config["slack"].get("channel_prompts")
    if prompts is None:
        prompts = CommentedMap()
        config["slack"]["channel_prompts"] = prompts
    elif not isinstance(prompts, dict):
        raise ValueError("slack.channel_prompts must be a mapping when present")
    for channel_id in ROUTER_CHANNELS:
        prompts[channel_id] = desired_channel_prompt(prompts.get(channel_id))
    config["terminal"]["cwd"] = RUNTIME_CWD
    atomic_write(config_path, config, yaml)

    verified = is_configured(load_config(config_path, yaml))
    print(json.dumps({"ok": verified, "changed": True, "router": ROUTER_SKILL, "channels": len(ROUTER_CHANNELS)}))
    return 0 if verified else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(json.dumps({"ok": False, "error": type(error).__name__}), file=sys.stderr)
        raise SystemExit(1)
