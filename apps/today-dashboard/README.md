# Today Dashboard

## Work Orchestrator v2 Heybilli inbox flag

- The authenticated Heybilli owner inbox backed by `work_items_v2` is the default, including when `WORK_ORCHESTRATOR_V2_DASHBOARD_ENABLED` is unset. Set the variable to exactly `0` only for an explicit legacy rollback.
- The v2 `GET /api/follow-ups` inbox and versioned `PATCH /api/follow-ups` actions are available only after the server verifies the Heybilli user session.
- `SUPABASE_SERVICE_ROLE_KEY` is required while the v2 inbox is active. It remains server-only; the browser bundle must not contain it through `NEXT_PUBLIC_*`, direct props, or API responses, and the anonymous key is never a fallback for v2 reads or actions.
