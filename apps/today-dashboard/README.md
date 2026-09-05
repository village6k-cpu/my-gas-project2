# Today Dashboard

## Work Orchestrator v2 Heybilli inbox flag

- `WORK_ORCHESTRATOR_V2_DASHBOARD_ENABLED=1` enables the authenticated Heybilli owner inbox backed by `work_items_v2`. The default is off when the variable is unset or any other value.
- The v2 `GET /api/follow-ups` inbox and versioned `PATCH /api/follow-ups` actions are available only after the server verifies the Heybilli user session.
- `SUPABASE_SERVICE_ROLE_KEY` is required whenever that flag is enabled. It remains server-only; the browser bundle must not contain it through `NEXT_PUBLIC_*`, direct props, or API responses, and the anonymous key is never a fallback for v2 reads or actions.
