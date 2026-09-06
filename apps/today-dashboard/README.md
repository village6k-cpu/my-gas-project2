# Today Dashboard

## Work Orchestrator v2 Heybilli inbox flag

- The authenticated Heybilli owner inbox backed by `work_items_v2` is the default, including when `WORK_ORCHESTRATOR_V2_DASHBOARD_ENABLED` is unset. Set the variable to exactly `0` only for an explicit legacy rollback.
- The v2 `GET /api/follow-ups` inbox and versioned `PATCH /api/follow-ups` actions are available only after the server verifies the Heybilli user session.
- `SUPABASE_SERVICE_ROLE_KEY` is required while the v2 inbox is active. It remains server-only; the browser bundle must not contain it through `NEXT_PUBLIC_*`, direct props, or API responses, and the anonymous key is never a fallback for v2 reads or actions.

## Kakao Hermes automation audit

- The authenticated read-only `GET /api/automation-audit` route backs the fourth `자동처리` tab with immutable `kakao_automation_audit_events` rows. It is separate from `work_items_v2` and exposes no work-item or business mutation action.
- `SUPABASE_SERVICE_ROLE_KEY` is required on the server for this route. The anonymous key is never a fallback, and raw conversations, phone numbers, secrets, model logs, stack traces, and arbitrary receipts are not returned.
- The tab shows only externally proven Kakao Hermes effects and a content-free projection-delay indicator. Audit projection retries never repeat Hermes, GAS, DOM, document, or customer-send work.
