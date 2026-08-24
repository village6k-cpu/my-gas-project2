# Task 4 report — live Gate 0 verdict

## Implementation summary

Corrected the production Gate 0 Codex pin to the verified standalone `0.147.0` binary and added
an exact-path regression. Created the final redacted Gate 0 report after running the approved
live probes in the required order.

## Commit and verification

- Pin commit: `8d7fb6e` (`fix: pin Gate 0 runner to resolved Codex binary`)
- Pin regression + full suite: 30 passed, 0 failed.
- Live verdict: **BLOCKED**.
- Final verification to run after report creation: full suite and `git diff --check`.

## Redacted live statuses

- Desktop Sky baseline: PASS; both approved booleans true; no security prompt observed.
- Terminal runner: BLOCKED / `command_failed`.
- One-shot temporary LaunchAgent runner: BLOCKED / `command_failed`.
- Permission boundary: no prompt accepted or changed.
- Restricted profile: BLOCKED / `command_failed`; no mechanical-denial helper proof.
- Synthetic non-credential resume: PASS; checkpoint cleanup confirmed.
- Orphan recovery: BLOCKED / `pid_reuse`; cleanup unconfirmed. No external PID/PGID was targeted.
- LaunchAgent cleanup verification: temporary directory absent, but a temporary Gate 0 label remains.
  Its exact ownership is unavailable after the runner ended, so it was not removed.

## Safety confirmation

No HomeTax access, tax mutation, credential inspection, Slack post, GAS deployment, Sheets change,
permission grant, or unrelated-process signal occurred. No persistent LaunchAgent was intentionally
installed; residual-label cleanup is explicitly not claimed.

## Concern

The blocked outcome must remain the final Gate 0 verdict until the terminal/LaunchAgent failures,
residual owned-label cleanup, orphan child cleanup confirmation, and restricted-profile mechanical
boundary are independently fixed and retested. This task did not patch around live failures.
