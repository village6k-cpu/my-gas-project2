#!/usr/bin/env python3
"""Verify a generated Village quote bundle from local artifacts only."""

from __future__ import annotations

import argparse
import csv
import json
import os
from pathlib import Path
import re
import sys
import time
from typing import Any


DEFAULT_ALLOWED_ROOTS = (Path(r"C:\Village\quote-previews"),)
MAX_SUMMARY_BYTES = 5 * 1024 * 1024
MAX_TRADES = 100
TRADE_ID_PATTERN = re.compile(r"^\d{6}-\d{3}$")


class VerificationFailure(Exception):
    def __init__(
        self,
        error_type: str,
        message: str,
        *,
        evidence: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.error_type = error_type
        self.message = message
        self.evidence = evidence


def _allowed_roots() -> tuple[Path, ...]:
    configured = os.environ.get("VILLAGE_QUOTE_VERIFY_ALLOWED_ROOTS", "").strip()
    roots = [Path(value) for value in configured.split(os.pathsep) if value.strip()]
    selected = roots or list(DEFAULT_ALLOWED_ROOTS)
    return tuple(root.resolve() for root in selected)


def _trusted_path(path: Path, roots: tuple[Path, ...]) -> Path:
    resolved = path.resolve()
    if not any(resolved == root or resolved.is_relative_to(root) for root in roots):
        raise VerificationFailure(
            "untrusted_quote_path",
            f"Quote artifact is outside the configured preview root: {resolved}",
        )
    return resolved


def _check_deadline(started_at: float, deadline_ms: int) -> None:
    if (time.monotonic() - started_at) * 1000 > deadline_ms:
        raise VerificationFailure(
            "quote_bundle_deadline_exceeded",
            f"Local quote verification exceeded {deadline_ms} ms",
        )


def _integer(value: Any, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise VerificationFailure("invalid_quote_summary", f"{field} must be numeric")
    number = int(value)
    if number != value or number < 0 or not number <= 9_000_000_000_000:
        raise VerificationFailure("invalid_quote_summary", f"{field} must be a safe non-negative integer")
    return number


def _summary_totals(summary: dict[str, Any]) -> tuple[list[dict[str, Any]], dict[str, int]]:
    errors = summary.get("errors", [])
    if not isinstance(errors, list) or errors:
        raise VerificationFailure("invalid_quote_summary", "summary.errors must be an empty list")

    results = summary.get("results")
    if not isinstance(results, list) or not 1 <= len(results) <= MAX_TRADES:
        raise VerificationFailure(
            "invalid_quote_summary",
            f"summary.results must contain between 1 and {MAX_TRADES} trades",
        )

    seen: set[str] = set()
    totals = {"list_total": 0, "discount": 0, "supply": 0, "vat": 0, "total": 0}
    for index, result in enumerate(results):
        if not isinstance(result, dict):
            raise VerificationFailure("invalid_quote_summary", f"results[{index}] must be an object")
        trade_id = str(result.get("tradeID", "")).strip()
        if not TRADE_ID_PATTERN.fullmatch(trade_id) or trade_id in seen:
            raise VerificationFailure("invalid_quote_summary", f"Invalid or duplicate tradeID: {trade_id}")
        seen.add(trade_id)
        values = {key: _integer(result.get(key), f"results[{index}].{key}") for key in totals}
        if values["list_total"] - values["discount"] != values["supply"]:
            raise VerificationFailure("invalid_quote_summary", f"Supply arithmetic mismatch for {trade_id}")
        if values["supply"] + values["vat"] != values["total"]:
            raise VerificationFailure("invalid_quote_summary", f"VAT arithmetic mismatch for {trade_id}")
        for key, value in values.items():
            totals[key] += value

    expected_fields = {
        "included_count": len(results),
        "list_total_sum": totals["list_total"],
        "discount_sum": totals["discount"],
        "supply_sum": totals["supply"],
        "final_total_sum": totals["total"],
    }
    for field, expected in expected_fields.items():
        if field in summary and _integer(summary[field], field) != expected:
            raise VerificationFailure("invalid_quote_summary", f"{field} does not match result rows")
    return results, totals


def _numbers(text: str) -> list[int]:
    return [int(value.replace(",", "")) for value in re.findall(r"(?<!\d)(\d[\d,]*)(?!\d)", text)]


def _extract_total(text: str, source: str) -> int:
    won_amounts = [int(value.replace(",", "")) for value in re.findall(r"₩\s*([\d,]+)", text)]
    if won_amounts:
        return won_amounts[-1]

    lines = text.splitlines()
    for index, line in enumerate(lines):
        upper = line.upper()
        is_total = ("합계" in line and ("VAT" in upper or "포함" in line)) or (
            "TOTAL" in upper and "VAT" in upper
        )
        if is_total:
            nearby = " ".join(lines[index:index + 5])
            values = _numbers(nearby)
            if values:
                return values[-1]
    raise VerificationFailure("unreadable_quote_total", f"Could not extract a total from {source}")


def _csv_total(path: Path) -> int:
    with path.open("r", encoding="utf-8-sig", errors="replace", newline="") as handle:
        for row in csv.reader(handle):
            joined = " ".join(row)
            upper = joined.upper()
            is_total = ("합계" in joined and ("VAT" in upper or "포함" in joined)) or (
                "TOTAL" in upper and "VAT" in upper
            )
            if is_total:
                values: list[int] = []
                for cell in row:
                    normalized = str(cell).replace("₩", "").replace(",", "").strip()
                    if re.fullmatch(r"\d+", normalized):
                        values.append(int(normalized))
                if values:
                    return values[-1]
    raise VerificationFailure("unreadable_quote_total", f"Could not extract a total from {path}")


def _pdf_page_totals(path: Path) -> list[int]:
    try:
        import pymupdf
    except ImportError as error:
        raise VerificationFailure(
            "pdf_backend_unavailable",
            "PyMuPDF is required; run with: uv run --offline --with pymupdf python",
        ) from error

    try:
        document = pymupdf.open(path)
    except Exception as error:
        raise VerificationFailure("unreadable_quote_pdf", f"Could not open {path}: {error}") from error
    try:
        return [
            _extract_total(document[index].get_text("text"), f"{path} page {index + 1}")
            for index in range(document.page_count)
        ]
    finally:
        document.close()


def _one_artifact(individual: Path, trade_id: str, suffix: str, roots: tuple[Path, ...]) -> Path:
    matches = sorted(individual.glob(f"{trade_id}*{suffix}"))
    if len(matches) != 1:
        raise VerificationFailure(
            "quote_artifact_count_mismatch",
            f"Expected one {suffix} artifact for {trade_id}, found {len(matches)}",
        )
    return _trusted_path(matches[0], roots)


def _combined_pdf(artifacts: dict[str, Any], bundle: Path, roots: tuple[Path, ...]) -> Path:
    configured = str(artifacts.get("combined", "")).strip()
    if re.match(r"^[a-z][a-z0-9+.-]*://", configured, re.IGNORECASE):
        raise VerificationFailure("untrusted_quote_path", "Combined quote artifact must be a local path")
    if configured:
        candidate = Path(configured)
        if candidate.exists():
            return _trusted_path(candidate, roots)

    matches = sorted(bundle.glob("*_combined.pdf"))
    if len(matches) != 1:
        raise VerificationFailure(
            "quote_artifact_count_mismatch",
            f"Expected one combined PDF in {bundle}, found {len(matches)}",
        )
    return _trusted_path(matches[0], roots)


def verify_bundle(summary_path: Path, deadline_ms: int) -> dict[str, Any]:
    started_at = time.monotonic()
    roots = _allowed_roots()
    summary_path = _trusted_path(summary_path, roots)
    if not summary_path.is_file() or summary_path.stat().st_size > MAX_SUMMARY_BYTES:
        raise VerificationFailure("invalid_quote_summary", "summary.json is missing or too large")

    try:
        summary = json.loads(summary_path.read_text(encoding="utf-8-sig"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise VerificationFailure("invalid_quote_summary", f"Could not read summary.json: {error}") from error
    if not isinstance(summary, dict):
        raise VerificationFailure("invalid_quote_summary", "summary.json must contain an object")
    artifacts = summary.get("artifacts", {})
    if not isinstance(artifacts, dict):
        raise VerificationFailure("invalid_quote_summary", "summary.artifacts must contain an object")

    results, totals = _summary_totals(summary)
    bundle = summary_path.parent
    individual = _trusted_path(bundle / "individual", roots)
    if not individual.is_dir():
        raise VerificationFailure("quote_artifact_count_mismatch", "Missing individual artifact directory")

    csv_total = 0
    individual_pdf_total = 0
    for result in results:
        trade_id = result["tradeID"]
        csv_total += _csv_total(_one_artifact(individual, trade_id, ".csv", roots))
        _check_deadline(started_at, deadline_ms)
        pdf_path = _one_artifact(individual, trade_id, ".pdf", roots)
        page_totals = _pdf_page_totals(pdf_path)
        if len(page_totals) != 1:
            raise VerificationFailure("quote_artifact_count_mismatch", f"{trade_id} PDF must have one page")
        individual_pdf_total += page_totals[0]
        _check_deadline(started_at, deadline_ms)

    combined_path = _combined_pdf(artifacts, bundle, roots)
    combined_page_totals = _pdf_page_totals(combined_path)
    _check_deadline(started_at, deadline_ms)
    evidence = {
        "summary_total": totals["total"],
        "csv_total": csv_total,
        "individual_pdf_total": individual_pdf_total,
        "combined_pdf_total": sum(combined_page_totals),
        "combined_pdf_pages": len(combined_page_totals),
    }
    expected_pages = len(results)
    configured_pages = artifacts.get("pages_combined")
    if configured_pages is not None and _integer(configured_pages, "artifacts.pages_combined") != expected_pages:
        raise VerificationFailure("invalid_quote_summary", "Configured combined page count is inconsistent")
    if len(combined_page_totals) != expected_pages:
        raise VerificationFailure(
            "quote_bundle_mismatch",
            "Combined PDF page count does not match included trades",
            evidence=evidence,
        )
    if len({totals["total"], csv_total, individual_pdf_total, sum(combined_page_totals)}) != 1:
        raise VerificationFailure(
            "quote_bundle_mismatch",
            "Local quote artifacts do not agree on the final total",
            evidence=evidence,
        )

    return {
        "ok": True,
        "source": "local_quote_bundle",
        "customer": str(summary.get("customer", "")).strip(),
        "trade_count": len(results),
        "trade_ids": [result["tradeID"] for result in results],
        "total": totals["total"],
        "evidence": evidence,
        "network_requests": 0,
    }


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    verify = subparsers.add_parser("verify", help="verify one local quote bundle")
    verify.add_argument("--summary", required=True, type=Path)
    verify.add_argument("--deadline-ms", type=int, default=20_000)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        if args.deadline_ms < 1_000 or args.deadline_ms > 30_000:
            raise VerificationFailure("invalid_deadline", "deadline-ms must be between 1000 and 30000")
        result = verify_bundle(args.summary, args.deadline_ms)
        print(json.dumps(result, ensure_ascii=True, separators=(",", ":")))
        return 0
    except VerificationFailure as error:
        payload: dict[str, Any] = {
            "ok": False,
            "error": {"type": error.error_type, "message": error.message},
        }
        if error.evidence is not None:
            payload["evidence"] = error.evidence
        print(json.dumps(payload, ensure_ascii=True, separators=(",", ":")))
        return 2


if __name__ == "__main__":
    sys.exit(main())
