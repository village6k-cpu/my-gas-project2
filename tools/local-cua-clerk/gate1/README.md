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

`studio-mac-codex-worker.mjs` is the separate authorized worker for this local Studio Mac. Its typed
`hometax_cash_receipt_issue` profile retains the strict HomeTax contract, while its
`general_local_cua` profile accepts one bounded natural-language task only after the Slack layer has
proved the fixed HeyBilly source and owner-authored parent thread. Both profiles start the Codex
app-server in a fresh **persisted** task whose PII-free name contains only `맥에이전트` and the request
ID. They share the same app-server protocol and exact-child cleanup but use separate input/result
schemas. The general profile is forbidden from delegating to AX2 or another computer and requires
`readbackVerified=true` before any completed result.

두 profile 모두 첫 CUA 관찰의 잠금 오류를 곧바로 실제 잠금으로 확정하지 않는다. Chrome 기준
안전 좌표 클릭과 macOS `System Events` 좌표 클릭을 각각 정확히 한 번만 시도한 뒤 같은 관찰을
재확인하며, 그래도 잠금 오류일 때만 `studio_mac_locked`로 중단한다. 이 절차는 인증을 우회하지
않고 화면보호기 오판만 제거한다.

The HomeTax profile permits only cash-receipt work.
Certificate login uses the first certificate and the first Chrome native-autofill suggestion without
reading or serializing the secret. A completion is returned only after a fixed `node_repl` readback
independently finds the exact approval number and amount in Chrome accessibility state. Lock,
CAPTCHA, missing autofill, timeout, or ambiguous readback returns a fixed non-success state.

Tests:

```sh
node --test tools/local-cua-clerk/gate1/*.test.mjs
```
