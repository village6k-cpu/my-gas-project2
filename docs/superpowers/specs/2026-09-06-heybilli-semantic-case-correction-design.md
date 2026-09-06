# Heybilli semantic inquiry correction design

## Goal

Make Heybilli behave like an executive assistant: understand one customer inquiry as one durable case, collapse repeated paraphrases of the same owner task, preserve the business facts needed to understand the issue, and make the mobile detail sheet obviously dismissible.

## Confirmed root causes

- The deployed case RPC groups by `room_key` and a rolling 30-minute gap. It does not make a semantic same-inquiry decision.
- The owner brief is synthesized from a taxonomy label such as `스케줄 확인`, so meaningful request, missing-item, conflict, and decision facts are discarded even when they exist in `work_items_v2.summary`.
- The AI already emits `taskKey`, but it is not shown the durable open cases/tasks for the room. A continuing Apple-box incident therefore received several plausible but different keys.
- The mobile detail sheet has only a 6px handle button. There is no backdrop close, visible close button, Escape close, or downward swipe gesture.

## Semantic identity contract

Before classifying an opened Kakao conversation, the worker reads a bounded service-only context for active work in that exact room. The context exposes only the identifiers and business summaries the AI needs:

- `caseKey`: durable semantic identity of an unresolved customer goal/problem.
- `taskKey`: durable semantic identity of one owner action inside that case.
- `title`, `requestSummary`, `problemSummary`, `nextActionSummary`, and task labels.

The AI decision adds one top-level `owner_case` object:

```json
{
  "caseKey": "customer-request semantic key",
  "title": "concise customer and issue heading",
  "requestSummary": "what the customer asked for",
  "problemSummary": "what is missing, conflicting, or not yet confirmed",
  "nextActionSummary": "what the owner should do next"
}
```

Rules:

1. If the current customer turn continues an existing open case, copy its `caseKey` exactly.
2. If an owner action repeats an existing task in that case, copy its `taskKey` exactly.
3. Different wording, a later bubble, phone request, or added supporting fact does not create a new case/task when the business problem and required action are unchanged.
4. A materially different customer goal or booking/event creates a new case even in the same room and within 30 minutes.
5. One case may contain several genuinely distinct tasks, but each task appears once.
6. The AI, not keyword or time-window code, owns this semantic judgment. Code only validates, persists, and renders the typed result.

If the bounded existing-case lookup is unavailable, the worker may still classify the conversation, but it must use the AI-produced new semantic keys and record that no prior-case context was available. It must never fall back to 30-minute grouping.

## Durable storage and read model

`work_items_v2` remains the mutation source of truth. The reviewed payload allowlist gains these bounded fields:

- `owner_case_key`
- `owner_case_title`
- `owner_request_summary`
- `owner_problem_summary`
- `owner_next_action_summary`
- `owner_task_key`
- `owner_case_context_status`

The existing `work_key` continues to identify the task row. Reusing the exact AI `taskKey` makes the existing atomic upsert merge repeated versions of the same task. The case RPC groups by `owner_case_key`, never by elapsed time. A row without reviewed semantic metadata is isolated as its own fallback case and is not broadly merged by customer or room.

The owner-facing response is exact and content-bounded. Each case contains:

- `title`
- `requestSummary`
- `problemSummary`
- `nextActionSummary`
- timestamps, categories, progress, and safe task rows

Raw conversation bodies, phone numbers, room/source keys, stack traces, payloads, internal error names, and full diagnostic dumps remain excluded. Business words such as 누락, 미확정, 겹침, 모델 선택, 계약서 없음 are not treated as technical errors and must remain visible.

## Existing active rows

Existing active rows are reconciled once after the new contract is deployed. The reconciliation is internal metadata/state convergence only:

- classify active rows using the same semantic case/task rules;
- write exact case metadata with id/version fencing;
- merge only exact duplicate tasks;
- preserve genuinely distinct tasks as one checklist under the case;
- preserve work age, P0 acknowledgement, snooze, pending action, and audit history;
- send no Kakao/Slack message and perform no reservation, inventory, or document mutation.

The known Jeong Won-geun Apple-box rows must become one case with one deduplicated owner checklist. The later NUC/slider inquiry remains a separate case. The Yoon So-won card must retain the equipment/model-selection and unconfirmed-availability problem in owner language without exposing internal request IDs or error tokens.

## Mobile interaction

The detail sheet closes by all of the following:

- tapping a full-screen backdrop;
- tapping a visible `닫기` button;
- pressing Escape;
- swiping the sheet header downward past a fixed distance threshold.

The gesture starts only on the non-scrollable sheet header so vertical content scrolling does not accidentally close the sheet. Opening the sheet locks background scrolling and closing restores it.

## Verification

- Direct worker tests prove an existing case/task key is reused for a continuing paraphrase and a distinct inquiry gets a new key.
- Pure work-item tests prove reviewed owner metadata is bounded and duplicate task keys converge without losing lifecycle state.
- PGlite proves semantic grouping ignores time gaps, separates different case keys in the same room/time, and returns meaningful safe summaries.
- Store/API/model validators reject missing, extra, private, unsafe, malformed, and request-inconsistent fields.
- UI tests prove the three report sections and all four close paths.
- A fenced reconciliation test proves Jeong Apple-box convergence and Yoon readable output without customer-side effects.
