---
name: village-runtime-router
description: "Compact first-hop router for all Village business questions and requested operations on Windows; selects one authoritative route without rediscovering tools or credentials."
version: 1.1.0
author: Village
license: private
platforms: [windows]
metadata:
  hermes:
    tags: [village, routing, windows, performance]
---

# Village Runtime Router

This small first hop covers every Village business surface: reservations, schedules, inventory, customers, receivables, finance, tax, documents, messages, and incidents.

## Goal

Answer or act through one primary route. Do not rediscover the migrated system on every turn. Classify the request first, then follow exactly one branch below. Direct Village reads and actions use the AI-planned `village_operation` capability interface. Load at most one larger Village skill unless a missing capability enters the explicit self-improvement lane.

Routing is a navigation optimization, not a reduction in intelligence. Never trade away AI reasoning, contextual judgment, tool access needed for evidence, or normal self-improvement merely to reduce latency.

## Canonical Windows anchors

- Compiled Brain: `C:/Village/VILLAGE_Brain/Ops/brain-context-latest.md`
- Brain outputs: `C:/Village/VILLAGE_Brain/Ops`
- Authoritative project: `C:/Village/my-gas-project2-worktrees/ax2-hermes-final`
- Brain compiler and business jobs: `C:/Village/village-ai`
- Historical Mac mirror: `C:/Village/MacMiniMirror/restored` — evidence only, never the live execution root

Hermes terminal commands run in Git Bash. Use `/c/Village/...` only with shell builtins/MSYS commands such as `test` and `cat`. Native Windows executables such as `node.exe`, `python.exe`, `powershell.exe`, and this installation's `rg.exe` must receive `C:/Village/...` paths.

## Route once

### 1. Read-only business fact (current)

For a current fact, keep normal AI interpretation and call the matching read-only `village_operation` capability. Use `phase=catalog` only when its capability ID is genuinely unknown. `$HERMES_HOME/scripts/village/village-live-query.js` remains a development fallback.

Domain map: inventory = equipment/stock/sets; schedule = reservations/check requests/contracts; customer = customer records; finance = transactions/payments/receivables/tax issuers; documents = contracts/check requests/issuer records. Use the user's concrete identifier, name, phone, trade ID, or document key as the query. If evidence is incomplete, make another focused capability call. Source inspection belongs only to a reported capability gap, not an ordinary lookup.

### 2. Decision support, policy, or historical context

Read the compiled Brain directly, without a skill lookup:

```bash
test -s '/c/Village/VILLAGE_Brain/Ops/brain-context-latest.md' && cat '/c/Village/VILLAGE_Brain/Ops/brain-context-latest.md'
```

Use a named artifact under `C:/Village/VILLAGE_Brain/Ops` only when the compiled context points to it. Load `village-brain-first` only for a genuinely complex protocol that the compiled context and named artifact do not cover, never as the default first step.

Prefer these canonical Brain/project routes before slower UI, filesystem-wide, browser-session, or OAuth discovery. If authoritative project evidence is incomplete, use the additional tools needed to resolve the request instead of stopping early or asking the owner to do the lookup.

### 3. New confirmation-request creation

For `확인요청 입력`, `확인 요청 등록`, or an owner-provided reservation screenshot/text, load compact `village-operations` so the request receives the same full AI reasoning used by screenshot quotes. Interpret the whole image/text, resolve aliases with broad catalog/master searches and context, normalize bundle counts, and ask only after evidence leaves a material ambiguity. A failed exact-string probe is not a reason to ask the owner for master spellings.

If the source gives different return dates/times for equipment groups, split them into the minimum number of requests automatically. Once the complete exact-name plan is ready, use `village_operation` with `confirmation_request.create` or `confirmation_request.create_batch`. Do not disable normal self-improvement for speed.

### 4. Registered-trade date change

For an explicit owner request to move an already-registered schedule, keep normal AI interpretation: identify the customer, old date, intended new interval, and whether the owner explicitly accepts availability warnings. Omit `startTime` and `endTime` to preserve the registered times. Then call `village_operation` with capability `schedule.change_dates`.

The runner resolves one trade, changes contract/schedule/ledger under a lock, regenerates the contract, and requires readback. It never sends a customer message. If it reports `CONFLICT`, relay the structured evidence and stop. Use `allowConflicts:true` only after explicit owner acceptance. Do not load a larger skill, inspect source, construct raw GAS, or open a browser. If the target is ambiguous, ask only for the missing identifier and stop; do not find another write path.

### 5. Other requested internal action

If the owner explicitly requests a reservation, schedule, equipment, document, payment, settlement, tax, or other internal system change, load compact `village-operations`, let AI form the complete plan, and use `village_operation`. A factual question is not permission to write. A customer-facing send requires its own explicit approval.

If the broker returns `CAPABILITY_GAP`, this is not permission to quit. Enter the skill's development discovery lane, implement and test the reusable route without raw live mutation, register it, then resume and complete the original request. This preserves Hermes self-improvement while preventing unbounded live trial-and-error.

#### Screenshot/text quote requests

Treat owner messages such as `이거 견적서 보내 주자` with an attached customer conversation as a **document action**, not as a generic image-summary request and not as a confirmation-request creation unless the owner separately asks to create an RQ.

1. Load `village-operations` immediately; do not answer from the screenshot alone.
2. Extract customer, rental periods, equipment/quantities, and document needs. Resolve missing identifiers through the operations workflow and ask only for genuinely unknowable data.
3. Build from the official Village document source, apply per-item rental/discount rules, and verify the document.
4. Show a concise preview with customer, periods, outward-facing items, totals/discounts, and delivery target. Keep internal components private; combine related trades into one PDF when appropriate.
5. Customer delivery follows the applicable approval gate and requires exact recipient/readback verification.

See `references/screenshot-quote-handoff.md` for the compact checklist.

### 6. RPA health or recovery

Only for Kakao watcher, DOM bridge, Chrome/CDP, worker, or automation health/recovery, use the profile-scoped `rpa-automation-operations` route. Do not load RPA or Computer Use for ordinary Village facts or decisions.

### 7. Unrelated or non-Village request

Do not load Village Brain or operations skills. Use the smallest normal Hermes route for that request.

## Stop conditions

- Once evidence is sufficient, answer; avoid redundant discovery while continuing any reasoning or lookup needed for a correct result.
- If the canonical path is missing, report that exact missing path. Do not guess alternate home folders.
- If the source is stale, state its timestamp and the exact narrow live route needed.
- Keep the final response concise and lead with the result.
- Never start background workers, cross-channel delivery, or customer sends as a side effect of answering a question.
