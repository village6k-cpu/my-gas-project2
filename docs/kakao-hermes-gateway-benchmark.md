# Kakao Hermes Gateway benchmark gate

Date: 2026-08-22  
Decision: **ACCEPTED — eligible for the guarded live cutover gate**

## Provider-backed result

- measured requests: baseline 20, Gateway 20
- median: 26.219s -> 3.238s (87.6% improvement)
- P95: 47.841s -> 11.896s (75.1% improvement)
- persistent-session reuse: 100%
- schedule owner-review: 100%
- process starts/request: 0.0
- post-action agent runs/schedule: 0.0
- Kakao sends: 0; live writes: 0
- comparable model/provider/reasoning/tools/skills: true
- blockers: none

## Machine-generated analyzer result

Input: `docs/kakao-hermes-gateway-benchmark-evidence.json`

```json
{"schema":"village-kakao-hermes-benchmark-report/v1","measurement_kind":"provider_backed","sample_count":20,"baseline_sample_count":20,"baseline_total_median_ms":26219.165500000003,"baseline_total_p95_ms":47841.383,"gateway_total_median_ms":3238.453,"gateway_total_p95_ms":11895.724,"gateway_agent_median_ms":3238.453,"gateway_agent_p95_ms":11895.724,"process_starts_per_request":0.0,"post_action_agent_runs_per_schedule":0.0,"session_reuse_rate":1.0,"schedule_owner_review_rate":1.0,"send_count":0,"write_count":0,"median_improvement_rate":0.8764852756278608,"p95_improvement_rate":0.7513507500399811,"comparable_config":true,"latency_status":"pass","accepted":true,"blockers":[]}
```

This report authorizes only the next guarded cutover gate. It does not by itself authorize customer sends or business-data writes.
