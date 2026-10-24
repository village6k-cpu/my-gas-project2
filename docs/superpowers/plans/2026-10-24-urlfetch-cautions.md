# UrlFetch cautions amplification repair

> Execute inline using superpowers:executing-plans; one fresh final review.

Goal: remove display-only external requests from background warming and DB projection without removing staff cautions.
Architecture: cache core dashboard data before optional caution enrichment; staff reads enrich with existing five-minute cache. Deduplicate identical misses within each batch. No schema, physical state, pricing, send or auth changes.
Evidence: Oct23 01:20Z-Oct24 01:20Z Vercel metrics GAS UA /api/cautions 15091; Supabase edge logs GAS UA5063; payments503. Not a complete per-account quota ledger and not proof of each invoking caller.

- [ ] Reproduce warm/projection coupling, stale staff-cache cautions, duplicate batch requests.
- [ ] Separate core caching from display enrichment; background opts out; deduplicate identical request misses and fan out response.
- [ ] Run relevant behavior/static regression and complete official checks; fresh review; finishbranch/integrate.
- [ ] Verify public shape and source/DB without replaying successes; then authorized Kim19 change only after quota availability evidence.

Full production automation recovery remains separate unfinished work. No blind restart.

Progress: failing reproduction4/5 observed; implementation and44 targeted regressions pass. Reviewed all3 getDashboardData production callsites. Prior daily cautions Oct20 14780,21 14271,22 11915,23 14069 UTC show this high background baseline predates this repair. Exact Google account quota window and all other GAS projects are not available; do not claim these endpoint counts equal the account quota meter.

Attribution review 2026-10-24: prepared patch was held at the user's direction while own recovery traffic was examined. Saved audit JSONs contain 276 unique lookup results /792 inbound sheet searches and5 full-catalog batches /10 inbound reads; these are not GAS outgoing UrlFetch calls. The sheet-only search implementation has no outgoing HTTP. Mutation/contract/projection work does cause downstream HTTP, but exact historical per-initiator counts cannot be reconstructed from aggregate endpoint logs.

Direct real-source offline regression now reproduces the recovery amplification boundary: one dirty trade after date-cache invalidation builds all pickup-day display cards and makes2 caution HTTP calls on unchanged main; the patch makes0 while preserving target amount182160, target item, and2 staff cards with their cautions. Test failed on unchanged main and passed on feature. This proves the amplification mechanism, not the exact account quota-crossing time or an exclusive incident cause. Latest user authorized repairing incident side effects; proceed only with this proven coupling fix, not unrelated functions or replayed reservations.