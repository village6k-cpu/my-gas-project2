# Gate 0 probe contract

Dependency-free Node 22 ESM helpers for the read-only local-CUA feasibility spike. Evidence is
allowlisted and deliberately excludes subprocess output, environment values, page text, AX trees,
screenshots, credentials, cookies, and customer data.

Run from the repository root: `node --test tools/local-cua-clerk/gate0/*.test.mjs`.

Runtime collection is diagnostic only. Later runners must inject their subprocess implementation,
persist only `serializeProbes()`/`serializeGate0Report()` output, and use a unique temporary directory.
Cleanup may remove only that directory and must be idempotent; never use a broad recursive path or
touch a persistent LaunchAgent. No GUI, HomeTax, credential, GAS, or Sheets action belongs here.

`codex-probe-runner.mjs` runs the immutable boolean-only probe through an absolute Codex path and
serializes a `makeProbe()` result. `launch-agent-probe.mjs` writes a one-shot plist below a private
temporary directory, bootstraps it in `gui/$UID`, waits with a deadline, then boots out its exact
label and removes only that directory. Neither runner retains subprocess stdout/stderr; the CLI
output file contains only the Task 1 probe contract.

`restricted-profile-probe.mjs` compares the normal diagnostic invocation with
`codex exec --ignore-user-config --sandbox read-only`. Its exact boolean record separately reports shell
presence and requires mechanical denial of direct `node_repl`, raw input, helper sockets, and ledger writes;
prompt instructions are not treated as a boundary. A failed or forged record is `BLOCKED`, and a working
narrow path with unrestricted CUA is not autonomous PASS.

`orphan-recovery-probe.mjs` is a fail-closed feasibility seam. It authorizes only a synthetic, one-use epoch
grant and a child PID/PGID whose executable and start identity match immediately before TERM and before KILL.
Wrong epochs, reused grants, PID reuse, identity mismatch, and unrelated targets produce `BLOCKED` with no
signal. The live disposable-child invocation is intentionally deferred to Task 4.
