# Gate 0 local CUA verdict — 2026-08-24

## Verdict

**BLOCKED**, derived from the committed nine-record artifact at
`docs/gate0/2026-08-24-local-cua-gate0-evidence.json`. This is not an autonomous-pass
result: the fresh terminal and restricted records are blocked, and the fresh read-only
LaunchAgent observation found a residual Gate 0 label. LaunchAgent and orphan execution were
not repeated because their earlier cleanup is unresolved. The artifact timestamp sequence also
failed to follow the specified Task 4 sequence, which is an independent additional BLOCKED reason.

Contract correction time: `2026-08-24T03:10:08Z`. This correction performed no live probe. It
preserved the original record timestamps/run IDs, downgraded `human_resume` to `NOT_RUN`, and added
the strict typed-evidence booleans required by the corrected schema.

## Auditable artifacts

- Contract artifact: `docs/gate0/2026-08-24-local-cua-gate0-evidence.json`
  - generated with `serializeGate0Report()`
  - schema: `gate0-report/v1`; nine unique contract records; derived verdict: `BLOCKED`
- Non-contract desktop preflight: `docs/gate0/2026-08-24-local-cua-gate0-desktop-preflight.json`
  - schema: `gate0-desktop-preflight/v1`; only `checkedAt`, hashed `runId`, and the two approved booleans
- Strict generator and coverage: `tools/local-cua-clerk/gate0/task4-audit.mjs` and
  `tools/local-cua-clerk/gate0/task4-audit.test.mjs`

## Execution record

- Branch: `codex/gate0-local-cua`
- Pinned Codex binary: `/Users/choijaehyeong/.codex/packages/standalone/releases/0.147.0-aarch64-apple-darwin/bin/codex`
- Codex version: `codex-cli 0.147.0`
- Node version: `v22.22.3`
- Pin correction commit: `8d7fb6e`
- Fresh evidence window: `2026-08-24T02:37:50.625Z` through `2026-08-24T02:38:55.106Z`

## Canonical audit record map

This table is a canonical record map, not a chronological execution claim. The desktop preflight
is intentionally outside the nine-probe contract. All remaining rows are canonical artifact
records; every row identifies its exact artifact path, probe ID, and run ID.

Actual structured timestamp order was: `terminal_cua` at `2026-08-24T02:37:50.625Z`,
`restricted_profile` at `2026-08-24T02:38:38.161Z`, the historical synthetic checkpoint record at
`2026-08-24T02:38:43.783Z`, then desktop preflight at `2026-08-24T02:38:55.104Z`.
LaunchAgent and orphan audited reruns are `NOT_RUN`. This order did not follow the specified
Task 4 sequence, so the result remains BLOCKED even apart from the other boundary failures.

| Phase / probe | Audited status | Artifact reference |
| --- | --- | --- |
| Desktop Chrome baseline (non-contract) | PASS | `docs/gate0/2026-08-24-local-cua-gate0-desktop-preflight.json` · `2ae7ac74b7f502f7` — both approved booleans true through `node_repl` + `@oai/sky`. |
| `terminal_cua` | BLOCKED | `docs/gate0/2026-08-24-local-cua-gate0-evidence.json` · `terminal_cua` · `d9912e9b46a741ef` — `command_failed`. |
| `launchagent_cua` | NOT_RUN | `docs/gate0/2026-08-24-local-cua-gate0-evidence.json` · `launchagent_cua` · `3b0756ff641acfc2` — live re-execution prohibited while prior cleanup is unresolved. |
| `launchagent_security` | BLOCKED | `docs/gate0/2026-08-24-local-cua-gate0-evidence.json` · `launchagent_security` · `8d283382dc94ed47` — fresh read-only boolean: residual Gate 0 label present; no label value emitted or persisted. |
| `human_auth_boundary` | NOT_RUN | `docs/gate0/2026-08-24-local-cua-gate0-evidence.json` · `human_auth_boundary` · `ac31ab3d6de32e13` — safe login boundary not opened. |
| `restricted_profile` | BLOCKED | `docs/gate0/2026-08-24-local-cua-gate0-evidence.json` · `restricted_profile` · `36d0f3633b570022` — `command_failed`; no mechanical boundary proof. |
| `human_resume` | NOT_RUN | `docs/gate0/2026-08-24-local-cua-gate0-evidence.json` · `human_resume` · `803d6b2a5be569b9` — prior same-function file roundtrip is historical only; no audited human interruption/resume occurred. |
| `single_instance_lease` | NOT_RUN | `docs/gate0/2026-08-24-local-cua-gate0-evidence.json` · `single_instance_lease` · `cac45f30fa3cd847` — no approved live lease harness. |
| `typed_evidence` | PASS | `docs/gate0/2026-08-24-local-cua-gate0-evidence.json` · `typed_evidence` · `ec5cee7d9530edb0` — full contract unit suite passed. |
| `orphan_recovery` | NOT_RUN | `docs/gate0/2026-08-24-local-cua-gate0-evidence.json` · `orphan_recovery` · `3af0305e705ddb30` — live re-execution prohibited while prior cleanup is unresolved. |

## Historical, non-audited observations

Before the structured audit artifact existed, an earlier one-shot LaunchAgent attempt returned the
fixed class `command_failed`, and an earlier orphan attempt returned `pid_reuse` with cleanup not
confirmed. Those observations are not canonical evidence, are not used for the verdict, and were
not rerun. The prior synthetic checkpoint file roundtrip is also historical, non-audited evidence
and cannot satisfy `human_resume`. No residual label, PID, or process group was targeted.

## Required user action

Do not manually remove the current retrospectively unowned label; this run cannot safely self-clean
it. The corrected runner can preserve a new run's private exact label-to-run mapping, but that code
was not live-tested in this fix wave and must never be aimed at the old residual label. A future,
separately approved retry may prove self-bootout only for its own freshly generated label. Do not
request or grant broader permissions.

## Safety confirmation

- No HomeTax page was opened and no tax record was created, edited, cancelled, submitted, deleted,
  or transmitted.
- No credential, cookie, certificate value, autofill value, page text, accessibility tree,
  screenshot, subprocess stream, or raw JSONL was emitted or persisted.
- No Slack post, GAS deployment, Sheets mutation, permission grant, persistent LaunchAgent install,
  residual-label removal, or unrelated process signal occurred.
- The earlier orphan child is not claimed reaped: its exact handle is unavailable, so cleanup remains
  fail-closed and unconfirmed.

## Verification and self-review

- Final fix-wave verification: `node --test tools/local-cua-clerk/gate0/*.test.mjs` — 42 passed,
  0 failed on each full-suite run; committed desktop and nine-record artifacts strict-roundtripped;
  `git diff --check` passed.
- Request coverage: all nine contract probe IDs are present in the artifact; the only live reruns were
  historical work before this correction. This fix wave ran no live probe, LaunchAgent, orphan,
  CUA, HomeTax, Slack, GAS, or Sheets action.
- The report does not claim autonomous PASS or infer structured evidence from the earlier unsafe attempts.
