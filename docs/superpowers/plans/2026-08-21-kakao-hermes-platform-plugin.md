# Kakao Hermes Platform Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a stock-Hermes platform plugin in `village-ai` that turns Kakao bridge jobs into native Gateway turns, keeps one native session per Kakao room, exposes one native confirmation-request tool, and returns only the final Hermes answer to the bridge.

**Architecture:** The plugin uses only Hermes' public `register_platform`, `BasePlatformAdapter`, `MessageEvent`, `register_tool`, and processing-lifecycle hooks. It long-polls an authenticated loopback bridge, maps `room_key` directly to `SessionSource.chat_id`, and relies on the stock Gateway for session reuse, interruption, persistence, and agent caching. The tool calls the bridge's authoritative confirmation endpoint; it contains no Village intent classifier, response templates, or business decision router.

**Tech Stack:** Python 3.11+, stock Hermes Gateway plugin API, `urllib.request`/`asyncio.to_thread` from the standard library, `pytest`, JSON Schema.

**Spec:** [`2026-08-20-kakao-native-hermes-gateway-session-design.md`](../specs/2026-08-20-kakao-native-hermes-gateway-session-design.md)

## Global Constraints

- Implement in a new clean `village-ai` worktree; do not edit the dirty `C:\Village\village-ai` working tree.
- Do not patch `gateway/`, `hermes_cli/`, or any installed Hermes source. The deliverable is a user plugin artifact only.
- Do not install into the live `kakaoworker` profile, start/restart Gateway, call live GAS, or send Kakao/Slack messages in this plan.
- Use `room_key` as the native `chat_id`; do not create a second session store.
- Accept only loopback bridge URLs and a non-empty bearer token. Never log the token or request authorization header.
- Treat `metadata["notify"] is True` as the documented final-response marker. Ignore progress, typing, tool-preview, and interim sends.
- The `village_confirmation_request` tool transports an AI-selected typed request and returns authoritative evidence. It must not decide whether a message is a schedule inquiry.

---

## Task 1: Create the plugin contract and registration tests

**Files:**
- Create: `migration/hermes/plugins/kakao_village/plugin.yaml`
- Create: `migration/hermes/plugins/kakao_village/__init__.py`
- Create: `migration/hermes/plugins/kakao_village/contracts.py`
- Create: `migration/hermes/plugins/kakao_village/tests/test_registration.py`
- Create: `migration/hermes/plugins/kakao_village/tests/test_contracts.py`

- [ ] **Step 1: Create a clean worktree and record the baseline**

Run read-only checks in `C:\Village\village-ai`, then create `C:\Village\village-ai-worktrees\kakao-hermes-platform-plugin` on `codex/kakao-hermes-platform-plugin` from the current remote default branch. Confirm `git status --short` is empty in the new worktree before editing.

- [ ] **Step 2: Write failing registration and contract tests**

The registration test must use a fake plugin context and assert that one call to `register(ctx)` registers both:

```python
assert ctx.platforms[0]["name"] == "kakao_village"
assert ctx.tools[0]["name"] == "village_confirmation_request"
assert ctx.tools[0]["toolset"] == "village"
```

The contract tests must require these bridge event fields:

```python
{
    "schema": "village-kakao-gateway-event/v1",
    "job_id": "job-1",
    "room_key": "room-1",
    "room_revision": 7,
    "prompt": "trusted bridge prompt",
    "detected_at": "2026-08-21T00:00:00Z"
}
```

They must reject a missing/blank `job_id`, missing/blank `room_key`, non-positive `room_revision`, non-loopback `bridge_url`, and payloads over the configured body limit.

- [ ] **Step 3: Run the tests and confirm RED**

Run from the clean `village-ai` worktree:

```powershell
& "$env:LOCALAPPDATA\hermes\hermes-agent\venv\Scripts\python.exe" -m pytest migration/hermes/plugins/kakao_village/tests/test_registration.py migration/hermes/plugins/kakao_village/tests/test_contracts.py -q
```

Expected: import/file failures because the plugin does not exist yet.

- [ ] **Step 4: Implement the minimal descriptor, registration entry point, and parsers**

`plugin.yaml` must declare `name: kakao_village`, `kind: platform`, a version, and required environment variable names only. `contracts.py` must expose:

```python
@dataclass(frozen=True)
class GatewayEvent:
    job_id: str
    room_key: str
    room_revision: int
    prompt: str
    detected_at: str
    raw: dict[str, Any]
```

Also export `parse_gateway_event(payload: Any) -> GatewayEvent` and `require_loopback_bridge_url(value: str) -> str`.

`register(ctx)` must register the platform and invoke `register_confirmation_tool(ctx)`; it must not catch and suppress registration failures.

- [ ] **Step 5: Run tests and confirm GREEN**

Run the same two tests. Expected: all pass.

- [ ] **Step 6: Commit the contract checkpoint**

```powershell
git add migration/hermes/plugins/kakao_village
git commit -m "feat: define Kakao Hermes plugin contract"
```

---

## Task 2: Implement native inbound turns and final-only result delivery

**Files:**
- Create: `migration/hermes/plugins/kakao_village/http_client.py`
- Create: `migration/hermes/plugins/kakao_village/adapter.py`
- Create: `migration/hermes/plugins/kakao_village/tests/test_adapter.py`
- Modify: `migration/hermes/plugins/kakao_village/__init__.py`

- [ ] **Step 1: Write failing adapter tests with a fake bridge client**

Cover all of these behaviors:

1. `connect()` starts one polling task; `disconnect()` cancels and awaits it.
2. A claimed event produces exactly one `MessageEvent` whose `source.chat_id == room_key`, `message_id == job_id`, and `raw_message` contains the original event.
3. Two events for the same room produce the same native session source; different rooms do not.
4. `send(chat_id, content, metadata={})` returns success without posting a result.
5. `send(chat_id, content, metadata={"notify": True})` posts one result for the oldest pending job in that room.
6. A duplicate final send is idempotently ignored by the fake bridge.
7. `on_processing_complete(event, FAILURE|CANCELLED)` posts a typed outcome so the bridge does not wait for a lease timeout.

- [ ] **Step 2: Run the adapter test and confirm RED**

```powershell
& "$env:LOCALAPPDATA\hermes\hermes-agent\venv\Scripts\python.exe" -m pytest migration/hermes/plugins/kakao_village/tests/test_adapter.py -q
```

Expected: missing adapter/client imports.

- [ ] **Step 3: Implement the stdlib bridge client**

Expose `claim(consumer_id, wait_ms)`, `complete(job_id, room_revision, content)`, `outcome(job_id, outcome, detail="")`, and `confirmation_request(payload)` methods, with JSON body size limits and redacted errors.

Every request must send `Authorization: Bearer ${VILLAGE_KAKAO_BRIDGE_TOKEN}`, use explicit connect/read timeouts, and refuse bridge hosts other than `127.0.0.1`, `localhost`, or `::1`.

- [ ] **Step 4: Implement the official platform adapter surface**

The inbound path must use the stock API exactly:

```python
source = self.build_source(
    chat_id=event.room_key,
    chat_name=event.room_key,
    chat_type="dm",
    user_id="village-kakao-bridge",
    user_name="Village Kakao Bridge",
)
message = MessageEvent(
    text=event.prompt,
    message_type=MessageType.TEXT,
    source=source,
    message_id=event.job_id,
    raw_message=event.raw,
    timestamp=parse_timestamp(event.detected_at),
)
await self.handle_message(message)
```

Maintain only a transport correlation deque per room (`room_key -> job_id`); do not store conversation history or model state. In `send`, post only when `(metadata or {}).get("notify") is True`, following the stock A2A adapter's documented final-delivery pattern.

- [ ] **Step 5: Run registration, contract, and adapter tests**

```powershell
& "$env:LOCALAPPDATA\hermes\hermes-agent\venv\Scripts\python.exe" -m pytest migration/hermes/plugins/kakao_village/tests -q
```

Expected: all pass with no network access.

- [ ] **Step 6: Commit the adapter checkpoint**

```powershell
git add migration/hermes/plugins/kakao_village
git commit -m "feat: add native Kakao Gateway adapter"
```

---

## Task 3: Add the native confirmation-request tool without semantic routing

**Files:**
- Create: `migration/hermes/plugins/kakao_village/confirmation_tool.py`
- Create: `migration/hermes/plugins/kakao_village/tests/test_confirmation_tool.py`
- Modify: `migration/hermes/plugins/kakao_village/__init__.py`

- [ ] **Step 1: Write failing tool tests**

The handler must accept `handler(args: dict, **kwargs) -> str` and require:

```python
{
    "job_id": "job-1",
    "room_key": "room-1",
    "room_revision": 7,
    "decision": {"should_write_to_sheet": True, "sheet_row_candidate": {}},
}
```

Assert that it forwards the typed payload unchanged except for the schema tag, returns the bridge payload through `tools.registry.tool_result`, propagates an authoritative receipt, and returns `tool_error` for invalid input, bridge refusal, timeout, or stale revision. Assert that it never invents availability rows or customer prose.

- [ ] **Step 2: Run the tool test and confirm RED**

```powershell
& "$env:LOCALAPPDATA\hermes\hermes-agent\venv\Scripts\python.exe" -m pytest migration/hermes/plugins/kakao_village/tests/test_confirmation_tool.py -q
```

- [ ] **Step 3: Implement the handler and exact schema**

Register one tool:

```python
ctx.register_tool(
    name="village_confirmation_request",
    toolset="village",
    schema=CONFIRMATION_REQUEST_SCHEMA,
    handler=handle_confirmation_request,
    description=CONFIRMATION_REQUEST_SCHEMA["function"]["description"],
    emoji="📅",
)
```

The description must state: use this tool only when Hermes decides authoritative schedule/availability confirmation is needed; all returned schedule results require owner review and must never be marked for Kakao auto-send. The handler must call the bridge once and return its server-generated `receipt_id`, `job_id`, `room_revision`, `status`, result rows, and error fields.

- [ ] **Step 4: Run all plugin tests**

```powershell
& "$env:LOCALAPPDATA\hermes\hermes-agent\venv\Scripts\python.exe" -m pytest migration/hermes/plugins/kakao_village/tests -q
```

Expected: all pass.

- [ ] **Step 5: Commit the tool checkpoint**

```powershell
git add migration/hermes/plugins/kakao_village
git commit -m "feat: add native Village confirmation tool"
```

---

## Task 4: Add offline integration fixtures and operator documentation

**Files:**
- Create: `migration/hermes/plugins/kakao_village/tests/fake_bridge.py`
- Create: `migration/hermes/plugins/kakao_village/tests/test_round_trip.py`
- Create: `migration/hermes/plugins/kakao_village/README.md`

- [ ] **Step 1: Write an offline round-trip test**

The fake bridge must serve claim, confirmation tool, final result, and lifecycle outcome endpoints on an ephemeral loopback port. Test a schedule turn where the fake agent calls the tool and then emits final JSON; verify the bridge records the tool receipt before the final answer and receives exactly one final answer. Test a FAQ turn with no tool receipt. No real Gateway, GAS, Sheets, Slack, or Kakao process may be invoked.

- [ ] **Step 2: Confirm RED, implement the fixture, then confirm GREEN**

```powershell
& "$env:LOCALAPPDATA\hermes\hermes-agent\venv\Scripts\python.exe" -m pytest migration/hermes/plugins/kakao_village/tests/test_round_trip.py -q
```

- [ ] **Step 3: Document configuration and non-goals**

Document only variable names and safe examples:

```text
VILLAGE_KAKAO_BRIDGE_URL=http://127.0.0.1:8787
VILLAGE_KAKAO_BRIDGE_TOKEN=<stored outside git>
VILLAGE_KAKAO_CONSUMER_ID=kakaoworker-gateway
```

State explicitly that the plugin does not capture DOM, access GAS credentials, send Kakao messages directly, implement a retry/session engine, or decide business intent.

- [ ] **Step 4: Run the full plugin suite and scan for incomplete markers/secrets**

```powershell
& "$env:LOCALAPPDATA\hermes\hermes-agent\venv\Scripts\python.exe" -m pytest migration/hermes/plugins/kakao_village/tests -q
rg -n "TO[D]O|FIX[M]E|Bearer [A-Za-z0-9]" migration/hermes/plugins/kakao_village
git diff --check
```

The only `<stored outside git>` text may appear in README documentation; no credential value may appear.

- [ ] **Step 5: Commit the completed plugin artifact**

```powershell
git add migration/hermes/plugins/kakao_village
git commit -m "test: verify Kakao Hermes plugin round trip"
```

---

## Plan Acceptance Checklist

- [ ] The clean `village-ai` worktree contains only plugin artifact, tests, and documentation changes.
- [ ] Same-room events map to the same stock Hermes `chat_id`; no custom conversation store exists.
- [ ] Non-final Gateway sends are ignored using `metadata.notify`.
- [ ] Tool output is bridge-authored and correlated to job/revision.
- [ ] All tests pass offline with zero customer or business mutations.
- [ ] No installed profile, Gateway process, scheduled task, or live configuration was changed.
