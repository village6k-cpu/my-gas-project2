---
name: village-operations
description: "Primary Village action route for requested business operations: reservations, schedules, equipment changes, documents, payments, settlement, tax, Slack/Kakao, Google Sheets, and project APIs; always verify live readback."
version: 1.0.0
author: Hermes Agent
license: MIT
platforms: [windows]
metadata:
  hermes:
    tags: [village, reservations, payments, camera-rental, google-sheets, slack, kakao, operations]
    created_by: agent
---

> **HISTORICAL ARCHIVE — DO NOT USE FOR CURRENT OPERATIONS.** This file is
> retained only as audit and recovery evidence. The current owner-confirmed rental-day
> rule is +3 hours: `ceil((hours - 3) / 24)` (minimum 1). Any +6-hour formula
> below is obsolete historical text and must never drive a calculation.

<!-- WINDOWS_EXECUTION_ADAPTER -->
## Windows execution adapter

This package is the complete Mac `village-operations` playbook with all references preserved. Keep the original business rules, approval gates, identifiers, and readback requirements. Translate only paths and host-specific commands.

### Windows path map

- Authoritative Windows execution tree: `C:\Village\my-gas-project2-worktrees\ax2-hermes-final`
- `/Users/village6k/my-gas-project2` source mirror → `C:\Village\my-gas-project2` (reference only; do not execute stale routes from it)
- `/Users/village6k/my-gas-project` → `C:\Village\my-gas-project`
- `/Users/village6k/village-ai` → `C:\Village\village-ai`
- `/Users/village6k/village-kakao-ai` → `C:\Village\village-kakao-ai`
- `/Users/village6k/VILLAGE_Brain` and `~/VILLAGE_Brain` → `C:\Village\VILLAGE_Brain`
- `~/.hermes` → `C:\Users\ssper\AppData\Local\hermes`
- Windows Kakao runtime → `C:\Village\my-gas-project2-worktrees\ax2-hermes-final`

The local `terminal` tool runs **Git Bash**. Use `/c/Village/...` for shell
builtins and MSYS tools such as `cd`, `find`, `test`, and `cat`. MSYS argument
conversion is disabled in Hermes. Native Windows executables must receive `C:/Village/...`,
never `/c/Village/...`; this includes `node.exe`,
`python.exe`, `powershell.exe`, `cmd.exe`, and this installation's `rg.exe`.
For a PowerShell-only runner or cmdlet, invoke it explicitly with
`powershell.exe -NoProfile -Command ...`;
never paste a bare `Get-Content` or `Get-ChildItem` command into `terminal`.
Do not use `search_files` for absolute `C:\Village` paths. AppleScript,
`launchctl`, macOS UI permissions, Messages, and watch-relay execution remain
on the Mac relay; their business context is still valid.

Use the root environment pointers `VILLAGE_DASHBOARD_ENV`,
`VILLAGE_TAX_ENV`, `HERMES_ENV`, and `VILLAGE_NAME_LINK_QUEUE`; do not infer
their locations from the Windows user home. A bare `python3` command is not a
valid Windows runner here—use `python.exe` or the preserved Node runners.

### Authorization and execution contract

- A question about current business state authorizes the narrow read-only project lookup needed to answer it.
- An explicit owner request to change an internal reservation, schedule, confirmation request, payment record, or ledger field authorizes only that exact narrow business action. Resolve the record, dry-run when the action supports it, execute once, and verify with the original playbook's mandatory readback. Preserve unrelated rows.
- Internal write approval does not approve a customer-facing send. Kakao, Alimtalk, invoice delivery, document delivery, proactive Slack delivery, and other external sends require separate exact approval.
- `AI_WORKER_LIVE=0`, `AI_WORKER_AUTO_SEND=0`, and `VILLAGE_WINDOWS_WRITES_ENABLED=0` govern background Kakao worker/automatic processing. They must not be interpreted as a global prohibition on a current owner-authorized interactive operation.
- A normal response in the current user-authorized Slack conversation is allowed. Proactive or cross-channel Slack delivery remains approval-gated.
- **Sequencing (2026-08-11 owner directive, Mac-era canonical order): never open a turn with a confirmation question.** Do all resolvable work first; a confirmation, when the gate requires one, is delivered WITH the finished work product (preview attached, totals shown, "고객 발송은 아직 안 했음"). An explicit send word in the owner's request (`보내`, `발송해`, `승인`) IS the approval — execute and report, do not re-ask. Ask mid-turn only for genuine blockers (ambiguous duplicate trades, missing contact), and only after exhausting resolution work.

### Infrastructure incident guard (2026-08-11 견적서 50분 장애 학습)

- If a required local automation backend is down mid-task — kakao-dom-bridge `http://127.0.0.1:8787/health` unreachable, CDP port 9223 closed, or a runner replies `fetch failed` — do **not** repair, restart, or replace that infrastructure inside the business turn. Post one Slack status line stating exactly which backend is down and which sub-steps already completed, then stop that path and wait. `Village-Kakao-Production-Watchdog` (5-minute cycle) and the owner own infrastructure healing; an agent-spawned bridge/chrome fails the watchdog's process-ownership validation and wedges self-healing for the whole production stack.
- `computer_use`(CUA) is removed from this deployment (2026-08-11 owner decision via `agent.disabled_toolsets` — the grok-era system ran all business flows without it, and CUA capture loops were the root of the 700K-token session poisoning). All watch-Chrome interaction goes through DevTools/CDP or the bridge API. After acting in the watch Chrome via CDP, leave the chat-list view as you found it — the DOM watcher's detection depends on it. If a CDP/bridge route is unavailable, that is an infrastructure incident — report and stop, per the rule above; there is no screen-control fallback.
- If a turn exceeds ~5 minutes of wall time, post a one-line interim status to the thread (done / remaining / blocked-on). Never leave the owner without any output for tens of minutes.
- After a 스탑/중단/보내지마 instruction, customer-facing send APIs must not be invoked again in that turn, even to "finish" an already-planned step. Report what already executed and halt.

### Intelligence-preserving confirmation requests

A confirmation request from owner-provided text or an image uses the **same reasoning quality** as a screenshot quote. Speed optimizations may shorten path discovery and execution, but must not replace AI interpretation, contextual judgment, or normal self-improvement.

- Read the whole request before choosing the write shape. If equipment groups have different return dates or times, split them into the minimum number of confirmation requests automatically. Do not ask whether to split when the source already makes the grouping clear.
- At the start of one owner request or batch, run exactly one raw inventory snapshot: `node 'C:/Village/my-gas-project2-worktrees/ax2-hermes-final/scripts/windows/village-live-query.js' catalog --sheet all`. It starts `장비마스터` and `세트마스터` reads together. Reason over both returned catalogs in one AI pass; after a complete snapshot, do not run `village-confirm-request resolve`, repeated per-alias searches, or source-code archaeology.
- Resolve customer wording from that snapshot, relevant preserved references, equipment knowledge, and visible context. Normalize an obvious unique match. Ask only when the wording could mean materially different models and the source does not distinguish them.
- If concrete customer/owner wording has no master match, preserve that exact wording as an `장비` row and list the same exact string in the runner envelope's `unregisteredOriginals`. This is an explicit bounded exception, not a guess. Never drop it or demote it to `비고`/`추가요청`; the availability/readback may report `미등록 장비`, which must be surfaced to the owner.
- Verified examples from the successful quote path include `24-70 GM2` → `소니 GM 24-70mm II`, `70-200 GM2` → `소니 GM 70-200mm II`, `HBM 1/4 사각` → `Hollywood Blackmagic 1/4 사각`, `메가F22s4` → `OSEE MEGA22S4`, `RS3 Pro` → `로닌 RS3 프로`, and `파보튜브 II 30X 2KIT` → `파보튜브 II 30X` quantity 2.
- After AI has built the complete plan, use `scripts/windows/village-confirm-request.js` only as the bounded mutation/readback layer. For an unmatched original use `{"request":{...},"unregisteredOriginals":["20-70"]}`; otherwise the existing exact catalog preflight remains mandatory. Use `create-batch` for automatically split schedules so every group is validated before the first write.
- Before creating, do one authoritative lookup for the same customer/phone and interval. If one unregistered existing partial `RQ-...` is found, pass its ID plus the complete AI-planned payload to the runner's `update` command. The runner performs one `updateRequest` and full readback. Do not fall back to ad-hoc Python, raw GAS calls, source-code archaeology, or another insert. Use the runner's `--help` output instead of reading its source to discover commands.
- A successful new alias or workflow lesson may be retained through Hermes's normal self-improvement path after the user-facing operation. Do not disable learning to save latency.

For current-month aggregate revenue, use the existing read-only project wrapper rather than browser/OAuth fallback:

```bash
node 'C:/Village/my-gas-project2-worktrees/ax2-hermes-final/scripts/windows/village-live-read.js'
```

For every other intent, select the relevant preserved reference, then use the named GAS/API/Supabase action and verification route documented there. Generic Google Workspace OAuth and Computer Use are not prerequisites while a project route exists.

# Village Operations

## Newly learned / high-risk references

- `references/tax-invoice-info-lookup.md` — when staff asks “계산서 발행 정보가 어떻게 되지?”, treat it as lookup-only: search prior `거래내역` G/H + `발행처DB`, report 상호/사업자번호/대표자/email, and do not issue/mutate.
- `references/bulk-tax-invoice-from-kakao-followup.md` — when staff says a customer sent paid-item screenshots + business-registration info and asks to issue invoices for all of them: mine the Slack/`ai_follow_up_items` evidence for email/business facts, resolve exact paid `거래ID`s, issue each via direct route, verify ledger + NTS, and close duplicate follow-up rows.
- `references/kakao-quote-pdf-send-pitfalls.md
- `references/quote-manual-send-alimtalk-workflow.md` — official GAS `sendEstimateManual`/Popbill Alimtalk path for approved manual 견적서 sends, including customer phone lookup and gviz verification pitfalls.` — Kakao quote/PDF sending pitfalls: send/upload file before explanatory text, verify actual attachment or sent file bubble, avoid typing into chat-list search instead of the conversation input, and validate Drive PDF fallback links return a real `%PDF` response.
- `references/corrected-manual-quote-resend-fallback.md` — when a corrected manual quote Kakao attachment send is disputed/not visible, acknowledge the overclaim, regenerate/patch the official sheet, send via GAS/Popbill Alimtalk, verify CSV and Drive `%PDF`, then remove any temporary route.
- `references/approved-manual-quote-send-verification.md` — when a no-send manual quote preview is later approved, send once with the real phone, treat `DUPLICATE_BLOCKED` after a redirect failure as a safety signal that the first POST likely executed, verify the fresh approval-time `fileId`/CSV/PDF, and remember Slack `MEDIA:` preview/report attachments are not customer delivery.
- `references/registered-quote-stable-link-cost-control.md` — registered quote sends should default to one stable live quote link per trade/discount policy; later edits reuse the already-sent link and skip Popbill unless direct PDF delivery is explicitly forced.
- `references/batch-registered-quotes-ad-hoc-loyal-discount.md` — When staff says vague `이거 처리해줘` with an attached Kakao/customer screenshot, inspect the image first; handle mixed registered + pending-RQ quote batches as approval-gated no-send previews.
- `references/batch-registered-quotes-ad-hoc-loyal-discount.md` — When staff says vague `이거 처리해줘` with an attached Kakao/customer screenshot, inspect the image first; handle mixed registered + pending-RQ quote batches as approval-gated no-send previews.
- `references/registered-quote-personal-business-loyal-discount.md` — registered quote resend with `개인사업자 + 단골` discount: resolve by phone despite name drift, use official `previewQuote&discountType=단골`, verify CSV/PDF, and keep customer-send approval-gated.
- `references/equipment-investment-prioritization.md` — Gear purchase/replacement decisions: use live schedule + inventory data, compute bottlenecks/annualized utilization, account for consignment supply and product-cycle risk, and separate disputed used-market pressure from actual business priority.
- `references/equipment-disposal-candidate-analysis.md` — Disposal/sell-candidate analysis: use Brain `disposal_candidates` only as a shortlist, then verify exact live `장비마스터`/`스케줄상세` usage; distinguish true 1년+ 미회전 from name drift, active component rows, and cleanup/reclassification candidates.
- `references/kakao-preview-only-reservation-drop-guard.md` — Kakao DOM/AI worker completed-but-preview-only reservation drops: search by name/all phone variants, 보류 stale generic RQs, rebuild verified confirmation requests, and add a completed-worker escalation guard so actionable previews cannot disappear without a human-review card.
- `references/kakao-bulk-missed-reservation-recovery.md` — bulk incident recovery when many unknown Kakao reservations surface: scan `jobs.ndjson`/`worker-results.ndjson`/`worker-skipped.ndjson`, dedupe actionable reservation previews, verify against `확인요청`/`계약마스터`, insert only safe complete requests, fix existing generic RQs, and report unresolved holds to `스케쥴-agent`.
- `references/two-week-kakao-schedule-recovery.md` — urgent 1–2 week missed-schedule recovery: scan worker/follow-up logs plus live sheets, register only safe pending RQs, mark RQs already reflected in existing trades, add missing top-level items to existing trades with `scheduleAddEquips`, and verify via dashboard/ledger.
- `references/confirmation-request-concurrent-write-reconciliation.md` — post-write reconciliation for concurrent Kakao-worker/RQ writes: read complete RQ groups, calculate set-component deltas rather than double-count totals, clean partial/duplicate RQs by verified ID, and distinguish a master-alias warning from a successful full availability check.
- `references/kakao-confirm-request-filter-softbox-generic-pitfalls.md` — Kakao 확인요청 equipment pitfalls: H&Y REVORING/VND-CPL mapping, Black Pro-Mist 사각 rows, bare `젬볼` ambiguity, 600X `소프트박스` model-selection warnings, and verifying stale pending RQ replacement.
- `references/homepage-new-equipment-setmaster-registration.md` — when a homepage product exists but reservation/RQ matching misses it, add the set to `세트마스터`, add exact stock rows to `장비마스터`, rebuild stale RQs, restore dropped discount type, then verify/register by readback.
- `references/vmount-loss-restitution-lookup.md` — V마운트/브이마운트 배터리 분실·미반납·변상 customer lookup: search Kakao Brain first with spelling/action variants, distinguish 미반납 evidence from 변상/입금 completion, and avoid false positives such as later-resolved 박정병.
- `references/historical-kakao-inventory-discrepancy-audit.md` — when owner memory conflicts with stock records, mine 5-year Kakao raw threads with alias/count/action variants, classify count/location/loss/purchase clues, then compare against `equipment_ledger` + `equipment_events` lineage before reporting likely cause.
- `references/manual-quote-osee-loyal-longterm-preview.md` — manual/no-send quote preview for OSEE monitor with 단골 + 장기 할인: use `sendEstimateManual` blank-phone `ERROR`+`fileId` as preview artifact, verify PDF/CSV, and keep customer-send approval-gated.
- `references/pending-rq-kakao-manual-quote-schedule-correction.md` — pending `확인요청` + Kakao customer equipment changes: adjust the manual quote payload from top-level RQ rows, use official `sendEstimateManual` blank-phone no-send preview, export only `gid=0`, verify PDF totals, and keep customer-send approval-gated.

## Recent operational pitfall: apparent duplicate Kakao sends

When a customer screenshot shows multiple identical yellow Kakao 관리자센터 placeholders (`알림톡/친구톡 메시지는 관리자센터에서 확인할 수 없습니다.`), do **not** assume the same document was sent repeatedly. Kakao 관리자센터 hides the actual 알림톡/친구톡 contents, so reservation confirmation, checkout guide, return guide, quote, and proof messages can all look identical in the UI. Audit Popbill Kakao history by phone/name/date and distinguish the templates before explaining. See `references/popbill-kakao-send-audit.md`.

Use this umbrella skill for Village camera-rental operations whenever the user asks about:

- `확인요청 입력`, `예약 확인`, `가용확인`, `예약 등록`, or Kakao/staff reservation blocks
- adding equipment to an existing registered reservation
- 견적서/거래명세서/계약서 링크/증빙 document-send requests from Slack/Hermes
- 결제, 정산, 입금 확인, 미수금, 반출 결제, 반납 정산, or payment-channel automation
- Slack staff FAQ/RAG automation around Village operating knowledge

Default stance: **staff text can be natural language; Hermes should resolve the Village project, API, sheets, and trade/request IDs without making staff remember internal IDs.** Final replies to this user should be blunt, operational, and usually in Korean.

## Default systems and boundaries

- Operational project: `C:\Village\my-gas-project2-worktrees\ax2-hermes-final` unless the user explicitly says otherwise.
- Read `AGENTS.md` and/or `AGENT_GUIDE.md` in that project when exact API details are needed.
- Prefer existing API/GAS paths over browser/UI work.
- Use Google Workspace/Sheets access when needed for the real Village 2.0 / 개고생2.0 ledger, but first look for existing project links, CSV exports, and GAS/AppSheet/API routes.
- Do **not** send 알림톡, customer messages, live document sends, payment updates, or other customer-facing/financial side effects unless the user explicitly asks for that exact action.

## Core identifiers and data sources

- `확인요청` IDs identify reservation-confirmation request rows.
- Existing registered reservations are identified by `거래ID`. When the user asks to delete/cancel an existing registered reservation before re-entering confirmation requests, resolve the single matching trade first (e.g. `tradeCandidates`/`dashboardSearch`), then use the existing contract-status route such as `updateContractStatus&tid={거래ID}&status=취소` rather than only deleting pending `확인요청` rows. Verify both `계약마스터` status=`취소` and `스케줄상세` no longer has rows for that `거래ID` before inserting replacement requests.
- When the user asks to “기존 확인 요청 전부 지우고 새로 입력” for a Kakao/customer thread, first delete all existing matching confirmation-request rows for that customer/reservation via the project’s existing API/admin path (for example `deleteRequest` where available), then insert the newly parsed complete set. Do **not** append duplicates on top of stale rows.
- Before inserting or registering a confirmation request, duplicate checks must compare the same real customer by **phone as well as name**. Resolve a unique `고객DB` phone before duplicate detection; then check both existing `확인요청` and already-registered `계약마스터`/`스케줄상세` by that phone. Kakao nickname vs 예약자명 aliases must not create duplicate RQs/registrations; if the name matches but explicit phones differ, treat it as possible 동명이인 and do not auto-collapse.
- `거래ID` is the join key after registration:
  - `계약마스터` A열 = 거래ID
  - `스케줄상세` B열 = 거래ID
  - Village 2.0 / 개고생2.0 `거래내역` E열 = 거래ID
- `세트마스터` is the source of truth for equipment/set matching in reservation entry and additions. Do **not** use `목록` as the final matching source.
- Village 2.0 / 개고생2.0 `거래내역` is the payment/settlement source of truth unless inspection proves otherwise.

## Reservation confirmation requests

Use when the user says `확인요청 입력`, `예약 확인 넣어줘`, `가용확인`, or provides a Kakao/staff reservation block.

### Bulk Kakao/name triage before confirmation-request entry

When the user gives multiple customer names and says to check them then enter `확인요청` only if needed, **the required workflow is to open each actual Kakao customer room in `🤖 자동화 크롬` and read the visible conversation context**. Top-row previews, first messages in `events.ndjson`, worker summaries, and short snippets are only navigation/discovery aids; they are not enough to decide, skip, or mutate. Cross-check, in order: unresolved operation tasks, `worker-results.ndjson` decisions, `events.ndjson` latest previews/unread state, actual Kakao room body in automation Chrome, and `계약마스터`/`스케줄상세`/`확인요청` by customer/phone/trade. If a matching registered trade already exists, report the `거래ID` and skip insertion. If only short previews such as `네`, `감사합니다`, or `네~!` are visible and the full Kakao conversation cannot be opened/read, explicitly report `본문 미확인 → 임의 입력 보류` rather than guessing a reservation. Do not tell the user “확인했음” unless the actual room body or sheet rows were verified. See `references/bulk-kakao-confirmation-triage.md` and `references/bulk-kakao-room-context-confirmation.md`.

1. Parse the request block:
   - 예약자명, 연락처
   - 반출일/반출시간, 반납일/반납시간
   - equipment name + quantity
   - notes such as `반출X`, additions, discounts, exclusions, or staff context
   - If the Kakao conversation shows image cards / `저장하기` attachments instead of visible text, inspect/download the attached images and OCR/read them before declaring `장비명 확인 필요`. In Kakao Channel Manager automation Chrome, DevTools can fetch `a.btn_save` image links with page credentials; save them locally and use vision/OCR for the equipment list.
2. Normalize date/time to API-friendly forms (`YYYY-MM-DD`, `HH:MM`) using current-year context when obvious.
   - Treat Kakao visible date separators/message timestamps as first-class context for relative words like `오늘`, `내일`, `모레`; never pass these strings through to the API.
   - Convert same-day `24시` / `24:00` returns to next-day `00:00` before calling `insertAndCheckRequest` (e.g. `6월 6일 10시부터 6월 6일 24시까지` → `반출일 2026-06-06 10:00`, `반납일 2026-06-07 00:00`).
   - If the computed same-day return time is earlier than pickup time, treat it as an overnight return unless the conversation clearly says otherwise.
   - If relative-date context is genuinely unavailable, do not force an API write; create a human-review follow-up instead.
3. Use the single `catalog --sheet all` snapshot described above. Match clear items to master names; preserve a concrete unmatched customer string in the equipment row with the exact `unregisteredOriginals` allowlist. Do **not** record AI assumptions, duplicate-check reasoning, or “가용확인 후 안내 필요” in `비고(Q)`/`추가요청(R)`; those fields can flow into contracts/documents. Keep internal reasoning in evidence/follow-up records only.
4. Insert and run availability in one call, typically `action=run&func=insertAndCheckRequest&args=...`.
5. Verify by reading back `확인요청` by the new request ID.
6. If `insertAndCheckRequest` fails after creating a new `RQ-...` row group (for example a Google Sheets data-validation error such as `셀 F... 데이터 확인 규칙 위반`), do **not** leave the partial rows in place. Search/read back the newly-created request IDs, delete each partial group with `deleteRequest`, run `refreshEquipmentList`, then retry the insert. Treat the durable lesson as: cleanup partial writes + refresh validation list + retry, not “the API is broken”.
7. Report in Korean with request ID, customer/date, entered top-level items, important availability warnings, and unresolved model/equipment issues.

### Model-selection and confirmation-request memo guards

Use whenever `확인요청` blocks on `모델 선택 필요` or when Q/R text could reach contracts.

- A `모델 선택 필요` warning is not actionable unless it names the exact blocker: row number, parent set when available, current F value, and candidate concrete models from `장비마스터` category rows. Put the same detail in I/J/O and the F-cell note/background, not just a generic message.
- If staff changes F열 from a generic category to a concrete model, registration preflight must rerun availability for stale `모델 선택 필요` rows. Do not skip merely because I/J already contains old text.
- Treat `비고(Q)` and `추가요청(R)` as customer/document-adjacent fields, not worker scratchpads. Never put Kakao originals, AI reasoning, duplicate-check notes, normalization explanations, or “가용확인 후 안내 필요” there.
- Contract generation should sanitize R again before appending it as line items; allow only explicit short item lines, not internal review/memo text.
- See `references/confirmation-request-model-memo-guards.md` for implementation and verification patterns.

### Direct schedule registration from Kakao/staff text

Use when staff already answered the customer that the requested time is possible or the user says `일정 등록해줘` / `예약 등록해줘`.

1. If a matching pending `확인요청` already exists for the named customer/nickname, use that existing `RQ-...` instead of creating a duplicate. Search `확인요청` by name/nickname and, if needed, phone/customer DB aliases; then read the whole request group by 요청ID.
2. If there is no suitable pending request, create the confirmation request and run availability first.
3. Before registration, rerun `action=확인&reqID=...` to refresh normalized customer/phone and stale availability results, then duplicate-check registered schedules by phone/name where possible.
4. If the screenshot/user message lacks a phone but the customer/team name is an exact known repeat customer, resolve a usable phone from prior verified `계약마스터`/schedule history before insertion. Do **not** use a Kakao nickname alone; only use the historical phone when the exact customer identity is clear and report that basis if relevant.
5. If available, call registration (`action=등록&reqID=...`; or `action=registerAsync&reqID=...` when the synchronous route is not exposed). Do not send 알림톡 unless explicitly asked. `run&func=scheduleRegister` may be blocked by the API allowlist even though the top-level `registerAsync` action works. `미등록 장비` warnings on expanded component rows do not necessarily block registration; blocking preflight is mainly date/model-selection issues. If registration succeeds despite 미등록 rows, verify the resulting `스케줄상세` and report the zero-price/manual-stock follow-up clearly.
6. Verify with both `확인요청` search and registered schedule lookup by the resulting `거래ID`. Also verify `계약마스터` and, for ledger/payment continuity, `거래내역` when accessible. If an async registration gets stuck at `등록대기`/`⏳ 등록 처리 중`, run `recoverPendingRegistrations`, then re-read `계약마스터`/`스케줄상세`; if the trade exists but `확인요청` is left as `중복: 동일 건이 이미 등록됨`, update N/O/P to `등록`/`등록완료`/거래ID so the request group no longer looks unresolved.
7. If a JSON POST returns a Google Drive HTML “file cannot be opened” page, retry the same `run` call as GET with URL-encoded args; the endpoint has accepted long encoded args for this workflow.
6. Verify with both `확인요청` search and registered schedule lookup by the resulting `거래ID`.
7. If a JSON POST returns a Google Drive HTML “file cannot be opened” page, retry the same `run` call as GET with URL-encoded args; the endpoint has accepted long encoded args for this workflow.
8. For BURANO/부라노 direct registrations, match to `소니 BURANO 베이직세트` / `소니 BURANO 풀세트` in `세트마스터`. If expansion blocks on generic `7인치 모니터` or `매트박스`, force concrete accepted models (`스몰HD INDIE7`, `틸타 MB-T16(미라지)`), clear those rows' I/J result cells, rerun `확인`, then register. Some BURANO bundled component rows may still show `미등록 장비`; distinguish those from blocking `모델 선택 필요` rows and verify after registration. See `references/burano-direct-registration-pitfalls.md`.
9. If return time is missing but registration requires one, use the shop’s same-day placeholder only when necessary, and explicitly note it in `비고` and the final report.
10. If a later add-on/duplicate RQ says `기존 예약에 추가` but `tradeCandidates`/`dashboardSearch` finds no registered trade for that customer/date, do **not** register the add-on RQ by itself; that creates a one-item reservation. Locate the earlier main pending RQ or Slack card, rebuild/update the main RQ with the original top-level items plus the add-on, fix any model-selection rows, register the combined request, then delete or otherwise clear the add-on-only duplicate RQ after verification.

#### Cloning an existing reservation into a new schedule

Use when the user says a customer should get “the same equipment as” an existing period/trade.

1. First decide what “same” means from the owner's words. `완전히 똑같이`, `구성품까지`, `원본 그대로`, or an equivalent phrase means an **exact registered-row snapshot clone**. “같은 세트/상위 장비로 하되 현재 구성 사용” or explicit exclusions/edits means a header-level rebuild under today's masters.
2. For an exact snapshot clone, resolve one source `거래ID`, then use only `scripts/windows/village-schedule-clone.js`:
   - run `preview --input-file <json>` with `sourceTradeId`, `targetStart`, and `targetEnd`;
   - review the returned source trade, exact row count, conflicts/duplicate state, and `sourceFingerprint`;
   - when the owner already requested the internal registration, run `execute` in the same turn with the unchanged inputs plus `expectedSourceFingerprint`. Do not ask again. The route creates no `확인요청` and suppresses customer send.
3. Accept success only when authoritative readback reports equal source/target row counts, contract + schedule + ledger present, and `customerSendSuppressed=true`. This preserves the source's actual six rows even if today's `세트마스터` would expand eleven.
4. Never use header copying + `insertAndCheckRequest` for an exact snapshot request; that rebuilds components from today's master and is not “완전히 똑같이.”
5. Use the older header-level confirmation-request route only for a deliberate current-master rebuild, exclusions, or edits. In that branch, copy `isHeader === true` rows, apply the requested changes, register, and verify the resulting rows and exclusions.

See `references/clone-existing-reservation-registration.md` for the full runbook and final-report checklist.

## Today dashboard checkout/checkin checklist semantics

Use when modifying or troubleshooting the Village today dashboard (`dashboard.html` / `checkAvailability.js`) checkout/checkin checklists.

- Treat checkout item checks as **actual carried-out equipment**, not merely staff acknowledgement.
- Therefore, after checkout/setup is marked done, any equipment row that remains unchecked at checkout should default to checked on the checkin/return view: it was not taken out, so it is not a return target.
- Still preserve explicit staff override on the return view: if staff manually unchecks a return item, store a negative state such as `itemCheck_<scheduleId>_checkin = '0'` so the default rule does not re-check it on refresh.
- Apply this rule consistently in both `getDashboardData` and `buildDashboardSearchItem_`/global-search detail rendering, otherwise today view and search view will disagree.
- Add/keep static regression tests around this rule when editing dashboard checklist logic.

## Existing reservation equipment additions / date corrections / item removals

Use when the user asks to add items to a specific already-registered reservation, move/change an existing registered reservation date, or remove/exclude an item from an existing registered reservation. For combined date-change + removal jobs, follow `references/registered-trade-date-change-remove-item.md`.

1. Resolve the transaction with `tradeCandidates&name={예약자명}&date=YYYY-MM-DD`, then confirm with `dashboardSearch` or `스케줄상세` by 거래ID.
   - If the user names an exact 거래ID, including Slack auto-link text like `<tel:260624-006|260624-006>`, that ID wins. Do **not** override it with date/status inference or another same-customer trade.
   - If the user says `지난 건` / `이미 반출` / `결제까지 됨` and multiple same-customer trades exist **without** an exact ID, do **not** assume the newest trade. Compare status/date and the full equipment list first; pick the trade whose existing rows match the context (e.g. other already-carried items). If still ambiguous, stop before mutation.
2. Match each requested item against `세트마스터` column A. Use `목록` only as fallback discovery, never as final write spelling.
3. Read existing `스케줄상세` / `dashboardSearch` rows before adding.
   - Preserve unrelated rows. A lens correction (`라오와 빼고 16-35 추가해서 결과적으로 GM 줌렌즈 세트`) does **not** authorize dropping FX6, gimbal, accessories, or unrelated top-level rows.
   - For corrective wording like `라오와 빼고 16-35 추가해서 결과적으로 GM 줌렌즈 세트`, only change/cancel the named lens row(s), or restore the existing lens rows into the known GM zoom set representation, unless the user explicitly asks to rebuild the whole reservation.
   - If the same top-level set already exists and the staff request means “make total N,” update the existing representative/component quantities instead of adding a duplicate set.
   - If a duplicate same-set add already happened, merge it back carefully. Do **not** trust `scheduleRemoveEquip`/`dashboardRemoveEquipment` with only the duplicate header `scheduleId` when another row group has the same `세트명`: the current implementation deletes every row in that trade whose C열 equals that set key, so it can remove the intended original group too. Also, `상태=취소` alone is not enough for regenerated contracts because the legacy `generateContractFile` reads all `스케줄상세` rows by 거래ID without filtering J열. For a duplicate header-only row, either physically delete/clear that exact row so B열 no longer equals the trade ID, or rebuild the row group exactly, then regenerate the contract and verify dashboard + contract amount.
4. If you already mutated the wrong trade or dropped unrelated rows, stop making interpretive changes. Restore the user-named 거래ID to the last verified complete schedule state first, then separately undo any unintended edits to other trades. Use past session/tool output, Slack cards, official quote/contract CSVs, and dashboard snapshots as recovery evidence when the current sheet has already been damaged. See `references/schedule-correction-exact-trade-restore.md`.
   - If staff says the reservation is already checked out/paid and only needs accurate records (`이미반출 결제까지 됐는데 기록상 정확해야`, `실제로는 A 빼고 B 반출`), treat it as a schedule record correction, not a fresh add-on/payment/document workflow. Prefer updating the existing standalone `스케줄상세` row's `세트명`/`장비명`, add a concise K열 correction note, invalidate/sync via `updateStatus`, and verify `거래내역` stayed unchanged unless a financial mutation was explicitly requested. See `references/post-checkout-schedule-record-correction.md`.
4. Dry-run genuinely new additions with `addEquips&dryRun=true` before live add.
5. If dry-run fails only because a component/option says `모델 선택 필요` or similar generic model-selection warning, force-enter the generic requested item name so the schedule reflects the staff request; report that it was forced.
6. Verify with `dashboardSearch` and, for “today schedule/timeline” issues, `action=timeline&from=...&to=...&nocache=1&profile=1`.

## Equipment matching principles

- Normalize obvious aliases such as `600c` → `어퓨쳐 600C`, `포그머신` → `포그 머신`, `헤이저머신` → sheet spelling may be `헤이져 머신`, `fx3` → usually `소니 FX3 바디세트`, generic `24-70`/`2470` → `소니 GM 24-70mm II` unless the customer explicitly requests the older GM I, and `70-200 gm2` → `소니 GM 70-200mm II`.
- Do **not** auto-map `A7M5`/`A7 M5` to `소니 A7S3 바디세트`. `소니 A7M5 바디세트` may now exist in `세트마스터`, but older/stale requests can still have been mis-expanded as A7S3 by fuzzy matching. Use the exact A7M5 set name when present; if it is missing, treat it as a master-data gap to fix/approve, not as permission to register A7S3. After fixing the master rows, rebuild the affected RQ so stale A7S3 expanded rows are removed.
- Treat `RF to PL`, `RF-PL`, or staff shorthand `Rf to pl` as an adapter/mount request. First search `세트마스터`/`장비마스터`; if no exact `RF to PL` row exists and the request is simply quantity/check/register, use the closest stocked PL mount item that the sheet actually carries (currently `Nisi PL Mount` is the normal match) and report the assumption in the final note. Do not invent a non-sheet item name.
- Preserve exclusions as notes, not requested equipment. Example: `메모리 리더기 반출x` belongs in `비고`/`추가요청`; if registration expands a reader component anyway, cancel that expanded row and note why.
- For ambiguous terms, use recent customer history from `dashboardSearch` when available and record the assumption.
- Phone searches may require hyphenated form even if the user typed digits only.

### Inventory / 재고-count answers

Use when staff asks “몇 대 있어?”, “재고 몇 개?”, “대여 가능 몇 대?” for a specific item.

#### Historical stock-count disputes

When the owner disputes a current count from memory (“분명히 N대였는데 지금 기록은 M대”), do **not** start by only searching Kakao or defending the current ledger lineage. First/early check whether the old Notion rental calendar ever scheduled N units of that exact item simultaneously. A simultaneous Notion overlap at or above the disputed count is strong evidence that physical stock/operational supply was at least that high, unless explicit consignment/substitution/duplicate-entry evidence says otherwise. If the parsed `86_notion_schedule.jsonl` export is missing under `C:\Village\VILLAGE_Brain`, treat it as a data gap: re-export the jsonl to Brain or run that specific check via the Mac relay (no local Notion cache exists on Windows; use python's `sqlite3` stdlib if a `.db` ever lands here), then parse page titles/dates and sweep-line intervals. Also search for confirmed loss/missing/repair evidence separately before explaining why current records dropped. See `references/inventory-count-dispute-notion-overlap.md`.

When the question is not just “몇 대?” but **“내 기억과 모든 기록이 안 맞는데 왜?”**, run a historical discrepancy audit instead of only reading the current sheet: search 5-year Kakao raw threads by aliases + count/action words, classify purchase/count/location/loss/contract-mismatch clues, then compare with `equipment_ledger`, `equipment_events`, `장비마스터`, and old `실사 기록`. Report current truth first, then the likely data-lineage failure and physical next action. See `references/historical-kakao-inventory-discrepancy-audit.md`.

### Equipment investment / capex advisory

Use when the user asks whether Village should buy a camera body, lens, monitor, lighting unit, or whether a disputed purchase opportunity is worth pursuing. Do not answer from generic product hype. Pull live `장비마스터`/`세트마스터`/`스케줄상세`/`계약마스터`, exclude cancelled/held/rejected rows, calculate stock, repair notes, day rate, trade count, quantity rental-days, peak concurrent demand, recent usage, and rough annualized rental-days per owned unit. Rank options by Village bottleneck relief and model-cycle/resale risk. Prefer blunt conclusions like “1대 테스트만”, “특가 아니면 보류”, “GM 24-70 II 먼저”. See `references/equipment-investment-analysis.md`.

### Equipment disposal / sell-candidate analysis

Use when the user asks what gear has not gone out for 1+ years, what to sell, or which items are disposal candidates. Start with Brain owner criteria and `equipment-truth-ledger` disposal signals, but treat those as a shortlist only. Pull live `장비마스터`/`스케줄상세`/`계약마스터`/`세트마스터`, exclude cancelled rows, and verify exact recent usage before naming a candidate. Separate: `바로 매각/처분 검토`, `창고 정리/폐기/구성품 재분류`, `보류/애매`, and `최근 live 사용 확인되어 제외`. Beware name drift and component rows: `zero_match_items` and old Brain last-rental dates are not enough to declare no demand. See `references/equipment-disposal-candidate-analysis.md`.

### Equipment / capital-investment decisions

Use when the user asks whether to buy, sell, replace, or legally pursue a gear purchase opportunity.

- Do not answer from brand reputation or product-release hype alone. Pull live `스케줄상세` + `계약마스터`, `장비마스터`, and `세트마스터` data first.
- Compare candidates by trade count, quantity-days, peak concurrent demand, nominal revenue, owned/available/repair count, recent trend, and annualized days per owned unit.
- Explicitly factor Village-specific supply realities: if Anaki/partner consignment can reliably cover spikes, buying more current-generation bodies/lenses is less urgent.
- Explicitly factor product-cycle risk: old camera bodies near a successor can be a cash-hold decision even when demand is high; durable lenses/accessories usually carry lower refresh risk.
- Treat new-line purchases such as Aputure STORM as tests only when live demand/margin or a real bottleneck supports them. If old 300X-type stock is underutilized, replacing it with a 400X-class unit is branding, not bottleneck relief.
- For a broken used-market deal, first decide whether the item is a core business bottleneck. Only pursue legal/pressure tactics beyond reliance costs when the item/price is actually strategically worth it.
- See `references/equipment-investment-prioritization.md` for the calculation pattern and reporting heuristics.

### Historical equipment incident / prior-customer screening

Use when the user asks who may have previously **misreturned, not returned, lost, damaged, or swapped** a named equipment item (for example a particular 뉴클리어스 model). This is an evidence-screening task, not a live stock count or a liability determination.

1. Search Kakao/Supabase historical records first with a compact alias set: official equipment name, common shorthand, Korean/English spellings, and likely component/set names. Match both the individual equipment and parent-set/component text, but keep variants such as `뉴클리어스-M`, `뉴클-M`, `뉴클-N`, and Nano models separate unless the source explicitly equates them.
2. Treat an incident hit only as discovery. Retrieve the complete related customer thread by its `source_ref`/Kakao chat ID and read messages **after** the alert. This commonly reveals the important resolution: item later returned, item found in the customer's bag, courier dispatched, payment confirmed, or staff correction.
3. Classify each person in the final answer as one of:
   - `현재 확인 필요`: explicit missing/swap/damage alert and no later recovery/settlement confirmation in the available evidence;
   - `과거 사고·종결 확인`: later return, recovery, payment, or staff acknowledgement is present;
   - `파손 주장/책임 미확정`: damage was reported but the customer disputed it, causation was unclear, or settlement outcome is absent.
   Do not label a person as a confirmed loss/damage offender merely from an initial alert.
4. Keep **current rental / not-yet-due** rows separate from historical incidents. For live status, join `스케줄상세` and `계약마스터` by `거래ID` and assess against current KST; historical Kakao evidence alone cannot prove an item remains overdue today.
5. In the user-facing result, lead with the short actionable list, then list explicitly cleared false positives separately. Do not expose phone numbers unless needed for an approved follow-up action.

See `references/historical-equipment-incident-screening.md` for the search, thread-resolution, and report checklist.

### Return-not-yet-due / missing battery triage

Use when staff asks who has not returned yet because the return date has not arrived, asks which team likely has missing V-mount/브이마운트 batteries, or asks who previously lost/misreturned a V마운트 battery and may have compensated for it. For historical loss/변상 lookup, follow `references/vmount-loss-restitution-lookup.md`: Kakao Brain incident threads are usually higher-signal than Slack/ledger keyword search, and 미반납 evidence is not the same as confirmed 변상 입금.

- Use live `스케줄상세` + `계약마스터` joined by `거래ID`; do not answer from Slack history alone.
- Classify against current KST timestamp:
  - `반출일시 <= now < 반납일시` + contract not `반납완료/취소` = 정상 대여중 / 아직 반납일 전.
  - `반납일시 <= now` + contract not `반납완료/취소` = overdue; call out separately and do **not** include in “아직 반납일자 안 됨”.
- For V마운트 배터리 suspicion, broad `dashboardSearch&q=V마운트 배터리` is only discovery; it can miss component rows inside sets. Exact-search candidate `거래ID` values with `dashboardSearch&q={거래ID}&profile=1` and inspect the full `equipments` list.
- Treat row-level `checkedCheckout=true` + `checkedCheckin=false` on a V마운트 battery row as strong missing/unreturned evidence. Downgrade if `returnStatus`/`returnMemo` says `반납완료`; report incomplete records separately when neither checkout nor checkin is checked.
- Keep the answer short: 기준시각, 아직 반납일 전 teams, overdue exceptions, and V마운트 missing candidates with battery count and evidence.
- See `references/return-not-yet-due-and-missing-battery-triage.md` for the full checklist/report shape.

1. Prefer live operational truth in this order: Supabase `village.equipment_ledger` (current 재고 원장 + `equipment_events` history) → `장비마스터` sheet mirror / `실사 기록` audit rows → `세트마스터` exact item row → current schedule/timeline availability for the requested period if dates are provided → 재고관리-agent/Slack history only as supporting evidence. Use the env file pointed to by the root environment pointer `VILLAGE_DASHBOARD_ENV` (do not infer its location from the Windows user home) with the REST API when you need to inspect `equipment_ledger`; do not print secrets.
2. When ledger and sheet/audit disagree, explain data lineage separately: `stock_total`/`stock_maint` in the ledger is current truth, `장비마스터` is a mirror, `실사 기록` may contain an older physical-count field, and `equipment_events` can show whether a count was corrected after seeding.
3. If there is a known damage, repair, missing-component, or “분리 보관/사용중지” note for that item, report both numbers separately:
   - `장부상/보유` = physical or master-list count
   - `바로 대여 가능/안전 재고` = exclude questionable units/components
3. If live sheet/API lookup is temporarily unavailable, do **not** present Slack-history inference as a fully verified stock count. Answer briefly with the basis, e.g. “최근 기록 기준”, and clearly mark that 장비마스터 실시간 확인은 못 했음.
4. Keep the final answer short and operational: exact count first, then one warning line if availability differs from book count.

### Checkout/return damage and missing-accessory reports from staff

Use when staff reports a damage/repair issue such as “반출할 때 발견”, “필터 끼우는 부분 깨짐”, “파손 발견”, “고장”, or a return-count discrepancy / missing accessory requiring CCTV review such as “노가암 7개 반출했는데 6개만 반납함”, especially in `재고관리-agent`.

1. Treat it as a `damage_repair` / inventory follow-up, not a document/payment/schedule request. Keep it in `재고관리-agent` if routing is needed.
2. Resolve the related reservation by `dashboardSearch` on customer/team name first. If `tradeCandidates&date=오늘` returns no candidates, do **not** stop; damage reports often reference a recently completed rental or a future reservation. Search by name and verify the trade/equipment list.
3. Normalize the equipment name through `세트마스터`/dashboard rows (e.g. `70-200 gm2` → `소니 GM 70-200mm II`) and identify the matching `scheduleId`/trade when available.
4. Record the operational finding in the dashboard equipment-check layer using `updateEquipmentCheck`:
   - `field=returnStatus`, `value=파손` when damage is confirmed/reported.
   - `field=memo` with a concise note that includes item, symptom, 발견 시점, and responsibility guard, e.g. `반출 시점 발견 / 고객 귀책 처리 금지 / 사진·개체 확인 필요`.
5. For a missing-accessory/count discrepancy that needs CCTV review, resolve the exact trade and component row, then record it in the dashboard equipment-check layer as `returnStatus=미반납` with a concise memo (`N개 반출 / M개 반납 → X개 미반납. CCTV 확인 필요`). Re-read `dashboardSearch` to verify the status/memo. If CCTV/NAS is not actually reachable/reviewed, report the exact schedule/setup/return timestamps to inspect and explicitly say direct CCTV review was not done. See `references/staff-cctv-missing-accessory-report.md`.
6. Do **not** immediately change `장비마스터` stock/available/maintenance counts from a staff text report alone. Wait for physical unit/photo/serial, CCTV/physical confirmation, or explicit user approval before moving inventory to 정비중/수리중 or charging responsibility. Report this boundary clearly.
7. Final reply should be short: 거래ID, item, status/memo recorded, and the remaining physical/CCTV verification needed.

See `references/equipment-matching-notes.md` for concrete examples.

## Tax-invoice / proof issuance workflow

Use when the user asks to issue a 계산서/세금계산서 or a customer says payment depends on tax-invoice issuance.

- Treat tax-invoice issuance as a separate financial side effect from standard document sends and from sending Village bankbook/business-registration files.
- First resolve the trade (`거래ID`) and read the current `거래내역` proof state; do not issue twice if `발행완료` plus a real 관리키/proof record exists.
- For the GAS/Popbill path, `발행처DB` must contain the business number with 상호, 대표자, and email. If OCR of a business-registration image is blurry, do not guess 대표자명; stop with `대표자명 확인 필요` or use a verified app/manual path that supplies it.
- For a single already-registered trade with verified amount and clear business-registration info, the deployed document web app supports a direct `issueTaxInvoice` POST route that upserts `발행처DB`/`거래내역`, calls Popbill, and returns 관리키/NTS state. Use it instead of manual sheet edits when appropriate, then verify the ledger and `verifyTaxInvoiceNtsStatus`. See `references/direct-tax-invoice-issue-route.md`.
- If conversation/quote/contract/거래내역 amounts differ, stop and report the mismatch before issuing.
- Village Finance app (`https://village-finance.vercel.app/invoices`) is a supported alternate path for trade-based or manual issuance when logged in; use its confirmation/result as the destructive gate and verify afterward.
- 수정세금계산서 is not just a repeat issue: require the original 국세청승인번호 (`orgNTSConfirmNum`) plus Popbill 수정사유코드 1~6 (`1 기재사항 착오정정`, `2 공급가액 변동`, `3 환입`, `4 계약의 해제`, `5 내국신용장 사후개설`, `6 착오에 의한 이중발급`). For `orgNTSConfirmNum`, prefer Popbill status readback from the 관리키 and pass the exact approval string with separators removed; do **not** drop alphanumeric suffixes such as a trailing `f` (observed valid value: `20260511410002030000709f`). For 기재사항 착오정정 where buyer data was incomplete, pass the full buyer payload (`invoiceeCorpName`, `invoiceeCEOName`, `invoiceeAddr`, `invoiceeBizType`, `invoiceeBizClass`, 담당자/email) and preserve the original item/date/amount/purpose. Preserve the original invoice 관리키/발행완료 state; store/return the correction 관리키 separately and append a 거래내역 note. **Do not equate Popbill ISSUE success/stateCode 300 with Hometax issuance.** Treat HomeTax/국세청 as confirmed only after status readback has `stateCode >= 304`, `ntssendErrCode=SUC001`, and `ntsresultDT` present. Until then report `Popbill 발행접수 / 홈택스 전송대기`, not `발행 완료`. If the original NTS confirmation number cannot be read from Finance issued-history/Popbill/Hometax screenshot, stop instead of guessing.
- For registered-trade correction flows where a confirmed equipment fix leads to contract regeneration, quote sending, and 세금계산서 verification, follow `references/registered-trade-correction-send-invoice.md`. Important pitfall: `거래내역` O열 `관리키` may contain non-invoice markers such as `알림톡발송완료`; do not treat `L=발행완료` + that marker as proof of an actual 세금계산서. Verify via Popbill search/status or Finance before saying 발행 완료.
- See `references/tax-invoice-issuance-workflow.md` for the detailed runbook and report checklist.

## Document-send / Slack natural-language resolution

Use when the user asks for 견적서, 거래명세서, 계약서 링크, or 증빙 creation/preview/send in Slack/Hermes.

- Keep this workflow **document-only**. It must not perform 결제/정산 side effects such as `setPayment`; those belong in the separate 정산-agent/channel workflow.
- If staff says only `이거 처리해줘` / `이거` and attaches or replies with a Kakao/customer screenshot, **inspect/OCR the screenshot before deciding the target**. Do not infer from the previous Slack channel card, adjacent automation card, or top-row history. If the screenshot asks for multiple 견적서 files, resolve each date/customer independently and attach no-send previews first; see `references/slack-screenshot-quote-batch-resolution.md`.
- Route 견적서/거래명세서/계약서/증빙 결과 and staff-facing document follow-up through Slack `서류발송-agent`. If the request arrives from iMessage as a remote-control command for “헤이빌리”, still execute/report the document workflow in Slack `서류발송-agent` unless the user explicitly chooses another destination.
- 서류발송 Slack channel/workflow is only for explicit 서류요청: 세금계산서, 현금영수증, 견적서, 거래명세서, 계약서, 증빙, 사업자등록증·통장사본 document handoff. Do not route `[예약 후보 확인]`, `확인요청 입력`, `가용확인`, 재고/가용 상태처리, 반납/연장/변경 or 완료 기록, 파손/수리/미반납, 입금/결제 확인, 카카오 대화 확인 불가, or generic follow-up reports here. Same-conversation follow-ups should update/thread under the main task card, not create standalone top-level cards. Clean up misrouted bot messages using the Slack bot-message cleanup pattern when the user asks. See `references/document-channel-misroute-cleanup.md` and `references/follow-up-slack-routing-guards.md`.
- `my-gas-project2` resolves reservation/schedule/contract context; `my-gas-project` performs document/Popbill actions. Join them by `거래ID`.
- Do not make staff provide `거래ID` as normal UX. Parse natural language like `6월 1일 김태완 건 견적서 발송해줘`, call `tradeCandidates&name={고객명}&date={YYYY-MM-DD}`, then use the single returned trade ID.
- If zero or multiple candidates match, stop and ask/select from candidates; never send documents on ambiguity.
- Customer-facing document sends require an approval gate for this user: even if staff says “발송/보내줘”, first generate/prepare a preview or draft, show the user the checkable link/attachment plus customer, period, items, discounts, and final total, and state `고객 발송은 아직 안 했음`. Only send after the user explicitly approves (`승인`, `보내`, `발송해`). **2026-08-11 owner directive (Sequencing, see Authorization section) supersedes the re-ask half of this rule for OWNER-issued requests: when the owner's request itself contains `보내`/`발송해`/`승인` and there is no genuine blocker, that instruction IS the approval — generate, verify, and send in the same turn without asking again. The preview-and-wait path applies only when (a) the request has no send word, or (b) a genuine blocker exists (ambiguous duplicate trades, recipient/alias mismatch, unresolved item spec/price) — then deliver the finished preview WITH the blocker stated, never a bare question.**
- If the staff request names a recipient/alias different from the registered reservation customer (e.g. `정재하 건 '동윤'한테 견적서 보내주자`), do **not** use the registered-trade auto-send route blindly. Registered quote preview/send pulls customer name/phone from the resolved trade, so auto-send would contact the trade customer. Generate the registered preview first, explicitly report the current trade recipient/phone basis, and require one of: send to the registered customer, send to a verified existing alternate contact, or provide the alternate phone for a manual/recipient-adjusted send.
- For registered-trade quotes/statements, use the official Village/GAS document template. Do **not** substitute a locally recreated PDF/layout just because it is faster; use local PDF fallback only for manual/new-inquiry drafts when the official safe route is unavailable or explicitly unsuitable.
- For registered-trade estimate sends, generate/warm the current quote PDF from the official route, but the customer-facing Alimtalk button must use the generated public Drive PDF link (or direct-download URL), not the Apps Script live quote endpoint (`action=quote&id=...`). The live endpoint is useful for internal/manual browser opening only if it has a click-to-open fallback; mobile/Kakao in-app browsers can keep Apps Script in an iframe and show `Google Drive 액세스 권한 필요` despite a public PDF.
- If the user says they already edited `스케줄상세` but the quote preview still shows old contents or returns `cached:true`, verify the raw `스케줄상세` rows by `거래ID` before regenerating/sending. Registered quote generation only includes visible quote rows where 단가 is positive, plus 0원 standalone/representative rows; edits to 0원 set components or memos normally do not change the quote. Report this bluntly and ask which 거래ID/representative item/단가 should appear, rather than repeatedly attaching the same cached PDF.
- If a date is missing from a natural-language document-send request, `tradeCandidates` can be tried with `name` only as a resolver fallback. Proceed only if it returns exactly one non-cancelled candidate; if it returns zero/multiple, stop and ask for date/selection.
  - Practical exception: if the only extra candidates are clearly historical completed/cancelled rows and there is exactly one active/upcoming `예약` candidate, select that active candidate after verifying by `dashboardSearch`/trade detail, then generate the approval-gated preview. Report the resolved `거래ID`/period and still do **not** customer-send until approval.
  - Staff/customer names may arrive spaced or partially typed, e.g. `공 강혁` while the sheet stores `공강혁`. Try a normalized no-space name and, if needed, the distinctive given-name fragment for resolver lookup; only proceed when the active candidate uniquely maps back to the intended full customer.
- If a supplied date lookup returns zero candidates, remember `tradeCandidates&date=` filters by `계약마스터` 반출일; staff wording such as `6월5일 김나영 건` may refer to request/transaction date while the checkout is `6월6일`. Retry once with `name` only before reporting not found. Proceed only if exactly one candidate is returned and its checkout/customer/link are verified; otherwise stop for selection.
- If literal month/date lookups return zero candidates but name-only lookup reveals unique same-day-of-month candidates in a nearby/current month (e.g. user said `5월 8일 25일` but only `6월 8일`, `6월 25일` 박지웅 trades exist), treat it as a possible month slip: generate official no-send previews only, clearly report the mismatch/assumption, and require explicit approval/correction before customer send. For multiple same-customer inferred trades, merge PDFs into one approval artifact. See `references/document-date-mismatch-day-of-month-fallback.md`.
  - If the user later approves that mismatch-preview in the same thread (`보내`, `보내라고`, etc.), send the already-approved combined PDF **once**: upload/verify the combined PDF as public Drive `%PDF`, then call registered `sendEstimate` for one resolved trade with `pdfUrl=<combined PDF URL>` so the customer gets one notification. Do not loop per trade; only the trade row used for send may get the ledger note. See `references/approved-date-mismatch-combined-quote-send.md`.
- Registered-trade 거래명세서 has an extra route-safety pitfall: before executing, verify the deployed document API actually exposes a registered `sendStatement` or safe `previewStatement` route. If only `sendStatementManual` exists, do not use it for a registered trade; use quote preview only as a clearly-labeled math/content proxy and report that customer 거래명세서 발송 was not done.
- If wording is “만들어줘/확인해줘/찾아줘”, classify it as not-send and do not contact the customer.
- If the user asks to revise a registered-trade quote with an extra discount not already represented in `계약마스터` 할인유형 (e.g. `단골 10% 추가` on a quote currently generated as `학생30%`), do not send the existing/cached preview as-is. Use it only as the baseline for items/customer/period, recalculate the discount stack, and show an approval-gated revised preview first. If the deployed GAS route cannot express the ad-hoc discount, create a local PDF fallback from the preview CSV/items and attach it; customer 발송은 아직 안 했음. See `references/registered-quote-extra-discount-preview.md`.
  - For Kakao screenshot quote requests that are now already in `확인요청`/registered schedule (e.g. customer originally asked `삼각대`, staff says `셔틀러 에이스로 하고 단골 할인 적용`), search by visible phone/name first. If `확인요청` already has a `거래ID`/`등록완료`, switch to the **registered-trade** quote path (`previewQuote&id={거래ID}&discountType=단골`) rather than rebuilding a manual quote from the screenshot. Verify the registered top-level rows already reflect the staff-corrected item (`셔틀러에이스 M (75볼)` for `셔틀러 에이스`) and attach an approval-gated official PDF preview before customer send.
- For batch registered quote creation with an ad-hoc discretionary discount across many trades (e.g. `4월13일부터 최신까지 개인사업자/프리랜서 20% + 단골10%`), use official `previewQuote` CSVs as source data, then generate a no-send local PDF/zip bundle with recalculated `사업자20% × 단골10%` math. Exclude cancelled trades by default, verify page count/zip integrity/visual thumbnail, and beware parsing the supplier phone as the customer phone. See `references/batch-registered-quotes-ad-hoc-loyal-discount.md`.
- If the user corrects the requested registered-trade quote items (e.g. “GM 렌즈 세트 빼고 24-70, 70-200, 라오와 12 추가”), make the registered `스케줄상세` match first, then generate the official preview/send. Verify raw `스케줄상세` by `거래ID`, remove old set rows by `scheduleId`, add the replacement top-level items with `addEquips`, verify raw rows again, then `previewQuote` and inspect exported CSV before asking/sending. Do not rely on old cached preview or local PDF for a registered item correction. See `references/registered-quote-schedule-item-correction.md`.
- If the registered quote correction is simply removing standalone items such as ND/IRND filters, remove the exact `scheduleId` rows first, regenerate the contract once on the final removal, then generate a fresh official quote preview and inspect the exported CSV/PDF. Search both visible customer wording (`ND`) and sheet spelling (`IRND`) before deciding which rows to remove. See `references/registered-quote-remove-standalone-items.md`.
- Route testing without customer contact can use a nonexistent `거래ID` to verify that the route reaches the expected action and returns `거래ID 없음`.

References:
- `references/schedule-correction-exact-trade-restore.md` — recovering from wrong schedule corrections: exact 거래ID precedence, restoring full row groups from prior dashboard/session evidence, and verifying no unrelated trade remains touched.
References:
- `references/document-send-architecture.md`
- `references/document-send-natural-language-resolution.md`
- `references/village-document-send-runner.md`
- `references/alternate-recipient-registered-quote-preview.md` — registered quote/document preview when the requested recipient is different from the reservation customer; resolve active trade + alternate contact, never use registered auto-send blindly.
- `references/manual-quote-draft-fallback.md` — manual/new-inquiry quote draft fallback rules.
- `references/manual-quote-revision-resend.md` — revise/resend prior manual quotes from Slack thread/session context; recover prior payload, add/edit `세트마스터` top-level items, no-send preview, CSV/PDF verification, then explicit approval before customer contact.
- `references/confirmation-request-manual-quote-preview.md` — quote preview from pending `확인요청` rows, including personal-business discount and no-send manual preview workaround.
- `references/pending-rq-kakao-quote-from-followup-screenshot.md` — follow-up Kakao screenshots that map to an existing pending RQ: resolve actual customer from screenshot, price top-level RQ rows, handle document-date vs rental-period mismatch, surface availability blockers, and avoid re-posting send-capable routes after partial preview artifacts exist.
- `references/pending-rq-kakao-manual-quote-schedule-correction.md` — pending RQ + Kakao equipment-change quote: remove cancelled items, fold in customer-requested additions without duplicate quantities, create a no-send official manual quote preview, export `gid=0`, and verify totals before approval.
- `references/pending-request-quote-correction-registration.md` — when a pending-request quote is corrected and then approved for registration, build/register a fresh corrected `확인요청`, verify the new trade, then delete stale wrong RQ rows.
- `references/local-manual-quote-pdf-fallback.md` — local ReportLab PDF fallback for Kakao screenshot/manual quotes when safe GAS preview is unavailable.
- `references/manual-kakao-two-option-quote-preview.md` — official-template preview workflow for Kakao screenshots asking for two alternative manual 견적서 drafts; uses invalid/blank phone `sendEstimateManual` to generate no-send fileIds, exports CSV/PDF, and visually verifies truncation.
- `references/manual-kakao-single-quote-preview.md` — official-template preview workflow for a single Kakao/manual rental-list 견적서, including add-on items, blank-phone no-send generation, CSV/PDF verification, and alias pitfalls such as Video Fast→울란지 비디오패스트 / F210C→아마란 F21C.
- `references/manual-kakao-quote-price-override-pending-rq.md` — Kakao screenshot manual quote where staff overrides a line price (e.g. DJI SDR 1만원) while a pending RQ/customer DB provides supporting context; keep screenshot period, verify official no-send preview, and surface RQ mismatch/model-selection warnings before approval.
- `references/document-send-statement-preview-gap.md` — registered-trade 거래명세서 route/preview pitfalls and safe fallback behavior.
- `references/document-channel-misroute-cleanup.md` — 서류발송 채널에 예약/확인요청/가용확인/결제/수리 보고가 잘못 들어왔을 때 분류 기준과 Slack cleanup pattern.
- `references/gas-clasp-deploy-notes.md`
- `references/confirmation-request-model-memo-guards.md` — `모델 선택 필요` row/candidate reporting, stale F열 recheck, Q/R memo sanitization, contract additional-request filtering, and deployment verification.

## Payment / settlement / 미수금 workflow

Use when the user discusses 결제, 정산, 수금, 입금 확인, 반출 결제, 반납 정산, 미수금, or Slack 결제방 automation.

### Registered-reservation financial audits

Use when the user asks to check whether already-registered reservations have wrong amounts, missing charges, duplicated charges, or omitted payment/proof records.

- Compare **three sources**, not one: current `스케줄상세`, generated contract Google Sheet, and Village 2.0 `거래내역`; use `세트마스터` only as current price/name reference.
- **OBSOLETE HISTORICAL RULE — DO NOT USE.** Original archived text preserved verbatim: “For current-schedule recalculation, bill only positive-`단가` `스케줄상세` rows, apply Village rental-day rule (`ceil((hours - 6) / 24)`, min 1), apply discounts multiplicatively, then VAT/10원 rounding as the contract does.” The current owner-confirmed rule is `ceil((hours - 3) / 24)` (minimum 1).
- If `스케줄상세` and generated contract differ, do **not** immediately call the contract/ledger wrong. The schedule may have been edited after document generation. Report the exact mismatch and require actual carried-out equipment confirmation before any correction.
- If a customer/staff says `계약서 금액` and `견적서 금액` differ, compare **the actual generated documents by timestamp**, not just current schedule math. Use Drive search by `거래ID`/customer to find prior quote PDFs/sheets and the contract sheet, export both Google Sheets as CSV, then compare item rows and totals. A common benign cause is: quote was generated/sent first, then a positive-price schedule item was added before contract generation/regeneration. Explain the delta as `item price × discount multiplier × VAT/rounding` when it matches; e.g. a 5,000원 item under 학생30% adds 3,850원 VAT 포함.
- Generated contract links in `거래내역` can usually be audited via CSV export: extract `/d/{sheetId}/` and fetch `https://docs.google.com/spreadsheets/d/{sheetId}/export?format=csv`; inspect item rows, 합계, discount rows, and `총 결제 금액`. Official quote sheet links found in Drive can be audited the same way.
- Separate `금액 정상` from `증빙/입금상태 기록 누락`; blank proof/payment columns are ledger-follow-up issues, not necessarily math errors.
- Default to no mutation: do not rewrite ledger, regenerate contracts, issue/correct tax invoices, or send documents unless explicitly approved.

See `references/reservation-financial-audit.md` for the detailed audit checklist and discrepancy-report pattern. When the user confirms actual carried-out equipment and asks to correct/send/issue, switch from audit-only mode to the registered correction runbook in `references/registered-trade-correction-send-invoice.md`: verify schedule rows, regenerate the contract, preview official quote CSV/PDF, send only after approval/explicit send instruction, then verify tax-invoice state separately from Kakao/document-send notes.

Core correction: **do not assume prepayment is the default Village rental workflow.** Village mostly collects payment at `반출` or `반납`. Structural 미수금 prevention should focus on those operational gates before old-balance recovery.

1. Start from the real Village process, not generic rental assumptions.
2. Inspect `C:\Village\my-gas-project2-worktrees\ax2-hermes-final` for reservation/schedule/today-dashboard/API flow.
3. Inspect Village 2.0 / 개고생2.0 Google Sheets for the payment ledger.
4. Use `거래ID` to join schedule/contract data to `거래내역`.
5. Classify payment risk using schedule + ledger together:
   - 반납일 passed + M blank/미입금 → likely 미수 candidate
   - J present + M blank → record-completion gap
   - M 입금완료 + J blank → payment-method record gap
   - M 부분입금 → remaining-balance follow-up
   - L not 발행완료 where proof is required → 증빙 follow-up, not necessarily 미수
6. Design Slack payment-room outputs around operational gates:
   - today’s 반출 결제 확인 targets
   - today’s 반납 정산 targets
   - alerts for passed handoff/return with M blank/미입금/부분입금
   - alerts for method/status inconsistency
   - old 미수 recovery queue only after gate prevention is defined
7. POS/SMS card-payment notifications must **not** auto-link to a 거래ID by amount alone. Same amount is weak evidence and can be coincidence. Amount + matching operational date is usually strong enough to auto-check when it resolves to one unpaid/open trade: the card approval date should match the trade's relevant 반출/반납/payment-confirmation date, and the amount should uniquely match that same-date candidate. If the amount matches but the date does **not** match, or multiple same-date candidates exist, or the trade is just a future/past coincidental amount match, keep it as `자동 체크 보류` / human review and do not set J/K/L/M. Stronger anchors such as explicit customer/trade context, staff confirmation, or terminal/receipt metadata still override ambiguity.
   - Manual investigation of a 보류 card alert must search `거래내역` beyond strict `M=미입금`: include `M` blank, prefilled `J` values such as `계좌이체(VAT포함)`, and older same-amount rows, then only mutate when staff confirmation/customer/trade evidence resolves a unique row. After `updatePayment` → `카드결제`, verify J/K/L/M readback and note if a different same-day same-name row was left untouched.
8. If a card-alert Slack thread has a staff comment that explicitly says one approval covers multiple trades (e.g. `A건이랑 바로 지난 회차 동시 결제`), resolve each named trade from `계약마스터`/dashboard + `거래내역`, then mark only those resolved trades with `updatePayment` → `카드결제` and verify J/K/L/M. If the ledger amounts of the resolved trades do not add up to the card approval amount, still report the mismatch clearly after the update; do not silently “fix” amounts or include extra trades to force the sum.
9. Settlement Slack event source: plain `:moneybag: *입금 ...*` / `:credit_card: *매장 결제 ...*` posts in `정산-agent` are from the separate Slack incoming-webhook bot `정산알리미` (not the Hermes `헤이빌리` bot). On this machine, the producer source code was not found in the local repos; only finance env wiring was observed in `C:\Village\village-ai\.env.finance` (finance DB, Slack webhook, deposit-account filter, Toss webhook secret, Village2 API). Treat these as event logs unless they include a completion/hold status or a staff/Hermes thread action. The Slack follow-up backstop explicitly ignores pure settlement event logs; they become actionable `payment_check` only when they mention Heybilli or include exception/action wording such as `확인 필요`, `미수`, `누락`, `오류`, `환불`, `취소`, `세금계산서`, `현금영수증`, or `증빙`.

Known payment-ledger columns in `거래내역`:

- A: 날짜
- B: 예약자명
- C: 계약서링크
- D: 입금자명
- E: 거래ID
- F: 연락처
- G: 발행처 상호
- J: 결제수단
- K: 증빙유형
- L: 발행상태
- M: 입금상태
- N: 비고

Important statuses:

- `M 입금상태`: `미입금`, `입금완료`, `부분입금`, `환불`
- For `카드결제`, API-side logic may set K/L/M to `미발행` / `발행완료` / `입금완료`.
- VAT별도 audit pitfall: `my-gas-project` direct/onEdit/setPayment paths handle `계좌이체(VAT별도)` by syncing amount to contract total `/ 1.1` and leaving M=`미입금` for bank matching, but `my-gas-project2` dashboard `updateTradePaymentMethod` has historically needed a separate side-effect mirror because cross-spreadsheet `setValue` does not trigger the target `거래내역` onEdit. When checking or fixing VAT별도 deposits, inspect both paths.

References:
- `references/payment-workflow-notes.md`
- `references/village-payment-ledger-map.md`
Daily/감사/점검/요약/자동화 보고 reports are Kakao 단톡방-only outputs; they must not create Supabase `operation_tasks`, `ai_follow_up_items`, queue cards, or be duplicated into Slack, Event API, or agent channels.

## Kakao/RPA automation operations

Use this class-level subsection when checking, repairing, or reporting on Village local browser/RPA automations: Kakao Channel Manager DOM watcher, local bridge, automation Chrome profile, AI browser worker, queues, watchdogs, Scheduled Task supervision, Slack follow-up delivery, and customer-facing manual sends.

Default diagnostic sequence:

1. Work from `C:\Village\my-gas-project2-worktrees\ax2-hermes-final` unless the user gives a different project.
2. Start read-only: `scripts/windows/status-kakao-staging.ps1` (via `powershell.exe -NoProfile -File`) and `schtasks.exe /Query /TN Village-Kakao-Production-Watchdog /V /FO LIST`, health endpoint, Scheduled Task/supervisor status, recent logs, and queue/result files.
3. Separate the layers in both diagnosis and final report: 감지부/bridge, queue/Supabase/storage, worker, live side effects/sending.
4. Inspect actual worker/action evidence (`events.ndjson`, `heartbeats.ndjson`, `jobs.ndjson`, `worker-results.ndjson`, `auto-replies.ndjson`, Slack/action ledgers), not just green health/liveness.
5. Treat `heartbeats`/Kakao tab presence as detection-only. Do not claim recovery until worker results or side-effect ledgers prove the action pipeline is moving.
6. Preserve the normal automation Chrome `🤖 자동화 크롬` as an owned process started only by `scripts/windows/restart-kakao-owned-chrome.ps1` (Start-OwnedKakaoChrome, kakao-dom-watcher-extension, DevToolsPort 9223); never hand-launch it — an agent-spawned Chrome fails the watchdog's process-ownership validation, so if it is down, report and stop (infrastructure incident). Never use the staff-only `💁🏻 직원용 크롬`, and do not recreate hidden/isolated profiles unless the deployment is explicitly isolated-profile mode.
7. For login/session failures (`권한이 없습니다`, Kakao account login, stale heartbeats/events), run the profile-aware recovery path and stop only for secrets/biometric/2FA approval; do not type passwords or OTPs.
8. For scheduled/manual Kakao sends, create bounded one-shot script-only Scheduled Tasks (`schtasks.exe /Create /TN <name> /TR <cmd> /SC ONCE /ST HH:MM /F && schtasks.exe /Run /TN <name>`) or use the existing bridge manual-send route, then verify the actual Kakao chat body/attachment state before reporting success.
9. For watchdogs/alerts, keep healthy runs silent, use Korean human-readable 원인/영향/조치 alerts, and avoid posting routine watchdog output to Slack unless explicitly requested.

High-value references copied from the former `rpa-automation-operations` package:

- `references/village-kakao-half-alive-dom-watcher.md` — green bridge but stale jobs/results/auto-replies.
- `references/village-kakao-duplicate-backstop-queue.md` — duplicate unread/backstop churn and stuck durable ready rows.
- `references/village-kakao-watchdog-restart-loop.md` — watchdog restarts killing legitimate worker runs.
- `references/village-kakao-cdp-watcher-injection.md` — verifying content-script injection in the Kakao page.
- `references/village-kakao-profile-safe-room-navigation.md` and `references/village-kakao-normal-profile-cua-fallback.md` — safe Chrome profile targeting and DevTools/CDP fallback.
- `references/village-kakao-login-recovery-watchdog.md` — Kakao login/session recovery integrated with watchdog checks.
- `references/village-kakao-worker-rag.md` — distinguishing current Hermes MCP/RAG from Kakao worker-specific RAG.
- `references/village-kakao-critical-watchdog.md` and `references/village-kakao-critical-alerts.md` — SMS/iMessage/macOS critical-alert hardening.
- `references/village-kakao-document-send-dom-file-input.md` and `references/village-kakao-scheduled-manual-send.md` — verified file/manual customer sends.
- `references/hermes-computer-use-yolo-approval.md` and `references/gateway-self-restart-recovery.md` — Hermes automation approval and detached restart pitfalls.
- `references/village-network-cctv-agentdvr.md` and `references/village-kakao-windows-worker-migration.md` — adjacent RPA infrastructure recovery/migration notes.

## Slack/Kakao FAQ / RAG automation

Use when the user asks to build Slack room automation that learns repeated employee questions, connects to old Kakao/customer/internal chat CSVs, auto-answers staff, ingests call recordings as staff knowledge, fixes Kakao Channel Manager customer auto-replies, or when the user controls Slack/헤이빌리 workflows from another platform such as iMessage.

### Cross-platform control of Slack/헤이빌리

When the user is chatting outside Slack but asks to act “as 헤이빌리” or says `누구한테 보내줘/얘기해줘/전달해줘`, treat the external chat as a remote control for Slack operations:

1. Default delivery is **Slack `단톡방` with the named staff member mentioned** (e.g. `<@USERID> 메시지`). Do **not** default to iMessage, SMS, or Slack DM just because a contact/DM is available.
2. Use Slack DM only when the user explicitly says `DM으로`, `개인 DM`, `개인톡`, `문자로`, or otherwise specifies a private channel.
3. Resolve the staff member’s Slack user ID from recent Slack history/mentions when needed, then send to `slack:단톡방`; verify with `slack_history` readback when possible.
4. Final report should state the actual channel used (`Slack 단톡방 멘션`, `Slack DM`, etc.) so the user can immediately catch wrong-route sends.


- Start with observation mode → approval mode → allowlisted auto-reply mode for **customer-facing auto-replies**.
- For **internal staff Q&A** from owner/staff call recordings, do not over-engineer privacy/review gates unless the user asks. The user has explicitly said staff/owner call contents may be treated as internally shareable company data; keep the workflow simple and operational.
- If Village already has a RAG system, **reuse it**. Do not create a parallel vector DB/KB without a concrete reason. Current default existing system is `C:\Village\village-kakao-ai` using Supabase `search_village_references` over `documents`, `knowledge`, `mistakes`, `corrections`, and `pinned_answers`; call-derived reusable staff knowledge should go into `public.knowledge`.
- For 5-year Kakao/customer/staff CSV exports, prefer local folders under `C:\Users\ssper\AppData\Local\hermes\village-faq-rag\incoming\` rather than Slack uploads.
- Treat call-recording uploads from the `헤이빌` Slack agent exactly like the existing A-dot/iPhone call-recording workflow. Inspect the Slack file attachment metadata, download/transcribe the audio, summarize/classify, leave the short report in the call channel, and route the same 핵심요약/액션 to the relevant agent channel. If the uploaded filename does not contain the 11-digit phone prefix (for example `VILLAGE.님과 통화.m4a`), explicitly report `전화번호 확인 불가` / `고객 확인 필요` rather than trying to infer the customer.
- If Village already has a different RAG system, connect Hermes to it via CLI JSON wrapper first, HTTP API second, direct DB/index third.
- Keep raw RAG evidence separate from auto-send eligibility for customer replies; only reviewed FAQs with `auto_reply=true` should answer customers automatically. Internal staff Q&A can use internal knowledge more directly, while still citing/grounding the source briefly.
- For Kakao customer auto-replies, `CURRENT_CONFIRMED_POLICY` wins over older RAG/Kakao history. Treat Village 영업시간/운영시간 as a current confirmed FAQ: **24시간 운영**.
- Customer requests for `통장사본`, `통장 사본`, `계좌 사본`, `사업자등록증`, or `사업자 등록증` are a pre-approved simple document-send case: send both stored media files together from `C:\Users\ssper\AppData\Local\hermes\village-documents\customer-request-docs\` (`village_woori_bankbook_copy.jpeg`, `village_business_registration_certificate.jpeg`) when using Hermes media-capable channels. Do not ask approval again for this internal/standard info request. If using Kakao Channel Manager browser automation, remember text auto-reply and actual file attachment are separate; use DevTools/CDP file input upload only (`computer_use`/CUA is removed from this deployment — 2026-08-11 owner decision; if the CDP path fails, that is an infrastructure incident: report and stop, per the incident guard), and never report success unless the attachment send path is verified. Browser/Kakao automation must target `🤖 자동화 크롬`; if the visible/captured window is `💁🏻 직원용 크롬`, stop and retarget before testing customer-facing sends. See `references/kakao-standard-document-attachments.md`.
- Do not make FAQ auto-send depend on RAG when a proposed answer safely matches current confirmed policy. Use RAG only for uncovered policy/procedure references, and never for current stock, booking truth, mutations, or duplicate checks.
- For customer reservation inquiries with no visible phone number, first check the stored Kakao/Village customer profile and recent same-customer identity history. If the DB/profile still has no phone, reply/request contact first; explicitly say 예약 등록은 연락처가 있어야 가능 and do not proceed as if the reservation can be registered without it. Treat Kakao room titles/nicknames as evidence, not 예약자명. When editing automation, enforce this in both prompt/worker logic and GAS `insertAndCheckRequest` hard guards so blank-phone confirmation rows cannot be created accidentally, and make duplicate detection compare usable phone as well as name so the same person under nickname/real-name aliases (e.g. room nickname vs 예약자명) cannot create separate RQs. See `references/reservation-missing-contact-guard.md`.
- If the user reports a Kakao reservation/contact issue sat unresolved despite the DOM watcher being “alive,” debug the bridge failure/timeout path separately from the successful worker path. Confirm whether timeout-created follow-up rows reached Slack, not just Supabase. In `tools/kakao-dom-bridge/server.mjs`, a helper such as `createWorkerFailureFollowUp()` must call both `upsertFollowUpRows()` and `deliverSlackFollowUpRows()` when `SLACK_AGENT_CARD_DELIVERY_ENABLED=1`; expose the Slack delivery gates in health, close superseded stale rows only after verifying `계약마스터`/`스케줄상세`, then restart and re-query. See `references/kakao-worker-timeout-slack-delivery.md`.
- Also handle the non-error silent-drop case: a worker can exit successfully after refusing to act on a `preview-only`/`chat row not found` Kakao room. If the preview contains reservation/equipment/quote business signals and the completed stdout has no sheet write and no inserted follow-up, escalate it through the same human-review follow-up path instead of marking it handled. During incident recovery, search by customer name plus every plausible phone variant, 보류 stale/generic RQs, rebuild verified `확인요청`, and report any phone mismatch. If the user says multiple unknown reservations are surfacing, run the bulk recovery scan across `jobs.ndjson`, `worker-results.ndjson`, and `worker-skipped.ndjson`; verify each candidate against `확인요청`/`계약마스터`; insert only complete safe requests; fix existing generic RQs with `updateRequestItem`; and report holds to `스케쥴-agent`. See `references/kakao-preview-only-reservation-drop-guard.md` and `references/kakao-bulk-missed-reservation-recovery.md`.
- Slack follow-up routing must treat the structured type as primary. For `reservation_review`, `schedule_check`, and `sheet_duplicate_check`, keep the route on `스케쥴-agent` unless the user-facing request is explicitly 견적서/계약서/거래명세/세금계산서 발송/생성. Do **not** let internal evidence words such as `계약마스터 조회`, `계약마스터 최근 예약 없음`, or `스케줄상세/계약마스터 확인` trigger the document route; those are schedule/reservation lookup evidence, not 서류발송 intent.
- Kakao preview/list date labels are not automatically old messages. Compare `N월 N일` labels against current KST; same-day top-row/unread evidence may be live, while non-current date labels should still block auto-send/backfill.
- If staff already said a reservation/configuration is possible and the latest customer message is acceptance/proceed wording such as `그럼 이렇게 부탁드립니다`, do **not** route it as vague `답변 필요` / `예약 후보 확인 필요`. Treat it as staff-confirmed reservation acceptance: send/draft a short confirmation like `네 감독님, 말씀 주신 구성으로 예약 확정해드렸습니다.` when mutation is done/safe; if mutation failed, create one precise operational follow-up naming the failed mutation. See `references/kakao-staff-confirmed-reservation-acceptance.md`.
- Keep `24시간 운영` separate from rental-day calculation (`24시간=1일`). A bare `24시간` in an 영업시간/운영시간 context must not trigger rental-day policy mismatch.
- Never auto-answer initially for refunds/disputes, discounts/price exceptions, 미수금/정산 exceptions, customer complaints, damage responsibility, or legal/contract-sensitive issues.
- Do not claim Slack history/channel learning is available unless Slack app permissions/events support it (`message.channels`, `channels:history`, bot invited to the channel, etc.).

### Slack message cleanup / deletion powers

Use when the user asks to delete misrouted automation reports from Slack or asks how to give Hermes deletion ability.

- Distinguish Slack app scopes from Hermes tool capability: `chat:write` only posts; deletion needs `chat.delete` plus a surfaced Hermes cleanup tool/workflow.
- Normal bot tokens should be treated as able to delete **only messages posted by the same Hermes/헤이빌리 bot**. Do not promise deletion of human messages or other apps without admin-level Slack capabilities.
- Required practical scopes: `chat:write` plus `channels:history`/`channels:read` for public channels; add `groups:history`/`groups:read` for private channels. After changing scopes, the user must go to **Slack API → Your Apps → app → OAuth & Permissions → Reinstall to Workspace**.
- Bulk cleanup must be dry-run first: resolve target channels, inspect/search `conversations.history`/`conversations.replies`, filter by bot author + keyword/report type + date range, show count/snippets, then call `chat.delete(channel, ts)` only after explicit approval. When the user asks to clean a known bad batch in one channel, prefer exact `message_ts` deletion from the inspected history over broad keyword deletion, because legitimate document cards can contain operational evidence words.
- After deletion, rerun the same find query and report remaining count per channel; do not stop at “API said deleted.”
- If `conversations.list` fails with `missing_scope needed=mpim:read` while resolving normal channel names, restrict channel listing to `public_channel,private_channel` or use known channel IDs; do not ask for MPIM scope unless DM/MPIM cleanup is actually required.
- For Village Daily/감사/점검/요약 mistakes, target only non-Kakao destinations; the intended Kakao 단톡방 report must not be deleted or duplicated into Slack cleanup logic.

References:
- `references/slack-faq-rag-automation.md`
- `references/staff-call-rag-ingestion.md` — call recordings/summaries as reusable employee Q&A knowledge in the existing Village Kakao AI/Supabase RAG.
- `references/kakao-auto-reply-gates.md`
- `references/kakao-standard-document-attachments.md` — 통장사본/사업자등록증 표준 요청을 Kakao Channel Manager에서 파일 첨부까지 보내는 DevTools/CDP runbook and verification gates.
- `references/slack-message-deletion.md`
- `references/daily-audit-backfill-debugging.md` — how to debug `daily_audit_YYYYMMDD_backfill` Slack floods without mislabeling delivery metadata as a user setting.
- `references/hermes-slack-followup-patch-maintenance.md` — preserving Village Slack button/modal handlers while keeping upstream Hermes Socket Mode watchdog startup during local patch/merge conflicts.
- `references/kakao-worker-timeout-slack-delivery.md` — debugging and fixing Kakao DOM watcher/AI-worker timeout paths that create Supabase follow-up rows but fail to deliver Slack agent cards.

## Cross-channel control: iMessage as Slack/Heybilli remote

Use when the user is chatting from iMessage but says they want to control Slack/`🤖헤이빌리`, or asks to tell a Village staff member something.

- Do **not** default to personal iMessage/SMS just because the current conversation is iMessage. If the user frames the request as Slack/헤이빌리 control, execute in Slack and report only the result back to the origin chat.
- For staff instructions like `장성원한테 보내줘`, if the delivery surface is ambiguous, prefer Slack/헤이빌리 in Village operations; ask only when it materially changes the action. Do not use macOS Contacts/iMessage unless the user explicitly asks for 문자/iMessage/개인 연락처.
- To DM a Slack staff member, resolve the Slack user ID from Slack evidence first: search visible channels for the name/short name and inspect mentions such as `<@U...>`, then verify the candidate with `users.info` when possible before sending.
- If `send_message` cannot resolve a Slack user DM directly, open the DM with Slack `conversations.open(users=U...)`, send with `chat.postMessage(channel=D..., text=...)`, then verify the latest DM history matches the sent text. Report the Slack name, DM channel ID, and verification status briefly.
- Keep the user-facing final short: `Slack DM으로 보냄 / 대상 / 내용 / 확인 여부`.

## Reporting style for this user

- Korean by default for Village operations.
- Treat iMessage requests as remote control for Slack/헤이빌리 when the user is directing Village staff/workflows. For “OO한테 보내줘/얘기해줘” staff messages, default to Slack `단톡방` with that person mentioned; use Slack DM, iMessage, SMS, or customer-facing Kakao only when explicitly requested.
- Start with the outcome and exact request ID / 거래ID / operational conclusion.
- Be blunt and exact; avoid generic business theory.
- If corrected, explicitly acknowledge the wrong assumption and restate the Village-specific operating model.
- List unresolved sheet/system warnings clearly.
- Distinguish “entered request,” “availability checked,” “registered schedule,” “document sent,” and “payment/ledger updated” as separate side-effect levels.
- `빌리지 아침 보고` / Brain 정기 운영 브리프(`scripts/brain/02_inventory_brief.mjs --send`) routes to Slack `사업-헤이빌` (`C0BB07SM3EH`), not owner DM/current thread.
- Daily/감사/점검/요약/자동화 보고 are **Kakao group-room report-only outputs**, not Slack/agent-channel reports, not task notifications, and not Supabase operation-task/`ai_follow_up_items`/큐카드. This guard is for those Kakao report-only outputs; it does **not** override the separate 아침 보고 route above. Do not classify or duplicate Kakao report-only outputs into Slack, Event API, agent channels, category-specific channels, or queue cards; keep cards only for separate real follow-up work items. If this guard fails, patch both manual/RPA task creation, conversation/intake task creation, and AI browser-worker follow-up delivery/upsert paths before reporting completion.
- If all 큐카드/태스크 alerts suddenly arrive at one timestamp, debug it as a watcher/backfill/replay failure: compare queue-row created times vs Slack sent times, inspect Scheduled Task/scheduler runs and watcher last-seen cursors, and verify the intended live DOM watcher route is still running. Do not answer with generic “분류 중입니다”; identify why accumulated cards flushed and why the Kakao report path did not deliver.
- When a `daily_audit_YYYYMMDD_backfill` value appears, first check whether it is `payload.slack_delivery.source` rather than the row's true `source` or a user config. If it is delivery metadata, say so explicitly: it means the row was delivered by a daily-audit/backfill/recovery path, not that the user configured backfill. Compare `created_at` with `payload.slack_delivery.delivered_at`; clustered delivered times with older created times indicate a batch flush. See `references/daily-audit-backfill-debugging.md`.

## Common pitfalls

### Follow-up Slack calculation sanity checks

Use when a Slack follow-up card shows an impossible `계산` amount or the user challenges the card math.

- Treat Slack card `계산` blocks as generated diagnostics, not source of truth. Re-check `계약마스터`/`스케줄상세`/`세트마스터` before defending a number.
- For registered reservations, bill only positive-`단가` rows in `스케줄상세`; expanded zero-price component rows are not separate chargeable items.
- For pre-registration RQ calculations, only price a row from `세트마스터` when returned `세트명` exactly matches the queried 확인요청 item. GAS substring search can return a parent set for a component-bundle string, which double-counts sets such as `소니 Z90`.
- Watch for JavaScript VAT rounding tails: `50,000 × 1.1` must be `55,000원`, not `55,010원`; subtract a tiny epsilon before 10원 `Math.ceil` rounding.
- If customer-stated payment differs from 계약마스터 할인유형, do not assume the card/system discount label is right. Example: `소니 Z90` 50,000원 same-day with 20% discount + VAT = 44,000원 even if 계약마스터 still says `일반`.
- See `references/follow-up-slack-calculation-pitfalls.md` for the double-counted expanded-components and VAT +10원 debugging pattern.

- A request for quote/document creation is not permission to register a reservation.
- Manual line-item quote creation (`견적서 하나 만들어줘`) is a draft/preview task, not registered-trade resolution and not customer-send. If the request is only priced line items (e.g. `솔리드컴 5S 45일 900,000원 / 솔리드컴 2S ...`) and lacks customer/date/trade ID, do **not** let the Slack document runner's `needs_customer_and_date` result be the final answer; that means the parser routed a manual quote as a registered-trade quote. Check document API health separately with a harmless nonexistent `previewQuote` trade ID, then build/confirm a manual quote payload. Clarify ambiguous shorthand prices such as `150` before generating the draft unless context clearly means `150,000원`.
- A request for document send is not permission to perform payment/settlement updates.
- Manual quote/statement creation (`견적서 하나 만들어줘`, `거래명세서 만들어줘`) is draft/preview work, not customer contact. Use a safe create/preview route and show the generated file or at minimum the exact payload/amount summary; do not fall back to send-capable manual actions unless the user explicitly approves sending.
  - If a prior manual quote in the same Slack thread/session must be revised and resent (`위 견적서 각각 ... 추가해서 다시 보내자`), do not ask staff to restate the full quote and do not immediately send the changed document. Recover the previous manual quote payload from thread/session context, apply the edit using top-level `세트마스터` pricing, generate a no-send official-template preview, export/verify CSV+PDF, then wait for explicit approval before customer contact. If the user explicitly waives approval for that correction (`승인 없이`, `그냥 보내`), send the corrected quote directly, then verify the returned `fileId` by CSV because `pdfUrl` may be blank. See `references/manual-quote-revision-resend.md`.
  - If the corrected manual/pending quote later needs reservation registration, do **not** register stale `확인요청` rows that still contain old items/quantities. Create a fresh corrected `확인요청` from the final quote payload, register it, verify `스케줄상세`/`계약마스터`/`거래내역`, then delete the stale old request only after successful verification. See `references/pending-request-quote-correction-registration.md`.
  - If the request is for an unregistered inquiry or pending confirmation request (`문의들어온 건`, `확인요청`, no `거래ID`), search `확인요청` by customer/date, read back the full `요청ID` group, price only top-level requested rows from `세트마스터` G열, and generate a manual quote preview. If using `sendEstimateManual` with blank/invalid phone, `status:"ERROR"` + `연락처가 유효하지 않습니다.` + a returned `fileId` is the expected no-send preview workaround; export CSV/PDF from that `fileId`, verify discount/total, and clearly state customer send has not happened. See `references/confirmation-request-manual-quote-preview.md`.
  - If a manual quote request lists priced items directly (e.g. `품목 기간 금액 / ... 견적서 하나 만들어줘`) and no customer/date/trade ID is supplied, do **not** route it through the registered-trade resolver or report `needs_customer_and_date` as the final answer. Treat it as a manual/internal quote draft: parse each top-level item and amount, clarify only genuinely ambiguous units (`150` may mean 150,000 or 1,500,000), then generate/show a draft with `고객명: 미지정` if customer data is absent. See `references/manual-quote-draft-fallback.md`.
  - For customer/manual quote requests where the customer says only `여기로 보내주시면 됩니다` and staff asks to apply an ad-hoc discount/period (e.g. `OSEE 모니터 단골 + 장기 18회차`), do not infer a registered trade. Verify the item price from `세트마스터`, create a no-send manual preview; if `sendEstimateManual` returns `연락처가 유효하지 않습니다` but includes `fileId`, export/verify that file as the preview artifact and keep customer-send approval-gated. See `references/manual-quote-osee-loyal-longterm-preview.md`.
- Manual quote/statement sends are especially risky: if the staff-provided 단가/금액 already has student pricing baked in, do not set `할인유형=학생`; otherwise the document double-discounts. Use the approval-gated preview to show item 단가, discount labels, and final total before customer contact.
- When the owner corrects a **manual-quote item’s daily price** after a preview (for example, “FX9 풀세트 정가는 130,000원이야”), treat the explicit correction as a quote-only price override: preserve the item and all other recovered payload fields, replace only that `단가`, and regenerate the official no-send preview with blank/invalid phone. Verify the revised CSV/PDF line amount, subtotal, discount, VAT, and final total; visually inspect the PDF. Do **not** mutate `세트마스터` pricing from a one-quote correction, and do not contact the customer until the revised preview receives explicit approval.
- For manual `거래명세서` generated from quote context, verify the final sheet says `거래명세서 / STATEMENT` and no quote-validity/student-proof language remains before treating it as the final sent document.
- For registered-trade **거래명세서** requests, never use `previewQuote` or a quote PDF as a stand-in preview. Use the registered statement routes instead: `GET previewStatement&key=...&id={거래ID}` for approval-gated preview, then `POST sendStatement` with the preview `fileId` only after explicit user approval. If approval comes later as a short reply like `보내`, recover the exact prior preview `fileId`/거래ID from the thread/session before sending; do not regenerate or send a different document unless the preview is unavailable. 거래명세서 알림톡 has a separate template-code pitfall: if `STATEMENT_TEMPLATE_CODE` is blank or the route enables Popbill `altSendType`, it can silently fall back to 문자. Do not treat `receiptNum`/`pending` as confirmed Kakao delivery; verify the code path blocks SMS fallback and report API acceptance separately from final Kakao/Alimtalk delivery. If the deployed route regresses, returns generic action errors, or the statement Alimtalk template code is missing, stop and report rather than customer-sending/SMS-sending.
- When the document runner maps `sendStatement`, verify the document web app actually exposes that registered-trade action in `agreement.js`/deployed GAS before presenting it as executable; manual `sendStatementManual` support does not imply registered `sendStatement` support.
- `dashboardSearch` may not find a `확인요청` ID directly; after registration, verify by `거래ID` through `스케줄상세` and/or dashboard search.
- Spreadsheet time values may display oddly (`1899-12-31 ...`); trust the inserted `HH:MM` after verifying rows exist under the correct request/trade.
- Set expansion can produce more result rows than the user’s top-level item count; report top-level items plus material warnings.
- Some set components intentionally appear as 미등록 or 모델 선택 필요; do not hide them if they affect staff action.

## Learn as you work (built-in memory)

When a request teaches you something durable - a customer/owner phrasing that maps to an exact sheet equipment name, a shop rule you had to rediscover, or a mistake you corrected - save that fact to Hermes built-in memory so the next request starts warm. You judge what is worth saving; keep entries short and factual. Never store customer personal data (names, phone numbers) in memory - equipment vocabulary and shop rules only.
