# Registered trade date change

Use when the owner asks to move an already-registered reservation to a new date or interval. The AI still interprets the whole natural-language request and identifies customer, old date, new interval, and any explicit instruction about availability conflicts.

## Bounded workflow

1. Preserve the registered pickup/return times unless the owner explicitly supplied new times. Omit `startTime` and `endTime` from the payload to preserve them.
2. Run the single neutral-runtime command below. Prefer the name + current date envelope; use an exact `tradeId` when already known.

```bash
printf '%s' '{"name":"customer","currentDate":"YYYY-MM-DD","newStartDate":"YYYY-MM-DD","newEndDate":"YYYY-MM-DD","allowConflicts":false}' | node.exe "$HERMES_HOME/scripts/village/village-trade-date-change.js" change
```

3. Treat success only when the runner reports authoritative readback for all three layers: `계약마스터`, every `스케줄상세` row, and `거래내역`, plus successful contract regeneration. If it reports `CONFLICT`, show the complete structured equipment/requested/available evidence and stop. Set `allowConflicts:true` only when the owner's original instruction explicitly accepts those conflicts, or after the owner explicitly approves the reported conflicts.
4. The runner never sends a customer message. An internal date change does not authorize Kakao, Alimtalk, Slack delivery, or document delivery.
5. If the target is ambiguous, ask for the missing identifier. Do not inspect repository source, use a generic sheet write, construct a raw GAS/curl request, open a browser, or use Computer Use as a fallback.

If the same owner instruction also removes equipment, finish and verify the date change first, then use the existing exact `scheduleId` removal route. Never substitute an approximate equipment-name deletion when duplicate set/component names exist.

## Reporting

Lead with the trade ID and final interval, then report preserved times, contract regeneration, availability warnings, and confirmation that all authoritative layers matched. Keep the final concise.
