"""Native, transport-only registered-reservation changes for Village."""

from __future__ import annotations

import re
from datetime import datetime
from typing import Any

from tools.registry import tool_error, tool_result

from .http_client import BridgeClient, BridgeClientError
from .turn_context import ACTIVE_TURN_FENCE


REGISTERED_CHANGE_REQUEST_SCHEMA_TAG = "village-registered-reservation-change-request/v1"
REGISTERED_CHANGE_RECEIPT_SCHEMA_TAG = "village-registered-reservation-change-receipt/v1"

_TRADE_ID = re.compile(r"^\d{6}-\d{3}$")
_SCHEDULE_ID = re.compile(r"^(\d{6}-\d{3})-\d{2,}$")
_REQUEST_ID = re.compile(r"^RQ-\d{6}-\d{3}$")
_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_TIME = re.compile(r"^(?:[01]\d|2[0-3]):[0-5]\d$")
_KINDS = {
    "external_supply_allocation", "equipment_add", "equipment_remove", "equipment_replace",
    "equipment_quantity_change", "date_time_change", "equipment_and_date_change", "reservation_cancel",
}
_MUTATION_FIELDS = {
    "confirmed", "kind", "target_scope", "trade_id", "source_evidence",
    "expected_period", "expected_before", "desired_after", "date_change", "request_id", "external_supply",
}


def _non_blank(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{field} must be a non-blank string")
    return value.strip()


def _exact_object(value: Any, fields: set[str], label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be an object")
    unsupported = set(value).difference(fields)
    if unsupported:
        raise ValueError(f"{label} has unsupported fields")
    missing = fields.difference(value)
    if missing:
        raise ValueError(f"{label} is missing required fields")
    return value


def _exact_date(value: Any, field: str) -> str:
    value = _non_blank(value, field)
    if _DATE.fullmatch(value) is None:
        raise ValueError(f"{field} must be an exact date")
    try:
        datetime.strptime(value, "%Y-%m-%d")
    except ValueError as error:
        raise ValueError(f"{field} must be an exact date") from error
    return value


def _time(value: Any, field: str) -> str:
    value = _non_blank(value, field)
    if _TIME.fullmatch(value) is None:
        raise ValueError(f"{field} must be a 24-hour time")
    return value


def _positive_int(value: Any, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ValueError(f"{field} must be a positive integer")
    return value


def _validate_period(value: Any, label: str, fields: tuple[str, str, str, str]) -> dict[str, str]:
    period = _exact_object(value, set(fields), label)
    return {
        fields[0]: _exact_date(period[fields[0]], f"{label}.{fields[0]}"),
        fields[1]: _time(period[fields[1]], f"{label}.{fields[1]}"),
        fields[2]: _exact_date(period[fields[2]], f"{label}.{fields[2]}"),
        fields[3]: _time(period[fields[3]], f"{label}.{fields[3]}"),
    }


def _period_instants(period: dict[str, str], fields: tuple[str, str, str, str]) -> tuple[datetime, datetime]:
    start = datetime.fromisoformat(f"{period[fields[0]]}T{period[fields[1]]}:00")
    end = datetime.fromisoformat(f"{period[fields[2]]}T{period[fields[3]]}:00")
    return start, end


def _quantities_by_name(rows: list[dict[str, Any]]) -> dict[str, int]:
    quantities: dict[str, int] = {}
    for row in rows:
        quantities[row["name"]] = quantities.get(row["name"], 0) + row["quantity"]
    return quantities


def _validate_kind_shape(
    kind: str,
    expected_before: list[dict[str, Any]],
    desired_after: list[dict[str, Any]],
    expected_period: dict[str, str],
    date_change: dict[str, str] | None,
) -> None:
    has_date_change = date_change is not None
    invalid = False
    if kind == "equipment_add":
        invalid = bool(expected_before) or not desired_after or has_date_change
    elif kind in {"equipment_remove", "reservation_cancel"}:
        invalid = not expected_before or bool(desired_after) or has_date_change
    elif kind == "equipment_replace":
        invalid = not expected_before or not desired_after or has_date_change
    elif kind == "equipment_quantity_change":
        before_quantities = _quantities_by_name(expected_before)
        after_quantities = _quantities_by_name(desired_after)
        invalid = (
            not expected_before or not desired_after or has_date_change
            or set(before_quantities) != set(after_quantities)
            or all(before_quantities[name] == after_quantities[name] for name in before_quantities)
        )
    elif kind == "equipment_and_date_change":
        expected_start, expected_end = _period_instants(
            expected_period, ("start_date", "start_time", "end_date", "end_time"),
        )
        if date_change is None:
            invalid = True
        else:
            desired_start, desired_end = _period_instants(
                date_change, ("new_start_date", "new_start_time", "new_end_date", "new_end_time"),
            )
            invalid = (
                _quantities_by_name(expected_before) == _quantities_by_name(desired_after)
                or desired_end <= desired_start
                or (expected_start == desired_start and expected_end == desired_end)
            )
    elif kind == "date_time_change":
        expected_start, expected_end = _period_instants(
            expected_period, ("start_date", "start_time", "end_date", "end_time"),
        )
        if date_change is None:
            invalid = True
        else:
            desired_start, desired_end = _period_instants(
                date_change, ("new_start_date", "new_start_time", "new_end_date", "new_end_time"),
            )
            invalid = (
                bool(expected_before) or bool(desired_after)
                or desired_end <= desired_start
                or (expected_start == desired_start and expected_end == desired_end)
            )
    if invalid:
        raise ValueError(f"mutation.{kind} has an invalid affected-row delta shape")


def _validate_rows(value: Any, label: str, trade_id: str, with_schedule_id: bool) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        raise ValueError(f"{label} must be an array")
    rows: list[dict[str, Any]] = []
    schedule_ids: set[str] = set()
    fields = {"name", "quantity"} | ({"schedule_id"} if with_schedule_id else set())
    for index, row in enumerate(value):
        parsed = _exact_object(row, fields, f"{label}[{index}]")
        normalized = {
            "name": _non_blank(parsed["name"], f"{label}[{index}].name"),
            "quantity": _positive_int(parsed["quantity"], f"{label}[{index}].quantity"),
        }
        if with_schedule_id:
            schedule_id = _non_blank(parsed["schedule_id"], f"{label}[{index}].schedule_id")
            match = _SCHEDULE_ID.fullmatch(schedule_id)
            if match is None or match.group(1) != trade_id:
                raise ValueError(f"{label}[{index}].schedule_id must belong to trade_id")
            if schedule_id in schedule_ids:
                raise ValueError(f"{label}.schedule_id values must be unique")
            schedule_ids.add(schedule_id)
            normalized["schedule_id"] = schedule_id
        rows.append(normalized)
    return rows


def _validate_mutation(value: Any, room_revision: int) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError("mutation must be an object")
    if set(value).difference(_MUTATION_FIELDS):
        raise ValueError("mutation has unsupported fields")
    required_fields = _MUTATION_FIELDS.difference({"request_id", "external_supply"})
    if required_fields.difference(value):
        raise ValueError("mutation is missing required fields")
    mutation = value
    if mutation["confirmed"] is not True:
        raise ValueError("mutation.confirmed must be true")
    kind = _non_blank(mutation["kind"], "mutation.kind")
    if kind not in _KINDS:
        raise ValueError("mutation.kind is unsupported")
    if kind != "external_supply_allocation" and "external_supply" in mutation:
        raise ValueError("external_supply requires allocation kind")
    if mutation["target_scope"] != "registered_trade":
        raise ValueError("mutation.target_scope must be registered_trade")
    trade_id = _non_blank(mutation["trade_id"], "mutation.trade_id")
    if _TRADE_ID.fullmatch(trade_id) is None:
        raise ValueError("mutation.trade_id is invalid")
    request_id = mutation.get("request_id")
    if kind in {"date_time_change", "reservation_cancel", "external_supply_allocation"}:
        if "request_id" in mutation:
            raise ValueError("mutation.date_time_change must not carry request_id")
    elif "request_id" in mutation:
        request_id = _non_blank(request_id, "mutation.request_id")
        if _REQUEST_ID.fullmatch(request_id) is None:
            raise ValueError("mutation.request_id must use RQ-YYMMDD-NNN format")
    evidence = _exact_object(mutation["source_evidence"], {
        "customer_request", "staff_confirmation", "conversation_revision",
    }, "mutation.source_evidence")
    _non_blank(evidence["customer_request"], "mutation.source_evidence.customer_request")
    _non_blank(evidence["staff_confirmation"], "mutation.source_evidence.staff_confirmation")
    if _positive_int(evidence["conversation_revision"], "mutation.source_evidence.conversation_revision") != room_revision:
        raise ValueError("mutation.source_evidence.conversation_revision does not match active turn")
    expected_period = _validate_period(
        mutation["expected_period"], "mutation.expected_period",
        ("start_date", "start_time", "end_date", "end_time"),
    )
    expected_start, expected_end = _period_instants(
        expected_period, ("start_date", "start_time", "end_date", "end_time"),
    )
    if expected_end <= expected_start:
        raise ValueError("mutation.expected_period end instant must be after start instant")
    expected_before = _validate_rows(mutation["expected_before"], "mutation.expected_before", trade_id, True)
    desired_after = _validate_rows(mutation["desired_after"], "mutation.desired_after", trade_id, False)
    date_change = mutation["date_change"]
    if date_change is not None:
        date_change = _validate_period(
            date_change, "mutation.date_change",
            ("new_start_date", "new_start_time", "new_end_date", "new_end_time"),
        )
    if kind == "external_supply_allocation":
        if len(expected_before) != 1 or desired_after or date_change is not None:
            raise ValueError("allocation must target one existing row without demand/date changes")
        supply = _exact_object(mutation.get("external_supply"), {"supplier", "quantity", "expected_note"}, "external_supply")
        supplier = _non_blank(supply["supplier"], "external_supply.supplier")
        if any(c in supplier or c in expected_before[0]["name"] for c in "|\r\n"):
            raise ValueError("allocation delimiter is invalid")
        if _positive_int(supply["quantity"], "external_supply.quantity") > expected_before[0]["quantity"]:
            raise ValueError("external supply exceeds total demand")
        if not isinstance(supply["expected_note"], str):
            raise ValueError("external_supply.expected_note must be exact current note")
    else:
        _validate_kind_shape(kind, expected_before, desired_after, expected_period, date_change)
    return {
        "confirmed": True, "kind": kind, "target_scope": "registered_trade", "trade_id": trade_id,
        "source_evidence": evidence, "expected_period": expected_period,
        "expected_before": expected_before, "desired_after": desired_after, "date_change": date_change,
        **({"request_id": request_id} if "request_id" in mutation else {}),
        **({"external_supply": supply} if kind == "external_supply_allocation" else {}),
    }


def _validate_receipt(receipt: Any, request: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(receipt, dict):
        raise ValueError("registered change receipt must be an object")
    if receipt.get("schema") != REGISTERED_CHANGE_RECEIPT_SCHEMA_TAG:
        raise ValueError("unsupported registered change receipt schema")
    _non_blank(receipt.get("receipt_id"), "receipt_id")
    for field in ("job_id", "room_key", "lease_id"):
        if _non_blank(receipt.get(field), field) != request[field]:
            raise ValueError(f"registered change receipt {field} mismatch")
    if _non_blank(receipt.get("trade_id"), "trade_id") != request["mutation"]["trade_id"]:
        raise ValueError("registered change receipt trade_id mismatch")
    revision = receipt.get("room_revision")
    if isinstance(revision, bool) or not isinstance(revision, int) or revision != request["room_revision"]:
        raise ValueError("registered change receipt room_revision mismatch")
    if receipt.get("target_scope") != "registered_trade":
        raise ValueError("registered change receipt target_scope mismatch")
    if receipt.get("mutation_kind") != request["mutation"]["kind"]:
        raise ValueError("registered change receipt mutation_kind mismatch")
    _non_blank(receipt.get("status"), "status")
    if receipt.get("customer_reply") != "no_reply":
        raise ValueError("registered change receipt customer_reply mismatch")
    if receipt.get("authoritative_result") is not None and not isinstance(receipt["authoritative_result"], dict):
        raise ValueError("registered change receipt authoritative_result must be an object or null")
    if not isinstance(receipt.get("applied_stages"), list):
        raise ValueError("registered change receipt applied_stages must be an array")
    if receipt.get("attempted_stage") is not None and not isinstance(receipt["attempted_stage"], str):
        raise ValueError("registered change receipt attempted_stage must be a string or null")
    created_at = _non_blank(receipt.get("created_at"), "created_at")
    try:
        datetime.fromisoformat(created_at[:-1] + "+00:00" if created_at.endswith("Z") else created_at)
    except ValueError as error:
        raise ValueError("registered change receipt created_at must be ISO-8601") from error
    if "error" not in receipt or receipt["error"] is not None and not isinstance(receipt["error"], (str, dict)):
        raise ValueError("registered change receipt error must be null, a string, or an object")
    return receipt


def handle_registered_reservation_change(args: dict, **kwargs: Any) -> str:
    """Validate typed transport data, fence it, and make exactly one bridge call."""
    try:
        if not isinstance(args, dict):
            raise ValueError("registered change request must be an object")
        fence = ACTIVE_TURN_FENCE.get()
        if fence is None or getattr(fence, "closed", True):
            raise ValueError("active Kakao turn fence is required")
        room_revision = getattr(fence, "room_revision", None)
        if isinstance(room_revision, bool) or not isinstance(room_revision, int) or room_revision <= 0:
            raise ValueError("active Kakao turn room_revision must be a positive integer")
        mutation = _validate_mutation(args.get("mutation"), room_revision)
        trusted = {
            "schema": REGISTERED_CHANGE_REQUEST_SCHEMA_TAG,
            "mutation": mutation,
            "job_id": _non_blank(getattr(fence, "job_id", None), "job_id"),
            "room_key": _non_blank(getattr(fence, "room_key", None), "room_key"),
            "room_revision": room_revision,
            "lease_id": _non_blank(getattr(fence, "lease_id", None), "lease_id"),
        }
    except ValueError as error:
        return tool_error(str(error))

    bridge_client = kwargs.get("bridge_client")
    try:
        bridge = bridge_client if bridge_client is not None else BridgeClient.from_environment()
        receipt = bridge.registered_reservation_change(trusted)
        _validate_receipt(receipt, trusted)
    except (BridgeClientError, TimeoutError, ValueError) as error:
        return tool_error(str(error))
    return tool_result(receipt)
