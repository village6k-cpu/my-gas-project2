# Bounded Supabase projection retry implementation plan

> For agentic workers: execute inline with superpowers:executing-plans; one independent final review.

**Goal:** Stop partial-failure replay amplification and quota-error hot loops without replaying business operations or changing authority.
**Architecture:** Retain current bulk transport and existing one-minute trigger. Report per-trade completion across trade/items/payment stages, clean only proven successful unchanged dirty revisions. Encode compact retry metadata in existing dirty values; add one bounded quota cooldown and an ownership lease. HTTP accounting is scoped to this existing background worker and logged locally, not another scheduled task.
**Tech Stack:** Apps Script JavaScript, existing PropertiesService/LockService, Node VM regression tests.
**Spec / authorization:** User approved four-step root-repair approach on 2026-10-24 with “ㄱㄱ”. Minimal existing pipeline repair selected over account changes or a new synchronization service.

## Constraints
- No customer/Slack send, completed booking replay, schema change, provider/account/quota setting change, new trigger, or runtime restart.
- No success inference from HTTP status alone where current item/cancellation/payment checks require readback.
- Preserve checkout authority, existing-only item PATCH, removed_at semantics, authoritative financial metadata, dirty snapshot CAS, and payment revisions.
- No extra HTTP on healthy paths; keep healthy bulk grouping. No unbounded Script Properties history. Read/write work only under matching dirty revision and worker lease.
- Fixed historical recovery cutoff and existing process guards untouched. Exact historical account attribution remains distinct from reproducible code amplification.

## Tasks
- [x] Baseline existing focused tests.
- [x] RED: real-source partial-item failure leaves only failed trade; repeated trigger avoids completed trade; daily quota permits no immediate extra HTTP; overlapping flush acquires one lease; failed lease storage permits no HTTP; fresh dirty revision survives cleanup/backoff.
- [x] GREEN: add optional per-trade outcome reports to bulk/item/payment helpers; preserve boolean APIs. Worker uses outcomes rather than whole-batch boolean.
- [x] GREEN: compact per-dirty retry, quota cooldown, bounded worker lease, scoped sanitized HTTP count summary; no external request outside existing worker is affected.
- [x] Verify focused/full tests, immutable diff, and independent whole-branch review. Correct regressions once with RED/GREEN evidence.
- [ ] Official finishbranch/integrate/endwork; independent public readback and normal existing-trigger observation, with no business/probe write. Report measured call change and unproven historical attribution separately.

## Review focus
- Partial fetchAll failure or response-length mismatch cannot clear unproven trade work.
- Concurrent new dirty mark or expiry/replacement lease cannot be deleted by an older worker.
- Daily URLFetch exception is distinguished from property quota, rate bursts, and permanent authorization errors.
- A failed payment acknowledgement retains the affected projection work; existing payment source authority remains unchanged.
- Backoff must not permanently starve new work or grow properties per attempt; existing background tasks retain their original ownership.

## Final verification before integration
- Root 251 test files: failed 0; app 433 tests: failed 0; TypeScript noEmit, source syntax, diff check PASS.
- Independent corrected-snapshot review: 37 tests independently PASS; no actionable findings.
- Review corrections: coalesced one mailbox per trade under lock contention (105 repeated marks -> one mailbox); explicit server acknowledgement distinguishes current/review-held/projection-required without adding HTTP or changing payment authority.
- No live business writes, process restarts, new triggers, or message sends. Deployment/readback remains the final task.
