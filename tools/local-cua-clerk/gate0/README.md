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
