# Owner-action handoff design

## Problem

The live Work Orchestrator currently exposes two internal implementation details to the owner:

1. Every accepted Kakao event is posted to Slack before Hermes has inspected the conversation.
2. Transient worker failures are converted into `automation_error_review` work items, which the digest treats like business work.

Live readback on 2026-09-03 confirmed the impact without reading customer content: 28 immediate raw-message posts were delivered; 29 of 40 active work items were `automation_error_review`; and 28 of the 39 items in the 18:00 digest were that technical type.

The desired product is an AI employee, not an event-notification system. The employee must read and consolidate the conversation, attempt safe work, and hand off only the remaining decision or action.

## Product contract

### Silent intake

- An accepted Kakao event is durable internal input only.
- It must not create or send a Slack message before semantic classification.
- Existing Kakao event/queue persistence remains the audit trail. A separate per-event Slack-notification obligation is not created.
- Historical notification receipts remain available for exact-coordinate cleanup and audit; this change does not delete them.

### Hermes-first processing

- Preserve Hermes as the semantic decision-maker.
- Preserve the existing behavior that opens the conversation, distinguishes customer and staff turns, and merges consecutive customer bubbles into one request.
- Deterministic code may validate, persist, deduplicate, schedule, and render the result. It must not replace Hermes business judgment with keyword routing.

### Finite outcomes

After Hermes and the safe automation steps run, a conversation has one of four externally meaningful outcomes:

1. `handled`: the request was answered or completed safely; no owner work and no ordinary notification.
2. `no_action`: informational, duplicate, staff-latest, or otherwise not owner-actionable; no owner work.
3. `owner_handoff`: one stable work item for the remaining business decision/action.
4. `critical_owner_handoff`: the same semantic work item plus the existing P0 immediate escalation, only when Hermes explicitly marks it P0 and human action is still required.

Transport errors, timeouts, history lookup failures, persistence failures, and retry state are operational evidence, not a fifth owner-facing outcome.

### Owner handoff shape

Each owner-facing item must describe the business case rather than the implementation failure:

- title: customer/case plus the decision or action needed;
- summary: what the customer wants and what the AI employee already checked or completed;
- recommended action: one concrete next action for the owner;
- optional suggested reply;
- stable conversation/business key so multiple messages and retries merge into one item;
- `requires_human_action=true` and a supported semantic work type.

Raw transcript dumps, stack traces, worker error names, retry codes, job IDs, and `automation_error_review` wording are forbidden in owner-facing cards and digests.

## Data flow

```text
Kakao event
  -> durable event/queue record (silent)
  -> room debounce and latest-revision fencing
  -> Hermes opens and reads the conversation
  -> Hermes classifies one customer turn and proposes safe automation
  -> deterministic validation and safe automation execution
     -> handled/no_action: audit only
     -> owner_handoff: upsert one stable work item
     -> critical_owner_handoff: upsert one work item, then P0 escalation
  -> scheduled digest selects owner-handoff work only
```

## Failure handling

- A transient worker failure stays in the durable worker/recovery state and operational logs.
- It must not immediately create `automation_error_review` or `reservation_review_timeout` work.
- Retries use the existing recovery path.
- A technical failure by itself is never rendered in the digest.
- If a later successful Hermes pass identifies a real remaining customer action, that semantic result creates the owner handoff normally.
- Health may report aggregate operational failure counts and bounded codes, but the owner digest does not.

This design deliberately does not invent a generic owner task for an unread conversation. The employee must first understand the case before handing it off.

## Digest rules

- Select only active, actionable rows whose payload explicitly says `requires_human_action=true`.
- Exclude technical work types, including `automation_error_review` and `reservation_review_timeout`, even when historical rows remain open.
- Render the semantic title, employee summary, and recommended action.
- Keep existing snooze, progress, resolve, dismiss, and P0 acknowledgement actions.
- Automatic successes and `completed_log` rows remain excluded.
- Existing 29 technical rows are preserved for audit but disappear from future owner digests; no mass data mutation is part of this change.

## Runtime cutover

- The bridge must stop calling the immediate raw-notification path for accepted Kakao events.
- The shadow notification-receipt path must also stop creating new per-event delivery obligations; otherwise silent events would become a false SLA backlog.
- The worker and bridge must stop creating v2 human work from technical failure helpers.
- The semantic `follow_up_items` path remains the sole producer of new owner work.
- The existing P0 runtime remains the only immediate owner notification path after classification.
- Historical notice cleanup remains enabled until old exact Slack coordinates converge.

## Verification

Regression tests must prove:

1. An accepted ordinary event is persisted/queued but causes zero Slack posts before classification.
2. Multiple messages in one room produce one consolidated semantic work item.
3. A successful automated result produces no owner work and no digest item.
4. A transient or exhausted technical worker failure creates operational evidence but no owner work item.
5. Historical `automation_error_review` and `reservation_review_timeout` rows are excluded from selection.
6. A semantic owner handoff renders what was requested, what the employee already did, and the one next action, without raw transcript or technical error details.
7. An explicit unresolved Hermes P0 still receives immediate escalation after the work item is durable.
8. Full Work Orchestrator, AI worker, Kakao bridge, and Windows lifecycle suites remain green.

## Non-goals and safety

- No customer reply, Slack deletion, database cleanup, or historical work-item mutation is authorized by this implementation alone.
- No keyword classifier or deterministic routing layer replaces Hermes reasoning.
- No GAS sheet structure or column order changes.
- Live deployment and runtime restart require verification of the feature branch and an explicit integration step; rollback must preserve the prior runtime contract.
