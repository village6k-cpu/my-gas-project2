# Heybilli inquiry case cards design

## Goal

Turn the follow-up screen into an owner-facing work report. One continuous customer inquiry is one card, while the concrete work produced by that inquiry remains individually actionable inside the card.

## User-visible contract

- A continuous Kakao inquiry from one room is shown as one case card, even when the worker produced several work items.
- A case may carry multiple business categories. Category filtering matches a case when any unfinished step belongs to that category.
- The card shows a short, non-technical brief, the received date/time, and a Korean calendar-day age label.
- The detail view shows the same brief and a checklist of concrete work steps.
- Each step keeps its own durable work item id and version. Actions apply to that exact step and the case is reloaded after settlement.
- Raw summaries, phone numbers, room keys, source-event keys, payloads, automation error tokens, and full equipment diagnostics are never returned to the browser by the case-list RPC.
- Existing rows are not deleted or rewritten to achieve grouping.

## Inquiry grouping

The read model groups eligible rows before filtering, counting, ordering, and pagination.

1. Rows are partitioned by the internal `work_items_v2.room_key` conversation key.
2. Within each conversation they are ordered by `first_opened_at`, then id.
3. A new case starts when the gap from the previous row is greater than 30 minutes.
4. A row without a valid private conversation key forms its own case and is never merged by customer name alone.
5. The case id is the earliest member work-item id. This is stable for existing history and exposes no private conversation key.

The 30-minute boundary intentionally groups the observed Jeong Won-geun sequence, which spans 22 minutes, while preventing unrelated later conversations from being merged indefinitely.

## Case state and ordering

- `now`: at least one member is open/in progress, or a snoozed member is due again.
- `snoozed`: no member is `now`, and at least one member is snoozed into the future.
- `completed`: every member is resolved or dismissed.
- Priority and due ordering use the strongest unfinished member: effective unacknowledged P0 first, then overdue, then priority, then earliest received time and case id.
- Summary counts are unique case counts. Category counts are unique cases containing that category, so category counts may overlap and need not sum to the total.

## Owner-safe presentation

The RPC returns business facts needed for presentation, not raw evidence:

- `caseTitle`: concise customer/case heading derived from bounded work titles.
- `ownerBrief`: a bounded plain-language brief. Text containing internal error vocabulary, identifiers, phone-number-like data, or oversized diagnostics is replaced with a neutral work-type-based sentence.
- `receivedAt`: earliest member `first_opened_at`.
- `updatedAt`: latest member `updated_at`.
- `categories`: distinct business categories.
- `steps`: exact safe work items with id, version, label, state, priority, safe action label, and time fields.

The browser never receives `work_items_v2.summary`, full `recommended_action`, or the work payload. Presentation logic is deterministic redaction/formatting only; it does not invent customer, equipment, schedule, price, or inventory facts.

## UI

- List cards emphasize: priority, state, title, short brief, task progress, categories, and `접수 M/D HH:mm · N일 전`.
- Detail uses the sections `요청 요약`, `처리할 일`, and `접수 정보`.
- Each work step has its own progress/snooze/P0 acknowledgement/completion/dismiss actions as allowed by state.
- Mobile detail remains a bottom sheet; desktop remains master-detail.
- After any action, the screen reloads the current case query so grouping and state are recomputed authoritatively.

## Database and security

- Add `list_heybilli_owner_cases_v2(...)`; retain the old work-list RPC for rollback compatibility.
- The new function is `STABLE SECURITY INVOKER` with an empty `search_path`.
- Revoke execution from `PUBLIC`, `anon`, and `authenticated`; grant only `service_role`.
- The response is finite, exact-shape, content-bounded, and grouped before pagination.
- No schema/table mutation or historical data cleanup is part of this change.

## Verification

- PGlite proves the observed same-room 22-minute sequence becomes one case with unique steps.
- PGlite proves a gap greater than 30 minutes creates a second case.
- Multi-category filtering and overlapping category counts are case-based.
- Pagination/counts occur after grouping.
- Technical work types and private/raw fields are absent.
- API/model validators reject extra, malformed, unsafe, or unbounded fields.
- Model tests prove KST date and calendar-day age formatting.
- UI source tests prove checklist/report layout and removal of raw summary sections.
