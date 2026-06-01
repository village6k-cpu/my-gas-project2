# Village Follow-up Dashboard

Remote web dashboard for Kakao AI worker follow-up items.

## Data flow

Kakao AI worker writes AI-decided `follow_up_items` to Supabase table `ai_follow_up_items`.
This dashboard reads that table through a server-side Vercel API route, so the Supabase service-role key is never exposed to the browser.

## Required Vercel environment variables

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_FOLLOW_UP_TABLE` optional, default `ai_follow_up_items`
- `DASHBOARD_TOKEN` recommended. If set, the browser must enter this token.

## Slack Agent Workflow

The Kakao AI worker can post each follow-up item to Slack as an actionable work
card. The dashboard remains the status board, while Slack becomes the primary
work inbox.

Channel defaults:

- `reservation_review`, `schedule_check`, `sheet_duplicate_check`: `스케쥴-agent`
- `quote_send`, `tax_invoice`, `contract_document`, `price_review`: `서류발송-agent`
- `payment_check`: `정산-agent`
- everything else: `기타문의`

Local bridge / worker env:

- `SLACK_FOLLOW_UP_ENABLED=1`
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
