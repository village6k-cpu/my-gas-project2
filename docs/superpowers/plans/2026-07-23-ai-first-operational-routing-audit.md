# AI-First Operational Routing Audit Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Restore Hermes as the semantic decision-maker across the active Kakao/Village operating path while keeping deterministic code limited to observation, authoritative lookup, validation, safety gates, execution, and readback.

**Architecture:** The DOM bridge forwards every structurally valid customer event to Hermes. Hermes returns a typed decision contract containing the complete sheet row, reply safety/grounding class, attachment intent, and follow-up route. The worker validates that contract and asks Hermes to repair incomplete decisions; it never reconstructs business meaning from regexes or rewrites Hermes output. Windows lifecycle scripts continuously install the AI-first skills/profile and enable DevTools-first chat discovery with vision fallback.

**Tech Stack:** Node.js ESM, `node:test`, PowerShell, Hermes CLI/profile YAML, Kakao CDP bridge.

**Safety boundary:** No Kakao send, sheet mutation, Slack post, deployment, commit, or push is part of this plan. Live verification is read-only or dry-run, and the existing auto-send mode is preserved across a bridge restart.

---

### Task 1: Lock the audit boundary and baseline

- [x] Confirm the active worktree, dirty-file baseline, running bridge, queue state, and production profile path.
- [x] Run the focused pre-change test suite and record the baseline.
- [x] Separate semantic judgment from legitimate deterministic accounting, retrieval, validation, safety, and execution code.

### Task 2: Stop the bridge from suppressing customer events before AI

**Files:**
- Modify: `tools/kakao-dom-bridge/server.mjs`
- Test: `tools/kakao-dom-bridge/server.test.mjs`

- [ ] Add failing tests proving thanks-only, staff-looking, and low-value-looking message previews still reach AI.
- [ ] Remove semantic preview suppression while retaining structural-noise, freshness, provenance, and dedupe guards.
- [ ] Run the bridge tests and confirm they pass.

### Task 3: Make the worker consume a typed Hermes decision without semantic rewrites

**Files:**
- Modify: `tools/ai-browser-worker/worker.mjs`
- Test: `tools/ai-browser-worker/worker.test.mjs`

- [ ] Add failing tests for exact equipment preservation, no raw-text/name/date/time/default fallbacks, and a validation-triggered Hermes repair pass.
- [ ] Extend the Hermes JSON contract with `plan_complete`, reply safety/grounding/attachment fields, and explicit follow-up routes.
- [ ] Validate the contract and retry Hermes once with concrete validation errors instead of mechanically repairing meaning.
- [ ] Build sheet payloads only from the validated AI row and preserve the equipment list byte-for-byte apart from structural normalization.
- [ ] Run focused worker contract tests.

### Task 4: Return reply, document, RAG, and follow-up judgment to Hermes

**Files:**
- Modify: `tools/ai-browser-worker/worker.mjs`
- Test: `tools/ai-browser-worker/worker.test.mjs`

- [ ] Add failing tests proving reply text alone cannot grant auto-send, attachments, a RAG bypass, or a Slack route.
- [ ] Require explicit AI safety/grounding and attachment keys; map only allowlisted keys to local files.
- [ ] Keep deterministic code as a negative safety gate, authoritative-policy/RAG verifier, attachment/readback executor, and dedupe layer.
- [ ] Route follow-ups only from the AI enum, never keywords embedded in prose.
- [ ] Run all worker tests.

### Task 5: Make the active Windows profile AI-first on every launch

**Files:**
- Modify: `scripts/windows/sync-hermes-profile-overlay.ps1`
- Modify: `scripts/windows/start-kakao-staging.ps1`
- Modify: `scripts/windows/KakaoStaging.Common.psm1`
- Modify: `scripts/windows/windows-runtime-config.mjs`
- Modify: `scripts/windows/.env.windows.example`
- Test: `test/windows-hermes-skill-parity.static.test.js`
- Test: `test/windows-hermes-profile-overlay.static.test.js`
- Test: `test/windows-kakao-staging.static.test.js`
- Test: `test/windows-runtime-config.test.mjs`

- [ ] Add failing lifecycle tests for profile-scoped skill sync, an AI-first profile description, `gpt-5.6-sol`/high/90 preservation, DevTools-first fallback, and target-chat search enabled.
- [ ] Add a profile-scoped atomic sync that installs canonical Windows skills and removes obsolete `000-windows` staging aliases.
- [ ] Run that sync before every bridge launch, not only gateway launches.
- [ ] Set Windows defaults and all active environment files to DevTools-first with read-only target-chat search.
- [ ] Run Windows lifecycle/config tests.

### Task 6: Apply safely and prove the full operating chain

- [ ] Run the complete focused suite plus all related static/integration tests.
- [ ] Back up and synchronize the live `kakaoworker` profile; confirm indexed skills and profile identity are AI-first.
- [ ] Restart only the bridge with the same live/auto-send state after confirming no active worker and an empty queue.
- [ ] Verify bridge health, CDP, fresh heartbeat/event evidence, queue movement evidence, and a completed no-send worker result without injecting a customer event.
- [ ] Run a synthetic Hermes profile decision that is explicitly read-only/no-send and inspect the typed decision.

### Task 7: Self-review and handoff

- [ ] Review the final diff for accidental intelligence reductions, unrelated edits, secrets, and live side effects.
- [ ] Run `superpowers:verification-before-completion` checks on fresh output.
- [ ] Report proven fixes, retained deterministic safety boundaries, live status, tests, and any remaining unknowns without claiming deployment or sends.
