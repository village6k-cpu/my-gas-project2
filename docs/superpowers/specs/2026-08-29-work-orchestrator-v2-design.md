# Work Orchestrator v2 Design

**Date:** 2026-08-29  
**Status:** Design approved; implementation planning awaits owner review of this document  
**Primary objective:** Preserve one immediate notification for every inbound message while replacing persistent per-message Slack cards with a durable human-work queue, periodic focus digests, verified automation, and reminders that cannot silently disappear.

## 1. Non-negotiable principles

1. Every inbound message must produce at least one immediate notification. A digest must never delay or replace the first notification.
2. An immediate notification is not a durable work item. The system creates persistent human work only when an action remains after safe automation and authoritative readback.
3. Hermes remains the native reasoning and tool-selection layer. Work Orchestrator v2 persists state, enforces lifecycle invariants, schedules reminders, and verifies typed results; it must not replace Hermes judgment with a deterministic business-decision router.
4. Existing bounded authorization rules remain in force. The orchestrator must not broaden what Hermes may send, register, modify, invoice, or approve.
5. An item appearing in a digest is not completion. It remains active and reappears until authoritative resolution, explicit dismissal, or a bounded snooze.
6. Slack is a notification and action surface, not the source of truth. Durable state lives in Work Orchestrator v2.
7. P0 work remains separate from ordinary digests and is never auto-deleted before acknowledgement.
8. Bot cleanup is exact and fail-closed: delete only the configured bot's known message coordinates or messages matching an approved bot-only signature. Never delete human messages, source thread messages, or other applications' messages.
9. Delivery success, automation success, and work completion are three different facts and must be recorded separately.
10. A health endpoint, enabled flag, process, or HTTP 200 is not end-to-end proof. Cutover requires event receipt, Slack delivery readback, work-state readback, and automation result readback where applicable.

## 2. Terminology

### 2.1 Existing `rpa-automation-operations`

This is a profile-scoped health and recovery runbook for the existing Chrome watcher, bridge, queue, and worker. It is not a new business automation engine and must not become the core of this design.

### 2.2 Existing automation engine

The current path is:

```text
Kakao DOM watcher -> bridge -> Hermes kakaoworker -> bounded Village tools/runners
```

This path continues to perform native reasoning, approved actions, and readback. Work Orchestrator v2 consumes its typed outcomes.

### 2.3 Work Orchestrator v2

Work Orchestrator v2 is the new durable lifecycle layer. It owns notification receipts, real human-work state, digest inclusion, reminder cadence, snooze state, resolution evidence, and Slack cleanup coordinates.

Do not call Work Orchestrator v2 “RPA.” Keeping the names separate prevents the old operational runbook from being mistaken for the new work-state architecture.

## 3. Confirmed baseline and reset

The production baseline audit on 2026-08-29 found:

- direct follow-up production and Slack card delivery enabled in the active `kakaoworker` runtime;
- 4,918 legacy `ai_follow_up_items` rows at the cleanup cutoff;
- 2,614 unique exact Slack coordinates recorded in legacy payloads;
- live schema drift: the production table stores Slack coordinates in `payload.slack_delivery`, while the repository schema also describes top-level Slack columns that are absent in production;
- legacy `slack_backstop` rows that sometimes store a human source-message timestamp as though it were a card coordinate;
- the old backstop is not an active scheduled producer, while current direct producers are active.

Cleanup cutoff: `2026-08-28T21:52:12.8489792Z`.

The approved reset produced this verified result:

- 1,622 exact bot messages deleted;
- 980 exact coordinates already absent;
- 12 `cant_delete_message` responses traced to non-bot source coordinates rather than deletable current-bot cards;
- 58 additional current-bot messages found by narrow signatures and deleted: 49 historical P0 alerts and 9 orphan follow-up action cards;
- zero current-bot follow-up/P0 signature messages remaining before the cutoff;
- human messages preserved;
- all 1,294 active legacy rows at or before the cutoff moved to `dismissed`, including eight final rows marked with a `legacy_card_cleanup` audit payload;
- zero active legacy rows remaining at or before the cutoff.

This reset is the clean baseline. Work Orchestrator v2 must not reopen or re-import dismissed legacy rows by default.

## 4. Evaluated approaches

### 4.1 Restore the old Slack backstop

Slack would again be treated as the authoritative task source and scanned into `ai_follow_up_items`.

**Decision:** Rejected. It cannot reliably distinguish a human source message from a bot card, reintroduces delayed reverse synchronization, and preserves the source-of-truth ambiguity that caused the current clutter.

### 4.2 Extend `ai_follow_up_items`

This is the fastest implementation but inherits mixed producers, legacy payload shapes, schema drift, stale status semantics, and card-delivery fields coupled to business work.

**Decision:** Rejected as the target. Freeze the table as legacy after cutover and keep it read-only for audit/rollback evidence.

### 4.3 Create Work Orchestrator v2 tables and lifecycle

The new schema separates immediate receipts, durable work, and digest runs while preserving the existing Hermes automation path.

**Decision:** Approved target.

## 5. Target architecture

```text
Inbound Kakao message
        |
        +--> Notification Receipt Writer
        |      - idempotent source event key
        |      - immediate Slack notice
        |      - delivery readback
        |
        v
Existing Hermes kakaoworker lifecycle
        |
        +--> safely auto-processable
        |      - bounded action
        |      - authoritative readback
        |      - update notice to “auto-processed”
        |      - no human work item
        |
        +--> unsafe / ambiguous / approval-required / failed
               - create or merge work_items_v2
               - keep stable work item ID
               - classify P0 separately
                       |
                       v
               Digest Scheduler
                 - focus-window digest
                 - carry-over and overdue rules
                 - snooze and reminder state
                 - replace prior digest only after new delivery succeeds
                       |
                       v
               Slack action surface
                 - progress / snooze / resolve / dismiss
                 - authoritative readback before completion where possible
```

The notification path is synchronous with event ingestion. Automation and durable work classification may continue asynchronously, but their latency must never suppress the first notice.

## 6. Durable data model

### 6.1 `message_notification_receipts`

One row represents the first-notification obligation for one source event.

Required fields:

| Field | Purpose |
|---|---|
| `id` | Stable receipt identifier |
| `source` | `kakao`, future connector, or bounded internal source |
| `source_event_key` | Globally idempotent event key; unique |
| `source_message_id` | Native source identifier when available |
| `room_key` | Stable conversation scope |
| `received_at` | Ingestion time |
| `urgency` | `p0`, `urgent`, `normal`, `low` |
| `notification_state` | `pending`, `delivering`, `delivered`, `failed`, `cleanup_pending`, `deleted` |
| `slack_channel_id` | Exact bot delivery coordinate |
| `slack_message_ts` | Exact bot delivery coordinate |
| `delivered_at` | Slack delivery confirmation time |
| `cleanup_after` | Earliest allowed auto-cleanup time |
| `cleanup_state` | Separate cleanup lifecycle and last error |
| `payload` | Typed, non-secret audit metadata |

Invariants:

- `source_event_key` is unique.
- A retry updates the same receipt; it does not create a second first-notification obligation.
- `delivered` requires a Slack API success response with stored coordinates.
- P0 receipts have no cleanup deadline until acknowledged.
- Cleanup failure does not change delivery success or work status.

### 6.2 `work_items_v2`

One row represents one unresolved unit of human work, not one message.

Required fields:

| Field | Purpose |
|---|---|
| `id` | Stable work item ID shown across every digest |
| `work_key` | Idempotent semantic/operational key; unique while active |
| `source_event_keys` | Events merged into the work item |
| `room_key` | Conversation scope |
| `title`, `summary` | Human-readable current state |
| `work_type` | Typed operational class |
| `priority` | `p0`, `urgent`, `normal`, `low` |
| `state` | `open`, `in_progress`, `snoozed`, `resolved`, `dismissed` |
| `owner_id` | Current accountable owner, nullable only by explicit policy |
| `actionable_at` | When the item should next appear |
| `due_at` | Operational deadline when known |
| `snoozed_until` | Bounded snooze deadline |
| `first_opened_at` | Aging origin |
| `last_activity_at` | Latest relevant source/automation activity |
| `digest_inclusion_count` | Successful digest appearances |
| `consecutive_unhandled_digests` | Carry-over counter |
| `last_digest_at` | Last successful inclusion |
| `next_reminder_at` | Scheduler-owned next reminder |
| `automation_state` | `not_attempted`, `running`, `succeeded`, `failed`, `needs_human` |
| `resolution_kind` | Automated, authoritative, manual, or dismissed |
| `resolution_evidence` | Typed readback reference without secrets |
| `resolved_at`, `resolved_by` | Completion audit |
| `version` | Optimistic concurrency token |
| `payload` | Additional typed evidence |

Invariants:

- Digest delivery never changes `state` to `resolved`.
- `snoozed` requires `snoozed_until`; expiry returns it to an actionable state automatically.
- Automated completion requires authoritative readback, not merely a successful tool invocation.
- Manual completion records actor, time, and the reason authoritative readback was unavailable.
- New messages merge into an active work item only when the current Hermes lifecycle returns an explicit stable work key or typed linkage. Do not use loose customer-name matching.
- Updates use optimistic concurrency or compare-and-swap to prevent a stale Slack action from overwriting a newer resolution.

### 6.3 `digest_runs`

One row represents one attempted focus digest.

Required fields:

| Field | Purpose |
|---|---|
| `id` | Digest run ID |
| `window_started_at`, `window_ended_at` | Covered source window |
| `scheduled_at` | Intended run time |
| `state` | `building`, `delivering`, `delivered`, `failed`, `replaced` |
| `item_snapshot` | Work IDs, versions, ordering, and inclusion reason |
| `slack_channel_id`, `slack_message_ts` | Exact digest coordinate |
| `delivered_at` | Confirmed delivery time |
| `previous_digest_id` | Replacement chain |
| `previous_deleted_at` | Cleanup readback for prior digest |
| `error` | Bounded failure detail |

Invariants:

- Work-item inclusion counters advance only after digest delivery succeeds.
- A new digest deletes/replaces the previous digest only after the new digest is confirmed delivered.
- Failed deletion of a previous digest is recorded and retried; it does not roll back the new digest.
- `item_snapshot` stores IDs and versions so later audits can explain what the owner saw.

## 7. Event lifecycle

### 7.1 Immediate notification

1. Persist or claim `message_notification_receipts` by `source_event_key`.
2. Post one concise immediate notice to the configured Slack destination.
3. Store exact Slack coordinates and delivery time.
4. If delivery is ambiguous, mark reconciliation required and verify before retrying; do not blindly duplicate.
5. Continue Hermes processing independently of the first-notification receipt.

The immediate notice should communicate that a message arrived, not pretend that a human task has already been proven.

### 7.2 Safe automated processing

Hermes may immediately act only through the currently approved bounded tools and gates.

1. Record `automation_state=running` on the correlated lifecycle record.
2. Execute the bounded action selected by Hermes.
3. Read the authoritative target state back through the real runtime/API.
4. On confirmed success, set `automation_state=succeeded`, store resolution evidence, and update the immediate notice to an auto-processed result.
5. Do not create a human work item.
6. Schedule the auto-processed notice for TTL cleanup.

If execution or readback fails, create/merge a human work item with the failure evidence. A successful command without readback is not completion.

### 7.3 Human work creation

Create or merge `work_items_v2` only when at least one of these is true:

- policy requires owner approval;
- intent or evidence remains ambiguous;
- a safe automation tool does not exist;
- a bounded action fails or cannot be verified;
- Hermes explicitly returns typed `needs_human`;
- a deadline/incident requires human ownership even if a partial automation succeeded.

The work item uses a stable ID and accumulates related source events. It does not create a permanent Slack card per message.

### 7.4 P0 path

P0 bypasses ordinary digest timing.

- Send the immediate notice with P0 treatment and explicit owner mention/channel attention according to existing policy.
- Create/merge a P0 work item immediately.
- Repeat using the bounded exponential cadence and maximum-attempt policy.
- Do not delete the P0 notice or remove it from the P0 surface until acknowledgement or authoritative resolution.
- After acknowledgement, unresolved P0 work remains in digests with P0 ordering until resolved.

## 8. Digest and reminder policy

The default focus interval is configurable and starts at three hours. Changing the interval must not change work aging or completion semantics.

Digest ordering:

1. P0 acknowledged-but-unresolved items;
2. overdue items;
3. urgent items;
4. owner-mentioned carry-over items;
5. remaining actionable items ordered by due time and age.

Reminder rules:

- Every actionable unresolved item appears in every subsequent digest.
- After two consecutive delivered digests without progress, increment carry-over count and mention the owner.
- At 24 hours unresolved, mark overdue and move it to the top section.
- At 72 hours unresolved, send one separate reminder per day until progress, snooze, dismissal, or resolution.
- Snooze presets: three hours, today evening, tomorrow, or an explicit date/time.
- A snoozed item is omitted until `snoozed_until`, then re-enters the next eligible digest without losing its original age.
- New source activity on a snoozed item may wake it early only when the typed event indicates urgency or materially changes the required action.

Digest actions must operate on work item ID plus version. Stale buttons return an explanatory no-op rather than mutating newer state.

## 9. Slack message cleanup policy

### 9.1 Ordinary immediate notices

Once a delivered digest includes the related outcome or work item, an ordinary immediate notice becomes cleanup-eligible. Delete only by its stored bot coordinates and only after confirming the digest delivery.

### 9.2 Auto-processed notices

Update the existing notice with the verified result and retain it for a configurable TTL. Delete by exact bot coordinates after TTL. A cleanup failure is retried and audited.

### 9.3 Digest replacement

Keep at most one current focus digest per destination. Post the new digest, confirm delivery, then delete the previous digest. Never delete the previous digest first.

### 9.4 P0 notices

No auto-deletion before acknowledgement. Resolution may replace the content with a concise resolved state before TTL cleanup.

### 9.5 Authorship guard

Before any bulk cleanup:

- use the configured bot identity from `auth.test`;
- require an exact stored coordinate or an approved narrow signature;
- treat foreign/human authorship as an exclusion, not a deletion error to bypass;
- preserve thread roots unless the root itself is a verified bot notice target;
- record `deleted`, `already_absent`, `cant_delete_message`, rate-limit, and other failures separately.

## 10. Failure handling and recovery

| Failure | Required behavior |
|---|---|
| Immediate Slack delivery fails | Keep receipt pending/error, retry with idempotent reconciliation, and surface an operational alarm |
| Slack response is ambiguous | Search exact client ID/coordinate before reposting |
| Hermes times out | Create or merge one human work item with typed failure evidence; do not create duplicate cards |
| Automation action succeeds but readback fails | Keep human work open as verification required |
| Digest build fails | Do not advance inclusion counters or delete the previous digest |
| Digest delivery fails | Preserve previous digest and retry the same run idempotently |
| Slack cleanup fails | Preserve work state; retry cleanup separately |
| Slack action is stale | Return no-op with current state/version |
| Scheduler restarts | Recompute due work from durable timestamps and leases; no in-memory-only reminder state |
| Two schedulers overlap | Lease/claim one digest run and use compare-and-swap |

## 11. Cutover strategy

### Phase 0: Baseline reset — completed

- Freeze the exact cleanup cutoff.
- Delete legacy current-bot cards and narrow orphan signatures.
- Preserve human messages.
- Dismiss active legacy rows at/before the cutoff.
- Verify zero legacy active rows and zero matching current-bot messages.

### Phase 1: Schema and dark-write

- Create v2 tables, indexes, triggers, service-role policies, and audit fields.
- Add contract tests and schema tests first.
- Write notification/work decisions in shadow mode while current immediate Slack behavior remains unchanged.
- Do not send v2 digests yet.

### Phase 2: Immediate receipt cutover

- Route every inbound event through the receipt writer.
- Prove exact-once delivery under duplicate events, worker restart, Slack timeout, and ambiguous response.
- Keep the old direct producer enabled until the v2 receipt path has runtime readback proving every test event received an immediate notice.
- At the cutover boundary, disable only the old persistent-card post path. Do not disable the first-notification obligation.

### Phase 3: Human-work and digest pilot

- Enable `work_items_v2` creation for typed human-required outcomes.
- Start with a single owner/destination and three-hour digests.
- Verify carry-over, snooze, 24-hour overdue, 72-hour daily reminder, versioned actions, and digest replacement.
- P0 remains on the separate immediate path throughout.

### Phase 4: Automation result integration

- Connect existing bounded Hermes action/readback results.
- Suppress human work only after authoritative success.
- Update and TTL-clean auto-processed notices.

### Phase 5: Legacy freeze

- Disable legacy `ai_follow_up_items` producers and dashboard writes only after v2 readback passes.
- Keep the table available read-only for audit and bounded rollback.
- Do not restart `slack-followup-backstop`.
- Do not migrate dismissed rows. Any exceptional migration requires explicit owner selection and current authoritative verification.

## 12. Observability

Minimum runtime readback:

- inbound events received versus notification receipts created;
- pending/failed/ambiguous notification deliveries and oldest age;
- automation running/succeeded/failed/readback-required counts;
- actionable/snoozed/overdue/P0 work counts;
- digest scheduled/delivered/failed and last successful delivery;
- unresolved items omitted from an eligible delivered digest, which must be zero;
- cleanup pending/failed and oldest age;
- stale Slack actions and version conflicts;
- scheduler lease owner and freshness.

Alert conditions include any inbound event without a delivered immediate receipt beyond the bounded delivery SLA, any eligible work item omitted from a successful digest, any P0 without the required alert/ack state, and any digest replacement that deletes the old digest before confirming the new one.

Metrics must not expose customer message content, credentials, or internal write secrets.

## 13. Test strategy

Implementation follows regression-first TDD.

Required contract tests:

1. Duplicate source event creates one receipt and at most one immediate notice.
2. Slack ambiguous timeout reconciles before retry and does not duplicate.
3. Every inbound event receives an immediate notification even when Hermes is slow or down.
4. Safe automation with authoritative readback creates no human work item.
5. Automation without readback leaves one human work item open.
6. Multiple related messages merge into one stable work item only with typed linkage.
7. Digest inclusion does not resolve an item.
8. Unresolved items reappear in every eligible digest.
9. Two missed digests trigger owner mention/carry-over state.
10. 24-hour and 72-hour reminder boundaries are deterministic across restart.
11. Snooze hides an item only until the requested deadline and preserves original age.
12. P0 bypasses digest timing and cannot be auto-deleted before acknowledgement.
13. New digest delivery must succeed before prior digest deletion.
14. Human and foreign-bot messages can never enter a cleanup target set.
15. Stale Slack actions cannot overwrite a newer work version.
16. Legacy dismissed rows remain closed and are not imported automatically.

Runtime verification must include a no-customer-send test event or an approved internal test source. Production validation must not fabricate customer messages, mutate schedules, issue invoices, or send customer-facing replies.

## 14. Acceptance criteria

Work Orchestrator v2 is ready for production cutover only when all of the following are proven through the real runtime path:

- 100% of test inbound events receive one immediate Slack notification with exact delivery readback;
- duplicate/retry tests produce no duplicate first notices;
- ordinary messages no longer create permanent per-message Slack cards;
- every real human-required item appears in the next eligible digest;
- unresolved items survive digest replacement, restart, and snooze expiry;
- two-miss, 24-hour, 72-hour, and P0 policies behave as specified;
- safe automation suppresses human work only after authoritative readback;
- Slack cleanup deletes only configured-bot messages and leaves human/other-app messages unchanged;
- zero eligible unresolved items are missing from a successful digest;
- rollback can re-enable the prior first-notification path without reopening the legacy backlog;
- active profile, process, hashes/config, event receipt, Slack delivery, work row, digest row, and resolution evidence are all captured in the cutover report.

## 15. Explicit non-goals

- Rebuilding Hermes reasoning as a rules engine.
- Reviving the old Slack backstop as the production source of truth.
- Automatically migrating the dismissed legacy backlog.
- Expanding customer-send, schedule-write, invoice, or approval authority.
- Deleting human messages, other applications' messages, or source thread roots.
- Treating one digest appearance, one tool call, `/health 200`, or an enabled flag as proof of completion.

