# Kakao Hermes Gateway benchmark gate

Date: 2026-08-22  
Decision: **BLOCKED — not approved for live Gateway cutover**

## What is proven

The sanitized offline lifecycle replay completed 20 structural samples with the reviewed Kakao platform plugin and an authenticated loopback fake bridge. It proved:

- no per-turn child process start;
- no post-action Hermes run for schedule cases;
- stable same-room session keys;
- every schedule result remained owner-review;
- zero Kakao sends, Slack sends, and live writes.

The benchmark plan generator requires one warm-up plus 20 measured turns for both `baseline` and `gateway`, using the unchanged `grok-4.5` / `xai-oauth` / `xhigh` / 90-turn contract.

## What is not proven

The 20 current Gateway timings are local adapter/tool/HTTP fixture timings. They do **not** include provider inference, model queueing, real skill/tool loading, or a persistent provider-backed Hermes agent. They therefore cannot be compared to the 23 completed production one-shot outcomes whose median was 176.3 seconds and P95 was 246.3 seconds.

The 2026-08-20 baseline did not retain exact tool and skill signatures, so current and baseline configuration equality is also unproven. The analyzer intentionally blocks acceptance even though the raw local fixture numbers are small.

## Machine-generated analyzer result

Input: `docs/kakao-hermes-gateway-benchmark-evidence.json`

```json
{"schema":"village-kakao-hermes-benchmark-report/v1","measurement_kind":"offline_structural","sample_count":20,"baseline_sample_count":23,"baseline_total_median_ms":176300.0,"baseline_total_p95_ms":246300.0,"gateway_total_median_ms":4.195,"gateway_total_p95_ms":28.706,"gateway_agent_median_ms":4.195,"gateway_agent_p95_ms":28.706,"process_starts_per_request":0.0,"post_action_agent_runs_per_schedule":0.0,"session_reuse_rate":1.0,"schedule_owner_review_rate":1.0,"send_count":0,"write_count":0,"median_improvement_rate":0.9999762053318207,"p95_improvement_rate":0.9998834510759237,"comparable_config":false,"latency_status":"blocked","accepted":false,"blockers":["provider_backed_measurement_required","model_provider_reasoning_tools_or_skills_drift"]}
```

The apparent improvement rates above are reported for transparency but are not acceptance evidence because `latency_status` is `blocked`.

## Remaining acceptance run

Before cutover, capture provider-backed evidence with:

1. one warm-up and at least 20 completed turns per mode;
2. identical model, provider, reasoning, max turns, tools, and skills;
3. a single persistent native Gateway process for the Gateway samples;
4. zero sends and live writes;
5. median improvement of at least 40% and P95 improvement of at least 30%.

Generate the deterministic run plan with:

```powershell
C:\Users\ssper\AppData\Local\hermes\hermes-agent\venv\Scripts\python.exe scripts/windows/hermes-village-benchmark-invoke.py --ab-plan --replay-fixture tools/kakao-dom-bridge/fixtures/hermes-gateway-replay.json --model-contract scripts/windows/hermes-model-contract.json --output-plan <isolated-output.json> --sample-count 20 --warmup-count 1
```

Analyze captured evidence with:

```powershell
C:\Users\ssper\AppData\Local\hermes\hermes-agent\venv\Scripts\python.exe scripts/windows/hermes-village-benchmark-analyze.py --ab-evidence <provider-backed-evidence.json>
```

Only `accepted=true` and `latency_status=pass` authorize the next cutover gate.
