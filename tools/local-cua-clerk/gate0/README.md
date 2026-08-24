# Gate 0 probe contract

Dependency-free Node 22 ESM helpers for the read-only local-CUA feasibility spike. Each of the nine
probe IDs has an exact evidence schema. A `PASS` row must contain its complete fixed enum/boolean
proof, and `deriveVerdict()` revalidates every row before it can return global `PASS`. Sensitive
keys and values, including customer/client identifiers, contact/address/certificate data, page/AX
content, raw output, and credentials are rejected.

Run from the repository root: `node --test tools/local-cua-clerk/gate0/*.test.mjs`.

Runtime collection is diagnostic only and uses the separate strict `gate0-runtime/v1` serializer;
it can never emit a `launchagent_security` contract result. Later runners must persist only
`serializeProbes()`/`serializeGate0Report()` output and use a unique temporary directory.
Cleanup may remove only that directory and must be idempotent; never use a broad recursive path or
touch a persistent LaunchAgent. No GUI, HomeTax, credential, GAS, or Sheets action belongs here.

`codex-probe-runner.mjs` runs the immutable boolean-only probe through an absolute Codex path and
accepts exactly one designated final record with exactly two boolean keys. Retained JSONL is capped
at 64 KiB; overflow is redacted `BLOCKED/malformed_evidence`. `launch-agent-probe.mjs` writes a
one-shot plist with a pinned working directory and exactly `LANG`/`PATH` environment keys. Cleanup
uses only `bootout gui/$UID/<exact-label>` plus bounded absence confirmation. Confirmed cleanup
removes only its own directory. Failed cleanup overrides any earlier `PASS`, retains only the owned
plist/private exact label-to-run mapping, and returns `BLOCKED/cleanup_incomplete`.

If the CLI runtime does not provide `node_repl`, the immutable CUA payload forbids shell or command
fallback and returns both capability booleans false. A timeout-triggered child close remains a
redacted timeout outcome and cannot race into `command_failed`.

`restricted-profile-probe.mjs` compares the normal diagnostic invocation with
`codex exec --ignore-user-config --sandbox read-only`. Its exact boolean record separately reports shell
presence and requires mechanical denial of direct `node_repl`, raw input, helper sockets, and ledger writes;
prompt instructions are not treated as a boundary. A failed or forged record is `BLOCKED`, and a working
narrow path with unrestricted CUA is not autonomous PASS. It accepts only one exact designated Codex
JSONL agent result and preserves `execFile` timeouts as `BLOCKED/timeout` without retaining subprocess
diagnostics.

`orphan-recovery-probe.mjs` is a fail-closed feasibility seam. Production accepts no arguments and
creates only its own disposable child. It revokes the synthetic helper epoch before granting a
separate private one-use recovery authority, revalidates exact executable/start identity immediately
before TERM and KILL, waits boundedly after both, and reports cleanup only after process-group absence.
The exported simulator is pure and side-effect-free; unit tests use it for unrelated-PID and actual
PID-identity-reuse denial without sending a real signal.

The historical same-function checkpoint roundtrip is not audited interruption/resume evidence.
Canonical `human_resume` remains `NOT_RUN` until a separately observed human interruption/resume can
be performed under an explicitly approved live procedure.
