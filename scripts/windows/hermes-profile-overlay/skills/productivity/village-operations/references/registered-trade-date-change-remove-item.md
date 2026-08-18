# Registered trade correction

Use this path for one authorized correction to an already-registered trade:
date/time changes, equipment or quantity changes, or a combination of them.
Hermes interprets the whole request and decides the exact business delta first.
The runner only validates and executes that already-understood delta.

## One-call boundary

Resolve the active runtime root (`<active-runtime-root>`) from
[Windows runtime and authoritative sources](windows-runtime-and-sources.md).
Write one JSON file, substitute that documented root, and run exactly one
correction command:

```powershell
node.exe "<active-runtime-root>/scripts/windows/village-registered-trade-correction.js" execute --input-file "<absolute-json>"
```

The JSON envelope is:

```json
{
  "tradeId": "YYMMDD-NNN",
  "operationId": "8f6c77d1-8828-4a85-bf74-13815d96bf51",
  "dateChange": {
    "newStartDate": "YYYY-MM-DD",
    "newEndDate": "YYYY-MM-DD"
  },
  "remove": [
    { "scheduleId": "exact-schedule-id", "expectedName": "exact current item name" }
  ],
  "add": [
    { "name": "exact catalog name", "qty": 1 }
  ],
  "sendEstimate": false
}
```

- Include only the requested changes. Omit `dateChange`, `remove`, or `add` when
  that part does not change.
- Omit `startTime` and `endTime` to preserve the registered times. Include them
  only when the owner explicitly supplied new times.
- Use the exact `scheduleId` plus `expectedName` for every removal and an exact
  catalog name for every addition. Ask one focused question if identity is
  materially ambiguous.
- Removing a set representative row removes all components of that exact set
  instance. Removing a component row removes only that row. Inspect the live
  schedule hierarchy before the AI selects the exact `scheduleId`.
- Generate a unique `operationId` for this decision. Never reuse it for a
  different correction.
- Keep `sendEstimate:false` unless the same instruction explicitly authorizes
  customer delivery. An internal correction never implies a send.

The GAS operation preflights the complete intended state, holds one bounded
lock, applies additions before removals, regenerates the contract once after
unlock, and returns authoritative readback. Do not split the work into separate
date/remove/add/regenerate calls, do not use generic Sheet writes, and do not
construct raw GAS requests.

## Failure contract

Treat success only when the runner returns verified final state and contract
regeneration. On `BUSY`, `PARTIAL_STATE`, timeout, malformed response, or any
unknown outcome, stop and report the structured evidence. Never blindly retry,
manually restore, or start a second mutation until authoritative readback has
resolved the first operation.

## Reporting

Lead with the trade ID and verified final interval/items. Then report contract
regeneration, whether a quote was sent, and any remaining uncertainty. Keep the
final concise.
