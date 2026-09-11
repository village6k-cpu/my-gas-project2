# Inventory risk alerts implementation plan

**Goal:** Detect conflicts and operational risks across today's and every future registered booking, including noncanonical equipment names, and notify the existing 업무지시 Slack channel promptly.

**Architecture:** Extend the existing GAS inventory diagnostics with one pure snapshot evaluator and an independently scheduled notifier. Read registered schedules, set components and physical stock in bulk; use ledger equipment IDs and existing aliases for identity. Exact arithmetic remains deterministic. Unresolved identities remain visible risks with candidates rather than disappearing from the scan or being silently merged. The existing operations page consumes the same report. Existing booking and pricing decisions remain unchanged.

**Tech stack:** GAS V8, Script Properties, installable triggers, Slack Web API, existing Supabase equipment ledger aliases, Next.js operations view.

## Constraints

- Today onward has no 48-hour or 90-day cutoff. Unrecorded historical returns are explicit uncertainty; they do not create invented definite overlaps with every future booking. Live inspection found 73 historical trades with missing return completion.
- Use half-open time intervals. A single booking can exceed stock. Zero stock is zero; subtract known maintenance.
- Avoid counting an expanded set header and its components twice. Header-only sets expand from the current set master. Missing/inconsistent schedule dates, quantities, stocks, or model identity are risks, never a clean report.
- Resolve formatting differences and existing unambiguous aliases; preserve model numbers/generations. No speculative catalog or price writes.
- Notify new/worsening risks concisely with equipment, time, shortage, bookings and a detail link. Suppress unchanged alerts; preserve failed delivery for retry and avoid blind replay after uncertain sends.
- Trigger a scan after relevant mutations, coalesce bursts, and use an independent one-minute heartbeat to recover missed triggers. Do not block booking locks or stop Kakao/Hermes/Chrome.
- Pending preference: turnaround risk threshold (prepared default 60 minutes; user may change it).

## Implementation and verification

- [x] 1. Write failing behavior tests for quantity/time/alias/set/overdue/invalid-data boundaries. Implement `inventoryRisk.js` evaluator and test real-data fixtures.
- [x] 2. Implement bulk GAS snapshot, cached ledger aliases, shared read report and backward-compatible `getInventoryConflicts`. Verify actual column headers, no mutations during reads.
- [x] 3. Write notifier state-machine tests. Implement durable claim, delivery receipt/readback, retry and dedup; prepare heartbeat and coalesced mutation hooks.
- [x] 4. Adapt the existing operations view to display conflicts and unresolved risks from the shared report without silently truncating future coverage.
- [ ] 5. Run relevant regression, full static, app tests/build. Integrate/deploy with existing workflow, configure token privately, run a real scan and validate Slack readback plus subsequent suppression. Preserve current runtime and prices.

## Initial findings

`getInventoryConflicts` currently skips single-booking shortages and unknown names. `getOperationsData_` groups reservations per date for 90 days, ignores maintenance and unknown names, and therefore differs from true concurrent use. The operations UI filters out all non-conflict risks. Existing ledger aliases provide grounded mappings independent of sales prices.

## Verification and operating contract

- Live read: 11,191 schedule rows, 467 set rows, 281 equipment rows, 1,205 contracts. A local read-only replay completes in about 0.5 seconds after input collection. Future horizon currently reaches November 10; no artificial date cutoff.
- Four definite scheduled shortages found in the preview; historical missing return flags remain warnings. Unknown names are grouped with all source bookings retained, preserving model numbers and generations.
- Large reports exceed the 100 KB per-cache-value limit. Versioned chunks prevent repeated full scans and reject partial cache entries.
- 21 new evaluator/delivery/cache tests, operations/register regression checks, and production UI build pass. Two unrelated root-suite failures also reproduce on unmodified main: discount code-text assertion and the old Windows gateway dependency assertion. The WSL bash-path failure is resolved by using the configured Git Bash PATH; route tests pass after installing the feature app dependencies.
- Notifications use the existing 업무지시 channel. `setupInventoryRiskMonitor` receives the bot token through the authenticated internal POST API and stores it only in Script Properties. No customer messages, price changes, catalog changes, or booking writes.
- One-minute independent trigger plus coalesced mutation scans; no network in booking locks. Slack posts are claimed durably and verified through channel history before advancing the baseline. Uncertain requests are reconciled before retry. The operations page exposes disabled, delayed and failed notification status.
- Runtime limits: Google trigger scheduling and external API availability can delay delivery; the UI reports a monitor more than three minutes late. Evidence cannot resolve unknown equipment or unrecorded returns without source corrections.
- Deployment verification artifacts are retained under `C:/Village/tmp/inventory-risk-0912/` (no tokens).

References: [Slack postMessage](https://docs.slack.dev/reference/methods/chat.postMessage/), [Google installable triggers](https://developers.google.com/apps-script/guides/triggers/installable).
