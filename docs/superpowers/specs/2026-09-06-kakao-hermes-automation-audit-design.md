# Kakao Hermes automatic processing audit design

## Goal

Give the owner one quiet, searchable place to see what the Kakao Hermes worker actually changed or sent without creating Slack alerts or mixing audit history into actionable follow-up work.

The owner-facing location is a fourth read-only tab in the existing follow-up screen:

`지금 할 일 | 미뤄둔 일 | 완료 | 자동처리`

The audit must answer, in owner language, what happened, when it happened, which customer/booking it affected, what changed, and whether authoritative readback proved the result.

## Scope

Included effects are only those initiated by the Kakao Hermes Gateway worker:

- Kakao auto-replies that have actual DOM send readback;
- confirmation-request creation or update;
- registered-reservation equipment, quantity, or date/time changes;
- quote or contract document sends initiated from a Kakao turn;
- blocked, failed, or partial attempts at the same operations.

Explicitly excluded:

- Slack Hermes agent work;
- manual Google Sheet or AppSheet edits;
- GAS time triggers and unrelated scheduled automation;
- manual scripts and administrator operations;
- Slack, Kakao, SMS, email, or push notifications generated solely for audit reporting.

The audit feature observes and projects existing execution evidence. It does not make customer-intent decisions, change Hermes prompts, authorize mutations, retry business operations, or become a new source of business truth.

## Chosen approach

Use the existing Gateway job, operation reservation, durable receipt, application state, and send readback as authoritative evidence. Project verified effects idempotently into a dedicated Supabase audit table, then render that table inside the existing follow-up UI.

Alternatives rejected:

- Rendering local Gateway job files directly is machine-local, difficult to search, and unsuitable for the existing web dashboard.
- Reusing `work_items_v2` would turn completed audit history into owner work, distort now/snoozed/completed counts, and risk lifecycle actions changing audit records.
- Posting one Slack card per automatic effect would create noise and contradict the requirement for quiet, on-demand review.

## Evidence and identity contract

One AI turn may produce more than one real-world effect. Audit identity is therefore one row per effect, not one row per turn.

Each row has an immutable `event_key` derived from the authoritative effect receipt:

- a native tool operation uses its exact `operation_id` plus effect type;
- an auto-reply uses the exact durable send/readback identifier plus effect type;
- a document send uses its exact delivery receipt identifier plus effect type.

`event_key` is unique. Reprocessing, process restart, HTTP response loss, or projection retry may update only delivery/synchronization metadata for the same event; it must never create a duplicate audit row.

Agent final text, suggested replies, prose IDs, and uncorrelated receipt-shaped objects are never audit authority. An event is recorded as successful only when the existing trusted receipt and authoritative readback gates already used by the production operation accept it.

## Durable data model

Create a dedicated append-oriented table, `kakao_automation_audit_events`, with the following bounded fields:

- `event_key`: immutable unique effect identity;
- `job_id`, `room_revision`, and trusted receipt identifiers for correlation;
- `occurred_at` and `recorded_at`;
- `effect_type`: `auto_reply`, `confirmation_request`, `registered_reservation_change`, or `document_send`;
- `action_type`: a bounded owner-readable subtype such as create, add, remove, replace, quantity change, date/time change, or send;
- `outcome`: `success`, `partial_success`, `failed`, `blocked`, or `no_action`;
- `customer_label`: bounded display name only, with no phone number;
- `target_type` and `target_id`: RQ, trade, or document identifier when verified;
- `summary`: one bounded owner-language sentence;
- `change_items`: a bounded array of allowlisted before/after business fields;
- `outbound_text`: the exact bounded text actually sent by the worker, only for a proven auto-reply;
- `evidence`: allowlisted receipt schema/status and authoritative readback summary;
- `source_message_at`: the relevant Kakao message timestamp when available;
- `historical_import`: whether the event was reconstructed from an existing trusted durable receipt.

The table does not store incoming raw conversation history, phone numbers, secrets, tokens, stack traces, prompts, model logs, arbitrary payloads, or unbounded receipt data.

Rows are immutable business history. Synchronization attempts and errors live in separate bounded projection metadata rather than rewriting before/after facts.

## Projection flow

1. The Gateway keeps its existing durable pre-operation reservation before any mutation.
2. The existing operation executes at most once under its current lease and operation fence.
3. Existing authoritative sheet or DOM readback determines the real outcome.
4. The Gateway persists its normal receipt/application result first.
5. A projector converts only trusted, allowlisted evidence into one or more audit events.
6. Supabase inserts each event with an atomic unique `event_key` conflict rule.
7. The Gateway marks only the audit projection as delivered after exact database readback.

Audit projection is outside the Hermes reasoning and customer-response critical path. A temporary Supabase failure leaves a durable `pending` projection that startup and maintenance retry. It never reclaims the AI job, replays a GAS mutation, resends a customer message, or regenerates a document.

The local trusted receipt remains proof while projection is delayed. The dashboard exposes a content-free `기록 동기화 지연` state if pending projections exist, without sending an alert.

## Owner-facing UI

Add `자동처리` as the fourth tab in `FollowUpView`. It is visually colocated with follow-up work but uses an independent API response and table.

It must not:

- contribute to 지금 할 일, 미뤄둔 일, or 완료 counts;
- expose complete, snooze, reopen, acknowledge, or bulk-action controls;
- create a `work_items_v2` row;
- open a Slack or Kakao action.

The default view shows today's newest events first. Each compact row contains:

- success/partial/failure icon;
- time;
- customer label;
- owner-readable action;
- the shortest meaningful result or before/after delta.

Example:

`✅ 20:15 · 김수정 · 등록예약 장비 추가 · 강풍기 0개 → 1개`

Selecting a row opens the existing mobile-friendly detail sheet pattern and shows:

- action and outcome;
- verified before/after changes;
- target RQ/trade/document identifier;
- source message time;
- authoritative readback status;
- operation/effect identifier and elapsed time.

Filters and search:

- today, recent seven days, or a bounded date range;
- customer label;
- RQ or trade ID;
- effect/action type;
- outcome, including a one-click failed/partial/blocked view.

The API is read-only, cursor-paginated, newest-first, and protected by the Today Dashboard's existing server-side authorization. No audit mutation endpoint is added.

## Existing-history backfill

After deployment, run one bounded, no-send backfill from retained trusted Gateway receipts. It may create only records whose exact effect identity and trusted result are still provable.

- It does not replay Hermes, GAS, DOM application, document generation, or customer delivery.
- It does not infer missing customer, target, before/after, or success fields.
- Unprovable historical entries are skipped and counted, not guessed.
- Imported rows are marked `historical_import=true`.

## Failure handling

- Missing or invalid trusted receipt: no success audit event; record a bounded failed/blocked event only when the durable job itself proves that outcome.
- Partial GAS or document outcome: preserve the successful and failed stages; never present it as success.
- Projection crash or database outage: keep projection pending and retry projection only.
- Duplicate projection: return the existing exact event without inserting another row.
- Conflicting data for an existing `event_key`: fail closed, preserve the first immutable row, and expose a content-free projection conflict in health/readback.
- Dashboard/API failure: business automation remains unchanged because the audit read model is not an execution dependency.

## Performance and privacy

- Projection runs after durable execution evidence has been recorded and does not add a model/tool round trip.
- List queries use indexes on `occurred_at`, `outcome`, `effect_type`, `customer_label`, and `target_id`.
- The UI initially requests only one bounded page and loads details on demand.
- Slack cards and other push delivery remain disabled for audit events.
- Exact outgoing auto-reply text is visible only in the authenticated detail view; incoming conversation text is not copied.

## Verification

- Channel/server tests prove one trusted effect produces one event across retries, response loss, and process restart.
- Tests prove one AI turn with a sheet mutation and an auto-reply produces two distinct audit events.
- Negative tests reject model-authored receipts, mismatched revisions, wrong operation IDs, malformed readback, private fields, and oversized payloads.
- Failure tests prove projection retries never rerun Hermes, GAS, DOM application, document generation, or customer sends.
- PGlite/Supabase tests prove unique-event idempotency, immutable facts, cursor pagination, filters, authorization, and exact database readback.
- API tests prove audit rows are independent from `work_items_v2` counts and actions.
- UI tests prove the fourth tab, default today view, filters, empty/error/loading states, detail sheet, and absence of task-action buttons.
- A no-send deployment verification backfills a retained trusted receipt and confirms it appears once in the live authenticated API and UI without any external message or business mutation.

## Acceptance criteria

1. Every trusted Kakao Hermes external effect supported by this design appears at most once in `자동처리`.
2. A successful row always has exact trusted receipt and authoritative readback evidence.
3. The default owner view explains the action and material delta without opening logs.
4. Audit records never affect follow-up task counts or lifecycle.
5. No Slack, Kakao, SMS, email, or push audit notification is sent.
6. Projection failure never causes a business operation replay.
7. Existing Hermes reasoning, mutation authorization, and customer-send behavior remain unchanged.
8. Live verification demonstrates source, runtime, database, API, and rendered UI readback rather than relying only on deployment status or health.
