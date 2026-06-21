# Village Follow-up Dashboard

Remote web dashboard for Kakao AI worker follow-up items.

## Data flow

Slack is now the source of truth for human follow-up pressure.

- Kakao DOM automation handles Kakao reading, sheet writes, safe replies, and operational logs.
- Kakao DOM automation should run with `AI_WORKER_FOLLOW_UP_ITEMS_ENABLED=0`, so it does not duplicate the same task into Slack and the follow-up board.
- `tools/slack-followup-backstop` scans Heybilli/agent Slack channels for unresolved tasks and writes those safety-net items into Supabase table `ai_follow_up_items`.
- This dashboard reads that table through a server-side Vercel API route, so the Supabase service-role key is never exposed to the browser.

## Required Vercel environment variables

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_FOLLOW_UP_TABLE` optional, default `ai_follow_up_items`
- `DASHBOARD_TOKEN` recommended. If set, the browser must enter this token.

## Slack Agent Workflow

The Kakao AI worker no longer owns the human follow-up board. It may still handle
Kakao/sheet/auto-reply work, but human pressure should converge in Slack first.
The follow-up board is a backstop: `tools/slack-followup-backstop` scans Slack
for unresolved Heybilli/agent-channel tasks and upserts those rows into
`ai_follow_up_items`.

Keep the direct Kakao→Slack/board duplicate paths off in normal operation:

- `AI_WORKER_FOLLOW_UP_ITEMS_ENABLED=0`
- `SLACK_FOLLOW_UP_ENABLED=0`
- `SLACK_AGENT_CARD_DELIVERY_ENABLED=0`

Channel defaults scanned by the Slack backstop:

- `스케쥴-agent`
- `서류발송-agent`
- `정산-agent`
- `재고관리-agent`
- `기타문의`

Local bridge / worker env:

- `AI_WORKER_FOLLOW_UP_ITEMS_ENABLED=0`
- `SLACK_FOLLOW_UP_ENABLED=0`
- `SLACK_AGENT_CARD_DELIVERY_ENABLED=0`
- `SLACK_BOT_TOKEN`
- `SLACK_AGENT_MENTION=헤이빌리`
- `SLACK_CHANNEL_SCHEDULE_AGENT=스케쥴-agent`
- `SLACK_CHANNEL_DOCUMENT_AGENT=서류발송-agent`
- `SLACK_CHANNEL_SETTLEMENT_AGENT=정산-agent`
- `SLACK_CHANNEL_OTHER_AGENT=기타문의`
- `SLACK_DASHBOARD_URL=https://village-follow-up-dashboard.vercel.app`
- `SLACK_ACTION_POLL_ENABLED=true`

Slack button handling:

- The live Hermes Slack app runs in Socket Mode, so `village_followup_*` button
  events are handled inside Hermes and forwarded to the local bridge at
  `http://127.0.0.1:8787/slack/actions`.
- `scripts/kakao-automation start` and `scripts/kakao-automation check` apply
  the local Hermes Socket Mode patch idempotently.
- The Vercel `/api/slack-actions` route remains available only for a future
  HTTP-interactivity Slack app setup.

Optional Vercel env for the HTTP-interactivity fallback:

- `SLACK_SIGNING_SECRET`
- `SLACK_BOT_TOKEN`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_FOLLOW_UP_TABLE`

Set the Slack app Interactivity Request URL to:

```text
https://village-follow-up-dashboard.vercel.app/api/slack-actions
```

The `전송` and `수정 후 전송` buttons do not expose the local Mac bridge to the
internet. Vercel writes a pending Slack action to Supabase, and the local bridge
polls rows whose `payload.slack_action.status` is `pending` to perform the
actual Kakao send. The optional Slack columns in the SQL file are only a future
query/index optimization; the live path works through the existing `payload`
JSONB column.

## Deploy

```bash
cd apps/follow-up-dashboard
npm install
npx vercel link --yes --project village-follow-up-dashboard --scope village2
npx vercel env add SUPABASE_URL
npx vercel env add SUPABASE_SERVICE_ROLE_KEY
npx vercel env add SUPABASE_FOLLOW_UP_TABLE
npx vercel env add DASHBOARD_TOKEN
cd ../..
VERCEL_ORG_ID=team_c5g0hY4e26h7Aha85tslGSRr VERCEL_PROJECT_ID=prj_SdM8O4GD0914xxH0b9nUvkuJ3lc2 apps/follow-up-dashboard/node_modules/.bin/vercel --prod --yes --scope village2
```

The Vercel project has `apps/follow-up-dashboard` as its Root Directory. Run
production deploys from the repository root with the explicit project id above;
running `vercel --prod` from inside `apps/follow-up-dashboard` makes Vercel look
for `apps/follow-up-dashboard/apps/follow-up-dashboard`.

## Local check

```bash
npm run check
```

## Security notes

Do not put the Supabase service-role key into `index.html` or any public client-side file. It belongs only in Vercel environment variables and local `.env` files.

## Operations

Full operating notes, Supabase SQL steps, smoke test, and troubleshooting are in
`docs/kakao-automation-followup-dashboard-ops.md`.
