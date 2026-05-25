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

## Deploy

```bash
cd apps/follow-up-dashboard
npm install
npx vercel
npx vercel env add SUPABASE_URL
npx vercel env add SUPABASE_SERVICE_ROLE_KEY
npx vercel env add SUPABASE_FOLLOW_UP_TABLE
npx vercel env add DASHBOARD_TOKEN
npx vercel --prod
```

## Local check

```bash
npm run check
```

## Security notes

Do not put the Supabase service-role key into `index.html` or any public client-side file. It belongs only in Vercel environment variables and local `.env` files.

## Operations

Full operating notes, Supabase SQL steps, smoke test, and troubleshooting are in
`docs/kakao-automation-followup-dashboard-ops.md`.
