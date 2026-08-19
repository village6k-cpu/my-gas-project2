# Kakao worker timeout → Slack follow-up delivery guard

Use when a Kakao DOM watcher / AI browser worker job times out, is replayed by recovery, or the user reports that an actionable Kakao issue sat in follow-up state without a Slack alert.

## Failure pattern observed

- DOM watcher and bridge health can both be green (`workerLive=true`, `followUpRowsEnabled=true`, `slackCardDeliveryEnabled=true`, token present), but a timeout path may still only write an `ai_follow_up_items` row and never call Slack delivery.
- In the bridge, check timeout/error paths separately from successful AI-worker paths. The successful path usually calls `deliverSlackFollowUpRows`; a failure helper such as `createWorkerFailureFollowUp()` may only call `upsertFollowUpRows()`.
- Symptoms:
  - Supabase `ai_processing_events.payload.ai_worker_result.failure_follow_up` exists.
  - `ai_follow_up_items` has an open row, often urgent/reservation_review/reply_needed.
  - `payload.slack_delivery` is null and no Slack channel card appears.

## Debugging checklist

1. Verify live state, not assumptions:
   - `scripts/kakao-automation status`
   - Confirm `workerLive`, `followUpRowsEnabled`, `slackCardDeliveryEnabled`, `slackBotTokenPresent`, and channel map.
2. Query Supabase for the customer/room:
   - `ai_processing_events`: latest `status`, `preview_text`, `error_message`, `payload.ai_worker_result`.
   - `ai_follow_up_items`: open rows, `payload.slack_delivery`, status.
3. Verify actual business state in GAS/Sheets:
   - `계약마스터` by customer/phone/거래ID.
   - `스케줄상세` by 거래ID.
   - `확인요청` by customer and 거래ID to ensure no stale pending RQ remains.
4. If the business action is already complete, close stale open follow-up rows and mark obsolete ready/processing recovery events as superseded so the sweeper does not replay old work.

## Fix pattern

- Import and call Slack delivery in the bridge failure path:
  - `import { deliverSlackFollowUpRows, ... } from '../ai-browser-worker/worker.mjs'`
  - Extend `followUpConfig()` to include `slackFollowUpEnabled`, `slackThreadFollowUpsEnabled`, `slackBotToken`, and `slackChannels`.
  - After `upsertFollowUpRows(followUpConfig(), [row])`, if Slack delivery is enabled and rows exist, call `deliverSlackFollowUpRows(followUpConfig(), upsertResult.rows)`.
  - Catch delivery errors and append an explicit NDJSON error such as `worker_failure_followup_slack_delivery`.
- Expose health fields for this path: follow-up row gate, Slack card gate, token presence, and channel map.

## Verification

- Add/keep a static regression test that asserts failure follow-ups are delivered to Slack, not only inserted into Supabase.
- Run targeted test first, e.g. `node --test test/slack-follow-up-actions.static.test.js`.
- Restart the bridge: `scripts/kakao-automation restart`.
- Run `scripts/kakao-automation status` and confirm the health gates.
- Re-query Supabase: no stale open customer follow-up rows; latest relevant event has completed/skipped status with a business reason.
- Use broad `scripts/kakao-automation check` only as a wider signal; existing UI/mock tests may fail for unrelated reasons, so do not block this specific fix if the targeted Slack delivery test and live checks pass.
