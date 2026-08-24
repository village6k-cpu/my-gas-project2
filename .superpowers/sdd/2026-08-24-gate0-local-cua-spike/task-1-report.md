# Task 1 report — Gate 0 probe contract

## Implementation summary

Implemented a dependency-free Node 22 ESM probe contract, runtime collector, Gate 0 verdict report
serializer, focused tests, and safe invocation/cleanup documentation. Serialization is strict,
allowlisted, and fail-closed for unknown fields and sensitive-looking keys/values; subprocess
stdout/stderr and environment values are never included.

## Test command and output

`node --test tools/local-cua-clerk/gate0/*.test.mjs`

Review-fix command: `node --test tools/local-cua-clerk/gate0/*.test.mjs && git diff --check`

Review-fix actual result: 4 tests passed, 0 failed, 0 skipped; `git diff --check` passed.

## Files changed

- `tools/local-cua-clerk/gate0/probe-contract.mjs`
- `tools/local-cua-clerk/gate0/runtime-probe.mjs`
- `tools/local-cua-clerk/gate0/gate0-report.mjs`
- `tools/local-cua-clerk/gate0/probe-contract.test.mjs`
- `tools/local-cua-clerk/gate0/runtime-probe.test.mjs`
- `tools/local-cua-clerk/gate0/README.md`

## Self-review

- ✅ Node 22 ESM with no third-party dependencies.
- ✅ Unknown fields, sensitive keys/values, and hard Gate 0 failures are rejected/classified.
- ✅ Runtime commands are injectable and only allowlisted paths/versions/branch/platform/MCP/capabilities are retained.
- ✅ No GUI, credentials, HomeTax, GAS, or Sheets actions performed.
- ✅ PASS now requires all nine probe IDs and the five restricted-profile assertions; incomplete evidence is `SUPERVISED_ONLY`/`BLOCKED`.
- ✅ Runtime evidence includes validated Node/Codex paths and versions; empty path and version failure are `BLOCKED`.
- ⚠️ Live probe runners and live evidence are intentionally deferred to Tasks 2–4.

## Concerns

The approved contract is intentionally conservative: missing runtime commands are `BLOCKED`, and
orphan/evidence integrity failures block the whole Gate 0 report. Later tasks should import these
serializers rather than duplicate evidence handling.

## Review-fix commit

`3810646` (`fix: enforce fail-closed Gate 0 contract`)
