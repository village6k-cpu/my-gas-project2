# Slack follow-up backstop

This replaces the old “DOM watcher creates a task in Slack and also creates the same task on the follow-up board” pattern.

## Intended flow

1. Kakao DOM automation continues to read Kakao, write/auto-send safe replies, and create operational logs.
2. Kakao DOM automation does **not** directly create human follow-up board rows when `AI_WORKER_FOLLOW_UP_ITEMS_ENABLED=0`.
3. Staff continue to work inside Slack with Heybilli.
4. This backstop scans the configured Slack agent channels and creates follow-up-board rows for unresolved Slack tasks.
5. If the Slack thread later contains a completion marker like `완료`, `처리 완료`, `해결`, `done`, or `✅`, the scanner will not recreate that task.

## Run

Dry-run, no Supabase writes:

```bash
cd ~/my-gas-project2
node tools/slack-followup-backstop/slack-followup-backstop.mjs --lookback-hours 720 --max-messages 500
```

Write rows into `ai_follow_up_items`:

```bash
cd ~/my-gas-project2
node tools/slack-followup-backstop/slack-followup-backstop.mjs --write --lookback-hours 720 --max-messages 500
```

## Environment

Loaded from `~/.hermes/.env`, `tools/kakao-dom-bridge/.env`, then this directory's `.env`.

Required for live scan/write:

```env
SLACK_BOT_TOKEN=xoxb-...
SUPABASE_URL=https://...
SUPABASE_SERVICE_ROLE_KEY=...
SUPABASE_FOLLOW_UP_TABLE=ai_follow_up_items
```

Optional:

```env
SLACK_BACKSTOP_CHANNELS=스케쥴-agent,서류발송-agent,정산-agent,재고관리-agent,기타문의
SLACK_BACKSTOP_LOOKBACK_HOURS=720
SLACK_BACKSTOP_MIN_AGE_HOURS=0
SLACK_BACKSTOP_MAX_MESSAGES=500
SLACK_BACKSTOP_MENTION_NAMES=헤이빌리,heybilli,hey billi,빌리
SLACK_BACKSTOP_BOT_USER_IDS=U123,U456
```

## Slack token scopes

The bot needs read access to the scanned channels:

- `channels:read`, `channels:history` for public channels
- `groups:read`, `groups:history` for private channels
- `chat:write` is not required by this scanner; it only reads Slack and writes Supabase.

## Close rule

The scanner intentionally uses an explicit Slack completion marker as the close signal. Staff should leave a short thread reply such as `완료`, `처리 완료`, `해결`, or `✅` after finishing an item.
