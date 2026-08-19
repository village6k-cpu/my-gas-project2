# Kakao preview-only reservation drop guard

Use this when a Kakao reservation inquiry is missing from `확인요청`, `스케줄상세`, and follow-up cards even though the DOM watcher/AI worker appears to have processed the chat.

## Failure pattern observed

- Kakao DOM bridge created a job from a chat-list preview.
- AI worker could not open or match the actual Kakao conversation (`matching Kakao conversation not opened/found`, `preview-only`, `chat_row_not_found`, etc.).
- Worker exited normally with `should_write_to_sheet=false` and no `followUpResult.inserted` rows.
- Because it was a completed worker, the existing failure-follow-up path did not fire.
- Result: a real reservation request silently disappeared from both `확인요청` and Slack follow-up surfaces.

## Required triage

1. Extract the customer name, both possible phone readings, periods, and equipment from the screenshot/source.
2. Search `확인요청`, registered schedule/contract, and worker logs by:
   - customer name
   - all phone variants (digit transpositions are common in OCR/parser paths)
   - distinctive text such as `전체 스케줄 가능`, `견적서`, or equipment names
3. If a stale/generic RQ exists (for example `1일 구성 장비` or wrong phone), mark it `보류` rather than registering it.
4. Rebuild complete `확인요청` rows from the verified source. Use the screenshot/source phone as primary, but note any conflicting parser/log phone in R/Q or the staff report so a human can verify contact before customer-facing sends.
5. Run availability and read back the new RQ rows. Do not register when availability shows actual shortages/collisions; report them to `스케쥴-agent`.

## Durable code guard

In `tools/kakao-dom-bridge/server.mjs`, do not rely only on thrown worker errors/timeouts. After a worker completes, parse stdout and escalate to a human-review follow-up when all of these are true:

- the preview has actionable business signals (`예약`, `대여`, `가능`, `견적`, equipment names, etc.);
- `decision.should_write_to_sheet !== true`;
- no sheet write succeeded;
- no follow-up row was inserted;
- decision reason or customer chat status says the Kakao room was not opened/found or the result was preview-only.

The completed-skip follow-up should call the same `createWorkerFailureFollowUp()` path used for errors/timeouts and append a diagnostic NDJSON entry (e.g. `worker-completion-followups.ndjson`). This turns silent preview-only drops into `스케쥴-agent` review cards.

## Reporting shape

Keep the user-facing report short and explicit:

- `원인:` preview-only/open-failure completed without follow-up
- `복구:` new RQ IDs and periods
- `보류:` stale/wrong RQ IDs
- `주의:` availability blockers and phone mismatch
- `재발방지:` completed worker skip now escalates to human review
