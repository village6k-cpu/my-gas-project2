# Nine-customer registration incident, 2026-10-14

Scope: 노사무엘, 정재하, 권승주, 정현호, 황윤서, 이재경, 하현준, 강유광, 유명환. Live Kakao conversations were inspected sequentially and compared with GAS requests/contracts/schedules. No customer messages were authorized or sent by recovery. Contact details and credentials are excluded from this report.

## Proven causes

- The confirmed component selection/projection accepted only autocomplete `목록`, while the model's authoritative inventory lookup correctly found equipment in `장비마스터`. A reader-name mismatch therefore blocked the entire approved camera booking.
- Confirmed replacement omitted `장비명원문보존`, so fuzzy matching silently shortened an option-qualified filter name. The exact final-plan fence correctly rejected that altered plan, but left a replacement RQ unregistered.
- Live root registration instructions and a directly linked reference reintroduced a catalog prerequisite. A baseline consumer refused approved raw demand; repaired guidance preserved it and separated supply/price work. The worker also needed an explicit reminder that checked RQ, answered reply and quoted price are not schedule registration.
- Dashboard structure repair had no supported exact removal-projection recovery. An already successful GAS deletion could therefore remain active in the app; a general upsert intentionally cannot prune missing rows because it would risk unrelated additions.

## Verified recovery ledger

| Customer | Current evidence and recovery |
|---|---|
| 정재하 | RQ-261013-024 -> 261014-003; FX3 body set and Ace M, 10/14 20:00–10/15 20:00, 7 rows. Receipt 202e6b02-467d-422c-94c2-1a3c91f30f6a. |
| 하현준 | RQ-261013-016 -> 261014-004; A7S3, 600X with 젬볼90, 70–200, plus original photo-demand placeholder preserved; 10/15 09:00–21:00, 12 rows. Receipt eea7a93e-64bd-4b0d-a83b-a8bdd01bd99b. Exact photo models/prices remain unresolved, not free. |
| 권승주 | RQ-261013-029 -> 261014-005; F6 with included memory/bag, 2 rows. Receipt 3bbd256e-15a0-4542-9a35-a7f8c42c39ea. Immediately corrected final pickup to 10/14 14:30, return22:00; exact GAS and app period verified. Output-channel fault warning remains operational follow-up. |
| 정현호 | RQ-261013-008 -> 261014-006; all 9 approved top-level demands retained, 18 rows including raw 씨붐2, 오토폴3500 1, 메슬리니대2 pending price. Receipt 7c5ec19a-dce1-4211-acd3-d4430525e852. Corrected exact interval to 10/16 11:30–10/19 11:30. Combo photo confirmation and stock/softbox allocation remain follow-up. |
| 황윤서 | Missing first period RQ-261013-003 -> 261014-007, fog and spotlight, 2 rows. Receipt 8f0a0276-06be-4174-bf04-6f3fa4d85c24. Corrected pickup to 10/24 09:10, return10/25 08:00. Existing second period 261013-002, 10/23 02:20–10/25 23:50, retained without replay. Spotlight price pending. |
| 유명환 | Missing Solidcom RQ-261012-003 -> 261014-008, 10/13 08:00–10/14 22:00, using actual Slack staff checkout/payment evidence 1791799702.984829 plus exact live Kakao request. Original lens trade 261008-001 corrected to approved 10/11 22:00–10/12 22:00 while preserving 반납완료. |
| 이재경 | Source excludes requested up-ring; replacement RQ-261013-018 contains 6 final top-level items. Recovery with original operation53b6eaf1-5fe9-4a55-98e8-4cc4d1bc5d65 is pending final readback at this report revision; option-qualified raw filter name must be preserved. |
| 노사무엘 | Existing 261008-003 already corrected by worker to10/14 13:00–10/22 13:00 and24–70 removed in GAS. Durable receipt ed5c26b9-5897-4785-93c9-9d7ae883e804 proves11 rows. App row261008-003-08 still active/untaken; exact projection-only recovery pending. Current shop checkout report confirms16–35/28–135 and V batteries2; BP interpretation/supply not invented. |
| 강유광 | Existing260831-014 contains original cart and already-applied UWP-D21×3. Later16:00 full-cart revision remains separate RQ-261001-001. Latest10/13 젬볼/F21C×2 requests have no subsequent staff confirmation in inspected room; not silently treated as accepted. Full pending-plan reconciliation remains open at this report revision. |

## Exact removal projection recovery contract

Internal authenticated POST `repairTradeProjection` may include `removedScheduleIds:["YYMMDD-NNN-NN"]` only after the caller has reconciled the original completed deletion and current source state. This is an app projection repair, not a repeat sheet deletion. Never submit a broad keep-set or infer all missing rows should be deleted. The server rejects malformed/cross-trade/duplicate IDs, remote authority failure, checkout-started/returned trades, and IDs currently present in the sheet (rechecked under structural lock). Existing taken-quantity protection remains in the projection worker. Completion still requires a fresh app/DB readback; queued does not mean completed.

## Verification / deployment

- Core catalog/name repair: 3 observed failing tests -> passing; strict-dropdown integration cases: 2 observed failures -> passing. Independent review36/36 passed and linked-reference contradiction fixed.
- First full run had four Windows shell-resolution failures, not silently ignored: `ci-deploy-current-head`3 and `gas-version-budget`1. Rerunning those suites with actual Git Bash on PATH passed7/7. The main integration then ran the entire root suite successfully before deploy.
- Main56851ee, GAS779, Vercel dpl_8AK3KCQzcDntsx2UExcSWkJqYNjX READY.
- Runtime model/provider/reasoning unchanged; bridge and root gateway not restarted or killed. Live root/worker guidance was narrowly patched, preserving learned references. Backups are in C:/Village/tmp.
- Additional exact removal projection recovery tests:5RED ->8GREEN; related projection/removal suite36/36 pass. Independent review and deployment pending at this revision.
