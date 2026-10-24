# Incident side-effect repair

Scope approved by the user: restore the original automation and repair side effects without replaying completed business writes, sending customer/Slack messages, or changing unrelated prices/models/settings.

## Proven failures and implementation
- A successful source correction was followed by a projection with an older dashboard-cached contract URL. Build projection financial fields from the existing forceFresh, scoped contract-ledger reader (Spreadsheet only); never derive price. Keep dirty and structure tasks when financial authority is unavailable, and refuse partial full-sync completion before HTTP.
- Reopening the historical gateway queue can mutate expired claims, apply pending results, retry reserved operations, or consume 183 undelivered notices. An optional queue-scoped manifest validates exact risk job hashes before initialization and freezes all jobs created before a cutoff. Preserve old bytes, exact-event dedupe and room revision authority; new higher revisions remain eligible. Never mark an unsent notice delivered.
- During this recovery only, hold startup background import/retry/delivery, manual POST and document delivery; normal configuration without a manifest retains existing behavior. Public health separates eligible execution counts from historical totals.

## Validation and execution order
1. Financial authority, structure task retention and terminal-notice regressions reproduced RED then GREEN. Invalid manifest and repeated failed initialization tests fail closed. Full bridge tests 397 pass. Independent reviewer approved implemented source scope after fixes.
2. Run all root tests and official finishbranch/integrate, retaining existing deployment URL. No historical mutation or repeated completed operation is part of deployment.
3. Reconcile exact runtime differences with three-way preservation, including existing registration retry and capture recovery changes. Validate held retry hooks and startup/health before process transition.
4. Re-read Kim Jaewoo source/receipts and project the latest already-corrected source once with a new projection fence, then independently verify period, amount, URL and all physical/item fields.
5. Restore guarded new-event source → model/tools → durable receipt → authority path. Preserve healthy Chrome and collector until replacement is validated. Leave recurring Codex automation paused.

Runtime transition and complete live-path proof are separate requirements; source deployment alone does not mean the incident is complete. Exact historical per-account quota attribution remains unknown. Own recovery contribution is not excluded; the separately deployed807 fix removes proven UI-only HTTP amplification from recovery projections.
