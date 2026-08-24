# Gate 0 Local CUA Spike Implementation Plan

Spec: `/Users/choijaehyeong/.gstack/projects/village6k-cpu-my-gas-project2/choijaehyeong-main-design-20260824-090035.md`

## Objective

Produce machine-verifiable evidence for the approved Gate 0 only. Determine whether the local Codex CLI can support a read-only HomeTax worker from a terminal and a temporary user LaunchAgent, whether a human-interruption/resume path survives, and whether raw CUA can be excluded from an unattended profile. Do not implement Slack ingress, the durable business ledger, invoice mutation, or production installation.

## Global Constraints

- Work only on `codex/gate0-local-cua`; never deploy GAS or modify Sheets.
- HomeTax is read-only. Never issue, edit, cancel, submit, delete, or transmit a tax record.
- Never inspect, reveal, copy, persist, or print credentials, cookies, certificate passwords, autofill values, customer identifiers, or page text.
- Authorized login flow, only if needed: `공동·금융인증` → first certificate → click password field → first Chrome native-autofill suggestion. Confirm masked fill only. If unavailable, record `needs_human`; do not guess.
- Use `node_repl` + `@oai/sky` for all live UI actions. Refresh app state after every UI change. No coordinate action when a stable AX element exists.
- Do not accept TCC, Screen Recording, Accessibility, Keychain, CAPTCHA, or other security prompts. Record the exact boundary without sensitive content and stop that probe for user action.
- Runtime evidence is allowlisted booleans, versions, timestamps, exit statuses, hashed run IDs, and redacted error classes only. Raw AX trees, screenshots, Codex JSONL, environment dumps, and HomeTax result data are never committed.
- A temporary LaunchAgent must be one-shot, use a unique label, write only to a temporary directory, and be booted out in cleanup. Do not install a persistent agent.
- Gate 0 autonomous status is PASS only if the unattended profile excludes direct `node_repl`, raw input injection, helper-socket access, and ledger writes while a narrow action path still works. Otherwise classify `SUPERVISED_ONLY` or `BLOCKED`; do not weaken the criterion.
- Actual process tests may terminate only child PIDs/PGIDs created by the test after verifying executable and start identity. Never target an unrelated process.

## Task 1: Implement the redacted Gate 0 probe contract

Create `tools/local-cua-clerk/gate0/` with a dependency-free Node 22 ESM contract and CLI for recording probes.

Required files:

- `probe-contract.mjs`: schema version, probe IDs, `PASS|FAIL|BLOCKED|NOT_RUN` result states, verdict derivation, strict allowlist serialization, and secret/PII field rejection.
- `runtime-probe.mjs`: collect only Node/Codex paths and versions, current branch, platform, configured MCP names/statuses, and capability booleans without command arguments or environment values.
- `gate0-report.mjs`: combine probe results into `PASS`, `SUPERVISED_ONLY`, or `BLOCKED` using the approved Gate 0 rules.
- `probe-contract.test.mjs` and `runtime-probe.test.mjs` using `node:test`, injected command results, and temporary directories.
- `README.md` with safe invocation and cleanup rules.

Acceptance:

- Unknown evidence fields and sensitive-looking keys/values are rejected.
- Raw subprocess stdout/stderr is not serialized into committed evidence.
- Runtime collection can be fully tested with injected spawn output.
- `node --test tools/local-cua-clerk/gate0/*.test.mjs` passes.

## Task 2: Implement terminal and temporary LaunchAgent probe runners

Add runners that execute a fixed, read-only Codex probe and capture only the Task 1 contract.

Required files:

- `codex-probe-runner.mjs`: spawn the pinned Codex absolute path with `--ephemeral --json`, a fixed output schema, timeout/process-group cleanup, and allowlisted event parsing. The prompt may ask `node_repl` to read only Chrome accessibility availability and screenshot availability, then return booleans; it must never return AX text or a screenshot.
- `launch-agent-probe.mjs`: generate a one-shot temporary plist, bootstrap it in the current `gui/$UID` domain, wait for a bounded result, boot it out in `finally`, and remove only its own temporary directory.
- `codex-probe-runner.test.mjs` and `launch-agent-probe.test.mjs` with fake spawn/launchctl, timeout, malformed JSONL, cleanup, and unrelated-label/PID denial cases.

Acceptance:

- Terminal and LaunchAgent use the same immutable probe payload and output schema.
- A timeout terminates only the recorded child process group and yields a redacted failure class.
- Cleanup is idempotent and never removes a broad directory or another launchd label.
- Unit tests pass without invoking GUI or launchctl.

## Task 3: Implement restricted-profile and orphan-recovery feasibility probes

Add a fail-closed feasibility layer; this is a probe, not the production helper.

Required files:

- `restricted-profile-probe.mjs`: compare the normal diagnostic profile with `codex exec --ignore-user-config --sandbox read-only`. Verify that direct `node_repl` is unavailable in the restricted profile. Record shell presence separately; do not treat a prompt promise as a security boundary.
- `orphan-recovery-probe.mjs`: create only disposable child process groups, record PID/PGID plus executable/start identity, revoke a synthetic daemon epoch, and verify identity-checked TERM/KILL cleanup plus PID-reuse fail-closed behavior.
- Corresponding `*.test.mjs` files with adversarial cases for forged evidence, reused grants, wrong epoch, wrong process identity, and unrelated PID protection.

Acceptance:

- If a narrow action helper cannot be exposed without restoring raw `node_repl` or equivalent global CUA, the report must return `SUPERVISED_ONLY`; this is a valid Gate 0 outcome.
- No test sends a real click, keystroke, Apple Event, or CGEvent.
- Orphan cleanup refuses mismatched identity and records `BLOCKED` instead of killing.

## Task 4: Execute live Gate 0 probes and publish the verdict

Run the tested harness on this Mac in this order:

1. Desktop baseline: `node_repl` can read Chrome; record booleans only.
2. Terminal `codex exec` read-only Chrome observation.
3. Temporary user LaunchAgent running the identical observation.
4. TCC subject and permission-boundary observation without accepting or changing permissions.
5. Restricted-profile denial probe.
6. Human-interruption/resume probe using a synthetic non-credential checkpoint unless HomeTax already presents a safe, read-only login boundary. Never force a logout or create a credential prompt.
7. Orphan process recovery probe using test-owned children only.

Create `docs/gate0/2026-08-24-local-cua-gate0-report.md` containing:

- exact tool versions and run timestamps;
- one row per approved Gate 0 criterion with PASS/FAIL/BLOCKED/NOT_RUN and a redacted evidence pointer;
- final `PASS`, `SUPERVISED_ONLY`, or `BLOCKED` verdict;
- any required user action, stated precisely;
- explicit confirmation that no tax mutation, Slack post, credential inspection, persistent LaunchAgent, or permission grant occurred.

Acceptance:

- Re-run the full unit suite.
- `git diff --check` passes.
- The report never claims autonomous PASS when restricted CUA is unproven.
- Live failure is reported as evidence, not patched around.
