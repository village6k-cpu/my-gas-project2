# Two-week Kakao schedule recovery

Use when the user reports that many Kakao reservations may have been missed and asks for the last 1–2 weeks to be audited quickly.

## Scope and sources

Work from `my-gas-project2` and treat this as an operational recovery, not a normal single RQ entry.

Primary evidence:

- Kakao DOM bridge queue files under `tools/kakao-dom-bridge/queue/`:
  - `worker-results.ndjson`
  - `worker-failure-followups.ndjson`
  - `worker-completion-followups.ndjson`
  - `worker-skipped.ndjson`
  - `jobs.ndjson`
- Live GAS/sheet readbacks:
  - `확인요청`
  - `계약마스터`
  - `스케줄상세`
  - public `거래내역` CSV for ledger/contract-link verification
- `dashboardSearch` with `summary=1&profile=1` to verify that recovered trades appear on the dashboard. Note: the response shape is `checkout`/`checkin` plus `total`; it may not have a `results` array.

## Fast classification

For every `확인요청` group in the date window whose O/P columns are blank:

1. Rerun `action=확인&reqID=...` before any registration.
2. Classify:
   - **Safe register**: required customer/phone/period present; no `모델 선택 필요`; no hard `겹침/가용0`; only non-blocking component `미등록 장비` warnings.
   - **Existing-trade reflected**: logs/RQ show the request was later merged into or manually added to an existing `거래ID`; mark the RQ group registered against that existing trade instead of creating a duplicate trade.
   - **Existing-trade needs add-on**: a pending RQ contains extra top-level items beyond a registered trade for the same customer/period. Add only the missing top-level items with `scheduleAddEquips` after dry-run; then mark the RQ group against the existing trade.
   - **Hold**: model-selection, true stock collision, top-level 미등록, 보류, ambiguous/preview-only evidence, or old past-period with no strong proof of actual rental.
3. Register safe existing RQs with `action=등록&reqID=...`.
4. Verify each mutation with all of:
   - `확인요청` search: N=`등록`, O=`등록완료...`, P=`거래ID`
   - `계약마스터` search by 거래ID
   - `스케줄상세` search by 거래ID
   - `dashboardSearch&q={거래ID}&summary=1&profile=1`
   - `거래내역` CSV row exists for newly created trades

## Existing-trade / add-on pattern

If a later RQ duplicates an already-registered trade but includes additional top-level requested items:

1. Verify the existing trade's current top-level rows with `dashboardSearch` or raw `스케줄상세`.
2. Compare against the RQ top-level rows only; ignore expanded component rows for add-on decisions.
3. Run `scheduleAddEquips&dryRun=true` for missing top-level items.
4. If dry-run passes, run live `scheduleAddEquips`.
5. Update every row in that RQ group:
   - N=`등록`
   - O=`등록완료(기존거래 {거래ID} 보강)` or similar
   - P=`{거래ID}`
6. Verify dashboard and raw schedule. Beware that `scheduleAddEquips` may queue contract regeneration rather than immediately creating a new contract URL.

Example recovery class:

- A pending RQ for the same customer/period had a BURANO reservation already registered with only the first two top-level items. The correct recovery was to add missing top-level items to the existing trade, not register a duplicate RQ as a new trade.

## Pitfalls

- Do not treat blank O/P on `확인요청` as automatically safe: many rows are held because of model selection, true collisions, or top-level master-data gaps.
- Do not register a stale RQ if logs show the customer backed out or staff only asked for more info.
- For already reflected add-ons (e.g. a one-item RQ that was manually added to a trade), mark the RQ against the existing trade instead of re-registering it.
- `dashboardSearch` summary responses use `checkout`/`checkin`; a script that only inspects `results` will falsely report zero matches.
- `계약마스터` date cells may display as datetime objects while `스케줄상세` has the correct date/time strings; verify schedule rows for operational times.
- New direct registrations may create `거래내역` rows and contract links; existing-trade add-ons may leave `contractRegenPending=true`, so report pending regeneration separately instead of claiming a fresh contract was produced.

## Report shape

Keep the user reply short and urgent:

- `등록 완료`: new 거래ID list
- `기존거래 보강`: 거래ID and items added/marked
- `남은 보류`: only blockers and why they were not mutated
- `검증`: sheets/dashboard/ledger checked
