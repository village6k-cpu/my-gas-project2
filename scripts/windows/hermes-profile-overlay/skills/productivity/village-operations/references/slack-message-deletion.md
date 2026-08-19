# Slack message deletion for Village automations

Use this note when the user wants Hermes/헤이빌리 to clean up incorrect Village automation reports or asks how to give Hermes deletion powers in Slack.

## Capability model

Slack deletion requires two separate things:

1. Slack app permissions that allow reading the target channel history and calling `chat.delete`.
2. A Hermes-exposed tool/workflow that searches candidate messages, presents a dry-run list, and then deletes by channel + message timestamp after explicit approval.

Do not tell the user Hermes can delete Slack history merely because the Slack app can post messages. Posting (`chat:write`) is not enough; the agent needs both Slack API scopes and an actual deletion/search tool surfaced to the model.

## Practical limits

- A normal bot token can reliably delete messages posted by that same bot/app.
- Deleting human messages or other bots' messages usually requires workspace/admin-level capabilities and may be blocked by Slack policy.
- Private channels require the bot to be invited and to have `groups:*` scopes.
- Public channels require `channels:*` scopes.
- Bot scopes changed in Slack must be followed by **OAuth & Permissions → Reinstall to Workspace** or the existing token will not gain the new scopes.

## Minimum useful bot scopes

For public channels:

- `chat:write`
- `channels:history`
- `channels:read`

For private channels too:

- `groups:history`
- `groups:read`

Existing Hermes/Village Slack setups may already include additional useful scopes such as `im:history`, `im:read`, `im:write`, `chat:write.public`, `files:read`, and `files:write`.

Pitfall: if channel-name resolution calls `conversations.list` with `types=public_channel,private_channel,im,mpim` but the token lacks `mpim:read`, Slack returns `missing_scope needed=mpim:read` even when the target is a normal channel. For channel cleanup tools, default `types` to `public_channel,private_channel` unless DM/MPIM cleanup is explicitly required.

## Safe deletion workflow

1. Resolve target channels explicitly; do not use broad workspace-wide deletion by default.
2. Search/collect candidate messages with `conversations.history` and, for threads, `conversations.replies`.
3. Filter narrowly:
   - bot/app author only, unless the user explicitly requests admin cleanup and the token supports it
   - keyword/report type, e.g. `Daily`, `감사`, `점검`, `요약`, `자동화 보고`
   - date/time range
   - exclude the Kakao group-room intended destination; the user wants Daily/감사/점검/요약 reports only there.
4. First run as dry-run and report count + channel names + sample timestamps/text snippets.
5. Delete only after explicit approval, using `chat.delete(channel=..., ts=...)`.
6. Immediately verify by rerunning the same find query and reporting remaining count per channel.
7. Report deleted count and any Slack API failures (`message_not_found`, `cant_delete_message`, `missing_scope`, `not_in_channel`, rate limits).

## Hermes implementation shape

Prefer a class-level Slack cleanup/admin tool rather than one-off scripts. Useful tool affordances:

- `slack_find_messages(channel, keywords, since, until, include_threads=false)`
- `slack_delete_messages(channel, ts_list, dry_run=true)`
- `slack_delete_bot_reports(channels, keywords, since, until, dry_run=true)`

Safety defaults:

- `dry_run=true`
- only delete messages authored by the configured Hermes/헤이빌리 bot
- require channel + keyword + time bounds for bulk deletion
- never delete customer-facing or financial records without an explicit approval gate

## Current local Hermes implementation note

In the default profile source checkout, this workflow was implemented as a `messaging` tool named `slack_message_admin` with tests under `tests/tools/test_slack_message_admin_tool.py`. It supports:

- `action=list_channels`
- `action=find` with `channel`, `keywords`, optional `oldest`/`latest`, `include_threads`
- `action=delete`, which defaults to `dry_run=true` and requires `confirm_text='DELETE_BOT_MESSAGES'` for destructive deletion

Validation pattern used successfully:

1. Run dry-run across non-Kakao Slack agent channels using keywords like `Daily`, `감사/점검`, `자동화 보고`.
2. Ask for explicit deletion approval with counts by channel.
3. Delete with `dry_run=false` + confirmation text.
4. Rerun `find` on the same channel/keyword set and confirm remaining count is zero.

For Village Daily/감사/점검 cleanup specifically, the non-Kakao Slack agent channels commonly include `재고관리-agent`, `정산-agent`, `스케쥴-agent`, `기타문의`, `agent-전화문의`, and `서류발송-agent`; the intended Kakao 단톡방 report itself is out of scope for Slack deletion.
