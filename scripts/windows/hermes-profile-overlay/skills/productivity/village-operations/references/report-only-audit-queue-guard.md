# Report-only audit routing guard

Use for Village Daily 감사 / 일일 점검 / 감사 보고 / 요약 / all-clear / 자동화 점검 automations.

## Production intent

These automations exist only to surface information the owner may have missed. They are not workflow intake, not task triage, and not a distribution fan-out.

Correct behavior:

1. Send the report to the existing Kakao group room only (`desktop` / 단톡방).
2. Do not create Supabase `operation_tasks`, `ai_follow_up_items`, or other 큐카드 for the report itself.
3. Do not create task notifications or Slack agent-channel alerts for report-only outputs.
4. Do not duplicate the report into Slack report channels, Slack agent channels, category-specific channels, or Event API 1:1 messages.
5. Do not classify the report sections into separate agent queues just because they mention 재고/정산/스케줄/오류.
6. Only create or keep a task when there is a separate real follow-up work item that is not merely the audit report itself.

## Implementation checks

- `report-delivery` routine/default audit routing should resolve to `desktop` only.
- If configured channels include `slack` or `event`, report-only audit detection should remove them and fall back to `desktop` only.
- Daily/unregistered/audit scripts should not Slack-fallback on report delivery failure; failure should be surfaced as a delivery failure, not silently rerouted to Slack.
- The DOM watcher / queue-card router must behave like a live watcher, not a delayed batch dump. If many task notifications suddenly arrive at one timestamp (for example 05:02), investigate cron/backfill/replay before assuming the task classifier is working: check recent scheduler/cron runs, watcher last-seen cursors, pending queue rows created earlier than the Slack message timestamp, and whether a process restart replayed old open tasks. The expected design is “classify and route new 큐카드 as they appear,” not “flush all accumulated cards once a daily job wakes up.”
- If the user reports “자동화 보고가 안 온다” at the same time as a Slack task flood, treat it as two coupled symptoms: the report-only delivery path may be blocked/misrouted while the follow-up/task path is still flushing. Verify the Kakao 단톡방 report delivery separately from Slack queue delivery; do not infer report success from Slack activity.
- Operation-task creation should skip report-only audit payloads with a successful `skipped` result rather than writing a queue card.
- Guard both manual/RPA task creation and conversation/intake task creation. In `village-kakao-ai`, the durable pattern is to detect report-only text (`daily-audit`, `Daily 감사`, `일일 점검`, `감사 보고`, `정기 보고`, `자동화 보고`, `채널별 분류`, `all-clear`) before Supabase writes and return `reason: "report_only_no_queue_card"` without any REST call.
- In `C:/Village/runtimes/my-gas-project2-production/tools/ai-browser-worker/worker.mjs`, guard both sides of follow-up handling:
  - before `upsertFollowUpRows`, filter rows whose `source` is `daily_audit` / `automation_audit`, whose title/summary contains `Daily audit` or 자동화 감사/점검/보고 wording, or whose payload has keys like `daily_audit_YYYYMMDD` / `runtime_audit`;
  - before `deliverSlackFollowUpRows`, apply the same filter and return a skipped result such as `reason: "automation_audit_rows"` when no deliverable rows remain.
- Keep a regression test in `tools/ai-browser-worker/worker.test.mjs` proving Daily audit rows do not call Slack `chat.postMessage`, Slack `chat.update`, Supabase PATCH, or Supabase POST.
- If old `daily-audit-*` report cards already exist in open queues, mark them `ignored` with an approval reason explaining `report_only_no_queue_card`; verify the active list no longer returns `daily-audit-` tasks.

## Slack cleanup checks for accidental report cards

When the user asks to delete already-posted automation-report Slack cards:

1. Search likely agent channels for report-card markers such as `follow_up_id=`, `Daily audit 후속처리`, `Daily audit worker`, and visible Korean report-task titles.
2. Delete only Hermes/헤이빌리 bot-authored messages unless the user explicitly granted broader admin deletion scope.
3. After deletion, rerun the exact same searches and report `remaining_count: 0` or the exact remaining count.
4. Do not delete the intended Kakao group-room report; only clean unintended Slack/agent-channel duplicates.

## Related routing guard

For live DOM watcher follow-up cards, see `references/follow-up-slack-routing-guards.md`. In particular, do not let internal lookup evidence such as `계약마스터 조회` hijack a reservation/schedule card into `서류발송-agent`; broad keyword routing over full evidence text is unsafe.

## Common pitfall

Do not confuse “단톡방 보고는 해야 함” with “send to every operational channel” or “classify the report into tasks.” The intended flow is a single owner-visible group-room report, avoiding duplicate information in Slack/agent channels, task notifications, and queue boards.

The user is especially sensitive to this: if they say “내가 몇번 말해” / “태스크를 아예 만들 필요가 없어,” immediately fix the routing and cleanup, not just acknowledge it.