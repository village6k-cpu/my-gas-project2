# Discount evidence reconciliation implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve AI-resolved current conversation discount through intake, registration, the contract master, ledger and calculated contract amount, and reconcile clearly evidenced omissions without sending.

**Architecture:** Keep AI responsible for semantic interpretation. Existing deterministic discount normalization, identity fences, CAS mutations and readback enforce execution. Current explicit conversation terms win over stale customer DB; DB is fallback only. Never infer a discount by customer-name hardcoding or change column order.

**Tech Stack:** Node ESM worker, GAS, existing runtime skills and existing internal read/write APIs.

**Spec:** User request in this thread: investigate unselected/missing discount types despite clear Kakao evidence, fix the root cause and approved existing records.

## Global constraints

- No customer sends, blind business replay, sheet-structure changes, model/provider/reasoning changes or broad service kills.
- Preserve dirty production runtime and existing manual changes. Use exact trade identity and expected prior discount before writes.
- Feature work in the existing isolated worktree; run startwork before edits, finishbranch then main integrate for deployment.

## Review focus

- Explicit current student vs stale general/loyal DB: preserve current resolved evidence.
- No conversation evidence: use an identity-safe DB match; mismatched phone must not borrow a namesake's discount.
- All RQ rows and registered K-column must agree; do not accept equipment-only success as commercial-term verification.
- Ledger discount columns must be discovered from actual headers, not guessed; preserve formulas/payment/manual adjustments.
- Unknown item price and concurrent manual discount updates must not be overwritten by stale recovery.

## Tasks

### 1. Prove source-to-ledger failure and precedence regression
- [ ] Audit fresh Kakao evidence and current request/master/ledger values for recent registered trades and the nine earlier customers.
- [ ] Write failing worker tests for explicit conversation priority in enrichment, post-intake application and catalog quote calculation, plus identity-safe DB fallback.
- [ ] Repair `tools/ai-browser-worker/worker.mjs` without weakening price/send guards; run targeted tests.

### 2. Close registered-term readback and actual ledger propagation gaps
- [ ] Reproduce any missing K-column/readback or ledger-header mapping defect with existing GAS fixtures before changing it.
- [ ] Patch the smallest affected GAS primitive and its readback, preserving existing CAS/leases/payment data and schema.
- [ ] Align only contradictory operational guidance; pressure-test consuming behavior, not prose equality.

### 3. Verify, deploy and reconcile evidenced records
- [ ] Run full root tests with Git Bash on PATH, syntax checks and independent review.
- [ ] Finish feature and integrate/deploy through repository scripts.
- [ ] For each confirmed mismatch, read exact current state, apply once through official guarded APIs, and verify master/ledger/contract/app independently. Preserve unpriced and ambiguous records as explicit pending follow-up.
