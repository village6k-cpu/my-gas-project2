# Document-send natural-language resolution

Session learning: for Village Slack/Hermes document-send workflows, do **not** design the UX around staff knowing `거래ID`. Staff naturally ask by customer/date, e.g. `6월 1일 김태완 건 견적서 발송해줘`.

## Correct resolver flow

1. Parse the Korean staff request:
   - customer name: `김태완`
   - date: `2026-06-01` from `6월 1일` using current year/context
   - document type: `견적서`, `거래명세서`, `계약서 링크`, or `증빙`
   - action wording: `발송/보내줘/전송` means side-effect; `만들어줘/확인/링크 알려줘` may be preview/info only.
2. If a 거래ID is explicitly present, use it as a shortcut.
3. Otherwise call the reservation system resolver in `my-gas-project2`:
   - `GET {WEBAPP_URL}?key=***&action=tradeCandidates&name={고객명}&date={YYYY-MM-DD}`
4. Candidate handling:
   - exactly 1 candidate with `tradeId`: use it.
   - 0 candidates: report not found and ask for more context.
   - 2+ candidates: stop; present candidates for selection. Never send documents on an ambiguous match.
5. Once the trade is resolved, call the document system in `my-gas-project`:
   - quote: `POST { action: "sendEstimate", id: tradeId }`
   - statement: `POST { action: "sendStatement", id: tradeId }`
   - contract link/info: use the info/contract-link endpoint; do not send unless wording explicitly requests send.
   - Do not perform payment/settlement side effects from this document-send workflow.

## Verified example

Input:

```text
6월 1일 김태완 건 견적서 발송해줘
```

`tradeCandidates` returned one candidate:

```json
{
  "tradeId": "260528-005",
  "name": "김태완",
  "checkout": "2026-06-01 22:00",
  "checkin": "2026-06-02 22:00",
  "status": "예약"
}
```

Planned document action:

```json
{ "action": "sendEstimate", "id": "260528-005" }
```

## Implementation note

A local helper may live under:

```text
C:/Village/runtimes/my-gas-project2-production/tools/village-doc-send/
```

Useful module split:

- `intent.mjs` — parse Korean staff text.
- `resolver.mjs` — build `tradeCandidates` lookup and enforce unique-candidate safety.
- `runner.mjs` — compose parse + resolve + document action planning/execution.

Tests should cover:

- customer/date request resolves without requiring 거래ID.
- `견적서 만들어줘` does not send.
- ambiguous candidates stop before side effects.
