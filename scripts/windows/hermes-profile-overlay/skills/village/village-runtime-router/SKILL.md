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

This is the small, auto-loaded first hop for every Village business surface. It is not a revenue or sales shortcut. It covers reservations, schedules, inventory, equipment, customers, receivables, payments, settlement, tax, documents, messages, and operational incidents.

## Goal

Answer or act through one primary route. Do not rediscover the migrated system on every turn. Classify the request first, then follow exactly one branch below. Load at most one larger Village skill unless the user request genuinely crosses read and action phases.

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

For a current fact, start with the most relevant read-only live-query domain:

```bash
node 'C:/Village/my-gas-project2-worktrees/ax2-hermes-final/scripts/windows/village-live-query.js' lookup --domain inventory --query 'equipment name'
```

Domain map: inventory = equipment/stock/sets; schedule = reservations/check requests/contracts; customer = customer records; finance = transactions/payments/receivables/tax issuers; documents = contracts/check requests/issuer records. Use the user's concrete identifier, name, phone, trade ID, or document key as the query. The wrapper concurrently searches only authoritative allowlisted Village 2.0 sheets and exposes no write action. Use additional focused queries, relevant skills, or source inspection whenever the first result is incomplete or requires interpretation.

### 2. Decision support, policy, or historical context

Read the compiled Brain directly, without a skill lookup:

```bash
test -s '/c/Village/VILLAGE_Brain/Ops/brain-context-latest.md' && cat '/c/Village/VILLAGE_Brain/Ops/brain-context-latest.md'
```

Use a named artifact under `C:/Village/VILLAGE_Brain/Ops` only when the compiled context points to it. Load `village-brain-first` only for a genuinely complex protocol that the compiled context and named artifact do not cover, never as the default first step.

Prefer these canonical Brain/project routes before slower UI, filesystem-wide, browser-session, or OAuth discovery. If authoritative project evidence is incomplete, use the additional tools needed to resolve the request instead of stopping early or asking the owner to do the lookup.

### 3. New confirmation-request creation

For `확인요청 입력`, `확인 요청 등록`, or an owner-provided reservation screenshot/text, load `village-operations` so the request receives the same full AI reasoning used by screenshot quotes. Interpret the whole image/text, resolve aliases with broad catalog/master searches and context, normalize bundle counts, and ask only after evidence leaves a material ambiguity. A failed exact-string probe is not a reason to ask the owner for master spellings.

If the source gives different return dates/times for equipment groups, split them into the minimum number of requests automatically. Once the complete exact-name plan is ready, use `village-confirm-request.js` only for bounded mutation and authoritative readback; use `create-batch` for multiple groups. Do not disable normal self-improvement for speed.

### 4. Other requested internal action

If the owner explicitly requests a reservation, schedule, equipment, document, payment, settlement, tax, or other internal system change, load `village-operations` only, perform the narrow requested action, and verify authoritative live readback. A factual question is not permission to write. A customer-facing send requires its own explicit approval.

#### Screenshot/text quote requests

Treat owner messages such as `이거 견적서 보내 주자` with an attached customer conversation as a **document action**, not as a generic image-summary request and not as a confirmation-request creation unless the owner separately asks to create an RQ.

1. Load `village-operations` immediately; do not answer from the screenshot alone.
2. Extract customer, rental periods, equipment/quantities, and document needs. Resolve missing identifiers through the operations workflow and ask only for genuinely unknowable data.
3. Build from the official Village document source, apply per-item rental/discount rules, and verify the document.
4. Show a concise preview with customer, periods, outward-facing items, totals/discounts, and delivery target. Keep internal components private; combine related trades into one PDF when appropriate.
5. Customer delivery follows the applicable approval gate and requires exact recipient/readback verification.

See `references/screenshot-quote-handoff.md` for the compact checklist.

### 5. RPA health or recovery

Only for Kakao watcher, DOM bridge, Chrome/CDP, worker, or automation health/recovery, use the profile-scoped `rpa-automation-operations` route. Do not load RPA or Computer Use for ordinary Village facts or decisions.

### 6. Unrelated or non-Village request

Do not load Village Brain or operations skills. Use the smallest normal Hermes route for that request.

## Stop conditions

- Once evidence is sufficient, answer; avoid redundant discovery while continuing any reasoning or lookup needed for a correct result.
- If the canonical path is missing, report that exact missing path. Do not guess alternate home folders.
- If the source is stale, state its timestamp and the exact narrow live route needed.
- Keep the final response concise and lead with the result.
- Never start background workers, cross-channel delivery, or customer sends as a side effect of answering a question.
