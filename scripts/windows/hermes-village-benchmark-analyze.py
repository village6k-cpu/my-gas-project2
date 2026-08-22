#!/usr/bin/env python3
"""Analyze one isolated Hermes benchmark session without exposing prompts or secrets."""

from __future__ import annotations

import argparse
import math
import json
import re
import sqlite3
import statistics
from pathlib import Path
from typing import Any


MUTATING_OR_SEND_TOOLS = re.compile(
    r"(?:skill_manage|send|message|slack|kakao|sheet|schedule|terminal|browser|computer)",
    re.IGNORECASE,
)


def percentile_nearest_rank(values: list[float], percentile: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = max(0, min(len(ordered) - 1, math.ceil(percentile * len(ordered)) - 1))
    return float(ordered[index])


def mean(values: list[float]) -> float:
    return float(statistics.fmean(values)) if values else 0.0


def analyze_ab_evidence(path: Path) -> dict[str, Any]:
    evidence = json.loads(path.read_text(encoding="utf-8"))
    if evidence.get("schema") != "village-kakao-hermes-benchmark-evidence/v1":
        raise ValueError("unsupported A/B benchmark evidence schema")
    baseline = evidence.get("baseline")
    gateway = evidence.get("gateway")
    if not isinstance(baseline, dict) or not isinstance(gateway, dict):
        raise ValueError("benchmark evidence requires baseline and gateway objects")
    samples = gateway.get("samples")
    if not isinstance(samples, list):
        raise ValueError("gateway samples must be a list")

    blockers: list[str] = []
    measurement_kind = evidence.get("measurement_kind")
    if measurement_kind != "provider_backed":
        blockers.append("provider_backed_measurement_required")
    sample_count = len(samples)
    if sample_count < 20:
        blockers.append("gateway_sample_count_below_20")
    baseline_sample_count = baseline.get("sample_count")
    if not isinstance(baseline_sample_count, int) or baseline_sample_count < 20:
        blockers.append("baseline_sample_count_below_20")

    comparable_config = baseline.get("config") == gateway.get("config")
    if not comparable_config:
        blockers.append("model_provider_reasoning_tools_or_skills_drift")

    totals = [float(sample.get("total_ms", 0)) for sample in samples if isinstance(sample, dict)]
    agents = [float(sample.get("agent_ms", 0)) for sample in samples if isinstance(sample, dict)]
    process_starts = [float(sample.get("process_starts", 0)) for sample in samples if isinstance(sample, dict)]
    session_reuse = [bool(sample.get("session_reused")) for sample in samples if isinstance(sample, dict)]
    schedules = [sample for sample in samples if isinstance(sample, dict) and sample.get("schedule") is True]
    post_actions = [float(sample.get("post_action_agent_runs", 0)) for sample in schedules]
    owner_reviews = [bool(sample.get("owner_review_required")) for sample in schedules]
    send_count = sum(int(sample.get("send_count", 0)) for sample in samples if isinstance(sample, dict))
    write_count = sum(int(sample.get("write_count", 0)) for sample in samples if isinstance(sample, dict))

    process_starts_per_request = mean(process_starts)
    post_action_per_schedule = mean(post_actions)
    session_reuse_rate = mean([1.0 if value else 0.0 for value in session_reuse])
    owner_review_rate = mean([1.0 if value else 0.0 for value in owner_reviews])
    structural_checks = [
        (process_starts_per_request == 0, "process_starts_per_request_nonzero"),
        (post_action_per_schedule == 0, "post_action_agent_runs_per_schedule_nonzero"),
        (session_reuse_rate == 1, "session_reuse_rate_below_100_percent"),
        (bool(schedules) and owner_review_rate == 1, "schedule_owner_review_rate_below_100_percent"),
        (send_count == 0, "customer_send_count_nonzero"),
        (write_count == 0, "live_write_count_nonzero"),
    ]
    for passed, blocker in structural_checks:
        if not passed:
            blockers.append(blocker)

    baseline_median = float(baseline.get("total_median_ms", 0))
    baseline_p95 = float(baseline.get("total_p95_ms", 0))
    gateway_median = float(statistics.median(totals)) if totals else 0.0
    gateway_p95 = percentile_nearest_rank(totals, 0.95)
    gateway_agent_median = float(statistics.median(agents)) if agents else 0.0
    gateway_agent_p95 = percentile_nearest_rank(agents, 0.95)
    median_improvement = 1 - (gateway_median / baseline_median) if baseline_median > 0 else 0.0
    p95_improvement = 1 - (gateway_p95 / baseline_p95) if baseline_p95 > 0 else 0.0

    latency_prerequisites = (
        measurement_kind == "provider_backed"
        and sample_count >= 20
        and isinstance(baseline_sample_count, int)
        and baseline_sample_count >= 20
        and comparable_config
    )
    if not latency_prerequisites:
        latency_status = "blocked"
    else:
        latency_status = "pass" if median_improvement >= 0.40 and p95_improvement >= 0.30 else "fail"
        if median_improvement < 0.40:
            blockers.append("median_improvement_below_40_percent")
        if p95_improvement < 0.30:
            blockers.append("p95_improvement_below_30_percent")

    return {
        "schema": "village-kakao-hermes-benchmark-report/v1",
        "measurement_kind": measurement_kind,
        "sample_count": sample_count,
        "baseline_sample_count": baseline_sample_count,
        "baseline_total_median_ms": baseline_median,
        "baseline_total_p95_ms": baseline_p95,
        "gateway_total_median_ms": gateway_median,
        "gateway_total_p95_ms": gateway_p95,
        "gateway_agent_median_ms": gateway_agent_median,
        "gateway_agent_p95_ms": gateway_agent_p95,
        "process_starts_per_request": process_starts_per_request,
        "post_action_agent_runs_per_schedule": post_action_per_schedule,
        "session_reuse_rate": session_reuse_rate,
        "schedule_owner_review_rate": owner_review_rate,
        "send_count": send_count,
        "write_count": write_count,
        "median_improvement_rate": median_improvement,
        "p95_improvement_rate": p95_improvement,
        "comparable_config": comparable_config,
        "latency_status": latency_status,
        "accepted": not blockers,
        "blockers": blockers,
    }


def parse_json_response(text: str) -> Any:
    candidates = [text.strip()]
    fenced = re.search(r"```(?:json)?\s*([\s\S]*?)```", text, re.IGNORECASE)
    if fenced:
        candidates.append(fenced.group(1).strip())
    first = text.find("{")
    last = text.rfind("}")
    if first >= 0 and last > first:
        candidates.append(text[first : last + 1])
    for candidate in candidates:
        try:
            return json.loads(candidate)
        except (json.JSONDecodeError, TypeError):
            continue
    raise ValueError("response did not contain a parseable JSON object")


def compare_subset(expected: Any, actual: Any, path: str = "$") -> list[dict[str, Any]]:
    assertions: list[dict[str, Any]] = []
    if isinstance(expected, dict) and "$containsAll" in expected:
        terms = expected["$containsAll"]
        actual_text = actual if isinstance(actual, str) else ""
        passed = (
            isinstance(terms, list)
            and bool(terms)
            and all(str(term).casefold() in actual_text.casefold() for term in terms)
        )
        return [{"path": path, "expected": expected, "actual": actual, "passed": passed}]
    if isinstance(expected, dict):
        if not isinstance(actual, dict):
            return [{"path": path, "expected": "object", "actual": type(actual).__name__, "passed": False}]
        for key, value in expected.items():
            child_path = f"{path}.{key}"
            if key not in actual:
                assertions.append(
                    {"path": child_path, "expected": value, "actual": "<missing>", "passed": False}
                )
                continue
            assertions.extend(compare_subset(value, actual[key], child_path))
        return assertions
    if isinstance(expected, list):
        if not isinstance(actual, list) or len(expected) != len(actual):
            return [{"path": path, "expected": expected, "actual": actual, "passed": False}]
        for index, value in enumerate(expected):
            assertions.extend(compare_subset(value, actual[index], f"{path}[{index}]"))
        return assertions
    assertions.append({"path": path, "expected": expected, "actual": actual, "passed": expected == actual})
    return assertions


def load_expected(fixtures_path: Path, case_id: str) -> dict[str, Any]:
    payload = json.loads(fixtures_path.read_text(encoding="utf-8"))
    for case in payload.get("cases", []):
        if case.get("id") == case_id:
            return case
    raise KeyError(f"fixture not found: {case_id}")


def parse_tool_call(raw: Any) -> tuple[str, dict[str, Any]]:
    if not isinstance(raw, dict):
        return "", {}
    function = raw.get("function") if isinstance(raw.get("function"), dict) else raw
    name = str(function.get("name") or raw.get("name") or "")
    arguments = function.get("arguments") or raw.get("arguments") or {}
    if isinstance(arguments, str):
        try:
            arguments = json.loads(arguments)
        except json.JSONDecodeError:
            arguments = {"_raw": arguments}
    if not isinstance(arguments, dict):
        arguments = {"_value": arguments}
    return name, arguments


def analyze_session(db_path: Path, session_id: str) -> dict[str, Any]:
    connection = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    try:
        rows = connection.execute(
            """
            SELECT id, role, tool_name, tool_call_id, timestamp,
                   length(content) AS content_bytes, tool_calls
              FROM messages
             WHERE session_id = ?
             ORDER BY id
            """,
            (session_id,),
        ).fetchall()
    finally:
        connection.close()

    calls: list[dict[str, Any]] = []
    call_name_by_id: dict[str, str] = {}
    assistant_call_rows: dict[int, list[dict[str, Any]]] = {}
    for index, row in enumerate(rows):
        raw_calls = row["tool_calls"]
        if not raw_calls:
            continue
        try:
            decoded = json.loads(raw_calls)
        except (json.JSONDecodeError, TypeError):
            decoded = []
        parsed_batch: list[dict[str, Any]] = []
        for raw in decoded if isinstance(decoded, list) else []:
            name, arguments = parse_tool_call(raw)
            call_id = str(raw.get("id") or raw.get("call_id") or "") if isinstance(raw, dict) else ""
            entry = {"name": name, "arguments": arguments, "callId": call_id}
            parsed_batch.append(entry)
            calls.append(entry)
            if call_id:
                call_name_by_id[call_id] = name
        assistant_call_rows[index] = parsed_batch

    selected_skills: list[str] = []
    selected_references: list[str] = []
    attempts: list[dict[str, Any]] = []
    for call in calls:
        name = call["name"]
        arguments = call["arguments"]
        if name == "skill_view":
            skill = str(arguments.get("name") or "")
            reference = str(arguments.get("file_path") or "")
            if skill and skill not in selected_skills:
                selected_skills.append(skill)
            if reference:
                qualified = f"{skill}/{reference}" if skill else reference
                if qualified not in selected_references:
                    selected_references.append(qualified)
        if MUTATING_OR_SEND_TOOLS.search(name or "") and name != "skill_view":
            attempts.append({"name": name, "arguments": arguments})

    model_latency_seconds = 0.0
    tool_latency_seconds = 0.0
    model_call_count = 0
    phase_start: float | None = None
    for row in rows:
        if row["role"] == "user":
            phase_start = float(row["timestamp"] or 0.0)
            break

    index = 0
    while index < len(rows):
        row = rows[index]
        if row["role"] != "assistant":
            index += 1
            continue
        assistant_time = float(row["timestamp"] or 0.0)
        if phase_start is not None and assistant_time >= phase_start:
            model_latency_seconds += assistant_time - phase_start
        model_call_count += 1
        if index not in assistant_call_rows or not assistant_call_rows[index]:
            index += 1
            continue

        cursor = index + 1
        tool_times: list[float] = []
        while cursor < len(rows) and rows[cursor]["role"] == "tool":
            tool_times.append(float(rows[cursor]["timestamp"] or assistant_time))
            cursor += 1
        if tool_times:
            last_tool_time = max(tool_times)
            if last_tool_time >= assistant_time:
                tool_latency_seconds += last_tool_time - assistant_time
            phase_start = last_tool_time
        index = cursor

    support_read_bytes = 0
    for row in rows:
        if row["role"] != "tool":
            continue
        tool_name = str(row["tool_name"] or call_name_by_id.get(str(row["tool_call_id"] or ""), ""))
        if tool_name == "skill_view":
            support_read_bytes += int(row["content_bytes"] or 0)

    return {
        "sessionMessageCount": len(rows),
        "modelCallCount": model_call_count,
        "toolCallCount": len(calls),
        "toolCallNames": [call["name"] for call in calls],
        "selectedSkills": selected_skills,
        "selectedReferences": selected_references,
        "brainSelected": any(
            name in selected_skills
            for name in ("village-brain-first", "village-history-evidence")
        ),
        "supportReadBytes": support_read_bytes,
        "modelLatencyMs": round(model_latency_seconds * 1000, 3),
        "toolLatencyMs": round(tool_latency_seconds * 1000, 3),
        "attemptedMutationsOrSends": attempts,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--ab-evidence", type=Path)
    parser.add_argument("--db", type=Path)
    parser.add_argument("--session-id")
    parser.add_argument("--fixtures", type=Path)
    parser.add_argument("--case-id")
    parser.add_argument("--response", type=Path)
    args = parser.parse_args()

    if args.ab_evidence is not None:
        print(json.dumps(analyze_ab_evidence(args.ab_evidence), ensure_ascii=True))
        return 0
    missing = [
        name for name in ("db", "session_id", "fixtures", "case_id", "response")
        if getattr(args, name) is None
    ]
    if missing:
        parser.error("legacy analysis requires " + ", ".join(f"--{name.replace('_', '-')}" for name in missing))

    fixture = load_expected(args.fixtures, args.case_id)
    response_expected = {
        key: value for key, value in fixture["expected"].items() if key != "brain_needed"
    }
    response_text = args.response.read_text(encoding="utf-8-sig")
    parse_error = None
    parsed_response: Any = None
    try:
        parsed_response = parse_json_response(response_text)
        assertions = compare_subset(response_expected, parsed_response)
    except Exception as exc:  # noqa: BLE001 - structured benchmark evidence
        parse_error = str(exc)
        assertions = [
            {
                "path": "$",
                "expected": response_expected,
                "actual": "<unparseable>",
                "passed": False,
            }
        ]

    session = analyze_session(args.db, args.session_id)
    session.update(
        {
            "responseParsed": parse_error is None,
            "responseParseError": parse_error,
            "correctness": bool(assertions) and all(item["passed"] for item in assertions),
            "correctnessAssertions": assertions,
            "normalizedResponse": parsed_response,
        }
    )
    print(json.dumps(session, ensure_ascii=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
