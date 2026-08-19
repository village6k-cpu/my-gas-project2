# Kakao bulk missed-reservation recovery

Use when the user reports that multiple unknown Kakao reservations are surfacing, especially after a preview-only/DOM watcher incident.

## Goal

Recover every actionable reservation candidate into `확인요청` without creating duplicate requests or registering unsafe schedules.

## Scan sources

Work from `C:/Village/runtimes/my-gas-project2-production/tools/kakao-dom-bridge/queue`:

- `jobs.ndjson` — original debounced Kakao DOM jobs and `previewText`/events.
- `worker-results.ndjson` — worker stdout decisions, `sheetResult`, `followUpResult`.
- `worker-skipped.ndjson` — duplicate/local-active skips that may hide an actionable preview.
- Optional: `errors.ndjson`, `worker-failure-followups.ndjson`, `worker-completion-followups.ndjson` for failure/escalation evidence.

Candidate signals:

- Preview/body contains reservation terms plus equipment/date/time/phone signals: `예약`, `대여`, `가능`, `신청`, `반출`, `반납`, `견적`, `FX3/FX6/A7S3/R6`, `100-500`, `70-200`, `조명`, `삼각대`, etc.
- Worker decision says `matching Kakao conversation not visible`, `preview-only`, `chat_row_not_found`, or equivalent.
- `sheetResult.success` is not true and `followUpResult.inserted`/`rows` is empty.
- `worker-skipped` reason is `local_duplicate_job_active` or `duplicate_supabase_job_waiting_for_recovery_sweeper` but the preview itself is a structured reservation.

## Recovery workflow

1. Group candidates by room/customer/preview and dedupe noisy repeated DOM events.
2. For each candidate, search `확인요청` and `계약마스터` by every usable identifier:
   - customer name / Kakao room alias
   - phone with and without hyphens
   - distinctive equipment/date keywords
   - existing RQ IDs mentioned in worker decisions
3. Classify each candidate:
   - **already covered**: matching RQ/trade exists — read the whole group and fix obvious blockers if safe.
   - **safe to insert**: name/phone/date/time/equipment are sufficient and no duplicate RQ/trade exists.
   - **hold/escalate**: missing phone, ambiguous customer, missing start/return time, only preview text, or staff already rejected/closed the inquiry.
4. Insert only safe candidates via `insertAndCheckRequest`; verify by reading back the new RQ group.
5. For already-covered RQs with generic/mis-matched rows, use targeted `updateRequestItem` rather than appending duplicates. Examples from incident recovery:
   - `100볼 트라이` → `서튼비디오 V-15 (100볼)` when the request needs stocked 100볼 tripod availability.
   - BURANO expanded blockers `7인치 모니터` / `매트박스` → concrete models such as `스몰HD INDIE7` / `틸타 MB-T16(미라지)` when customer/staff preference supports it.
6. Do **not** register schedules during incident recovery unless explicitly requested after reviewing availability blockers. Recovery target is `확인요청` + 가용확인 + clear staff report.
7. Report to Slack `스케쥴-agent` with:
   - RQ IDs recovered/verified
   - important shortages/model-selection blockers
   - candidates deliberately not inserted and why
   - whether the watcher/bridge guard was restarted/deployed

## Guardrail patch pattern

Silent completed-worker drops need a completion escalation path, not only error/timeout follow-ups:

- After a worker exits code 0, parse stdout.
- If preview has actionable business signal, no sheet write succeeded, and no follow-up row was inserted, and the decision reason/status indicates preview-only/chat-not-opened, call the same human-review follow-up delivery path used for worker failures.
- Append a local audit row such as `worker-completion-followups.ndjson` for verification.
- Restart the Kakao bridge and check health shows `slackCardDeliveryEnabled: true`, `followUpRowsEnabled: true`, worker live, and Kakao chat verified.

## Pitfalls

- `local_duplicate_job_active` is not proof of successful handling; it can be a repeated DOM event around the same missed preview.
- A structured preview with no phone or missing return time must not be force-inserted. Create/report a human-confirmation item instead.
- Staff already saying “예약이 다 잡혀 있습니다” followed by customer acceptance means no confirmation request should be inserted even if the original customer text was reservation-shaped.
- Do not treat expanded set components marked `미등록 장비` as all fatal; distinguish them from real top-level generic rows and `모델 선택 필요` blockers.
