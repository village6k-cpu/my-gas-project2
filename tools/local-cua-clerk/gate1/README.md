# Gate 1 Desktop CUA bridge

`desktop-cua-bridge.mjs` is the first local request adapter for the Village tax/document clerk.
It starts the pinned Codex `app-server` over stdio, creates one ephemeral read-only thread, runs one
fixed Chrome readiness action through `node_repl` + `@oai/sky`, and emits one strict redacted record.
No model generates or edits the CUA action code.

Run from the repository root:

```sh
node tools/local-cua-clerk/gate1/desktop-cua-bridge.mjs
```

`PASS` requires all of the following: thread creation, fixed-action dispatch, a completed
`node_repl.js` call, four true CUA booleans, strict result validation, and confirmed app-server child
cleanup. One exact all-false infrastructure result may retry the same fixed action once to cover
`@oai/sky` cold start; a real partial capability result is not retried. Every other executable path
is rejected in production. The fixed action waits for the matching per-thread `node_repl` ready
event. Responses must match the one pending app-server request ID and protocol phase; duplicate or
unsolicited responses fail closed. Timeout cleanup
revalidates the exact child identity before TERM and again before KILL; PID reuse is denied.

The bridge never serializes a thread id, turn id, MCP arguments/result outside the four booleans,
accessibility text, screenshot URL/image, page content, subprocess output, or credentials. It does
not click, type, navigate, log in, use HomeTax, receive Slack events, or perform tax/document
mutations.

`studio-mac-codex-worker.mjs` is the separate, narrowly authorized mutation worker for this local
Studio Mac. It accepts only one typed `hometax_cash_receipt_issue` task with `owner_explicit`, starts
the pinned Codex app-server in a fresh ephemeral thread, and permits only HomeTax cash-receipt work.
Certificate login uses the first certificate and the first Chrome native-autofill suggestion without
reading or serializing the secret. A completion is returned only after a fixed `node_repl` readback
independently finds the exact approval number and amount in Chrome accessibility state. Lock,
CAPTCHA, missing autofill, timeout, or ambiguous readback returns a fixed non-success state.

Tests:

```sh
node --test tools/local-cua-clerk/gate1/*.test.mjs
```
