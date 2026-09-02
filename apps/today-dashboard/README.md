# Today Dashboard

## Work Orchestrator v2 dashboard read flag

- `WORK_ORCHESTRATOR_V2_DASHBOARD_ENABLED=1` enables the authenticated staff read surface for `work_items_v2`. The default is off when the variable is unset or any other value.
- `SUPABASE_SERVICE_ROLE_KEY` is required whenever that flag is enabled. It must remain server-only and must never be exposed through a `NEXT_PUBLIC_*` variable or replaced by the anonymous key.
