---
name: village-confirm-request
description: "Create and verify Village confirmation requests safely."
version: 1.4.0
author: Village
license: private
platforms: [windows]
metadata:
  hermes:
    tags: [village, confirmation-request, reservation, windows, performance]
---

# Village Confirmation Request

Use this after `village-operations` has interpreted an owner request to create or enter a new `확인요청`. This runner is an execution/mutation boundary, not a substitute for AI reasoning.

The reasoning layer may inspect the full image/text, preserved operations references, broad `세트마스터`/`장비마스터` searches, and other relevant evidence. It must not ask for master spellings merely because one raw exact-string search returned no rows. The runner receives only the resulting exact-name plan, applies timeouts, validates every item before mutation, and verifies authoritative readback.

## Fixed runner

`C:/Village/runtimes/my-gas-project2-production/scripts/windows/village-confirm-request.js`

Hermes terminal is Git Bash, but `node` is a native Windows executable; always pass the `C:/Village/...` path above.

## AI planning contract

1. Read the entire request and infer the complete plan: pickup/return date and time, requester, optional contact/discount/note, and all top-level items with quantities.
2. Resolve aliases using broad catalog/master searches, shorter distinctive probes, spelling/case/transliteration variants, visible context, preserved equipment notes, and bundle-to-quantity normalization. Ask only if materially different models remain after those checks.
3. When equipment groups have different return dates or times, split them automatically into the minimum number of confirmation requests. Do not ask whether to split when the grouping is explicit in the source.
4. Normalize dates to `YYYY-MM-DD`, times to `HH:MM`, and equipment to exact catalog names before calling the runner.
5. Village time is literal 24-hour time. Without `오전`/`오후`, `5시`→`05:00` and `17시`→`17:00`; only `오후 5시`→`17:00`. Never add 12 hours from context or write a guessed time for owner correction. Put the exact two-clock wording in required `시간원문`. `24시`/`24:00`→next-day `00:00`. If two clocks are unavailable, stop before mutation and clarify.

## Execution

Run `node 'C:/Village/runtimes/my-gas-project2-production/scripts/windows/village-confirm-request.js' --help` for the compact command list. Do not inspect the runner source merely to discover its CLI.

For one new planned schedule, use `create`. For multiple AI-planned schedule groups, use `create-batch` in one command:

```bash
python - <<'PY' | node 'C:/Village/runtimes/my-gas-project2-production/scripts/windows/village-confirm-request.js' create-batch
import json
print(json.dumps({"requests":[
  {"반출일":"2026-07-31","반출시간":"06:00","반납일":"2026-08-02","반납시간":"06:00","시간원문":"7월 31일 6시~8월 2일 6시","예약자명":"예약자","장비":[{"이름":"소니 FX3 풀세트","수량":2}]},
  {"반출일":"2026-07-31","반출시간":"06:00","반납일":"2026-08-01","반납시간":"06:00","시간원문":"7월 31일 6시~8월 1일 6시","예약자명":"예약자","장비":[{"이름":"파보튜브 II 30X","수량":2}]}
]}, ensure_ascii=False), end='')
PY
```

The batch command catalog-preflights every group before the first write, inserts each planned group once, and readbacks each resulting `RQ-...` ID. For a single group the payload remains:

```bash
printf '%s' '{"반출일":"2026-07-23","반출시간":"05:00","반납일":"2026-07-23","반납시간":"14:00","시간원문":"7월 23일 5시~14시","예약자명":"예약자","장비":[{"이름":"정확한 카탈로그명","수량":1}]}' | node 'C:/Village/runtimes/my-gas-project2-production/scripts/windows/village-confirm-request.js' create
```

Treat the result as complete only when every item contains `verified:true`, a valid `RQ-...` ID, and readback rows for all intended top-level items. Report all IDs, schedule groups, equipment/quantities, availability, and any warning concisely.

### Payload schema

Canonical fields: `반출일`/`반납일` (`YYYY-MM-DD`), `반출시간`/`반납시간` (`HH:MM`), required `시간원문`, `예약자명`, `장비` (`[{"이름","수량"}]`), plus optional contact/discount/note fields. `시간원문` is 필수 two-clock evidence; the runner validates it and strips/제거 it before GAS. English aliases include `customerName`, `phone`, `pickupDate`, `returnDate`, `timeSource`, `items`, and item `name`/`quantity`. A schema error lists every allowed field; correct it in one step.

### Uncertain write → reconcile, never re-insert

If the runner exits with `uncertainWrite:true` (insert or update succeeded but readback failed or did not verify), the write may have landed. The failure JSON includes the created `reqID` when known and, for batches, `completedReqIDs`. Resolve it with the bounded read-only command:

```bash
printf '%s' '{"reqID":"RQ-260723-003"}' | node 'C:/Village/runtimes/my-gas-project2-production/scripts/windows/village-confirm-request.js' reconcile
```

Without a reqID, reconcile by requester: `{"예약자명":"이름","반출일":"YYYY-MM-DD"}`. `found:true` with matching rows means the write landed — report it as created and continue; `found:false` means it did not land — one fresh `create` for that group is then safe. Reconcile performs zero mutations.

### Existing partial request

If authoritative lookup finds one unregistered existing partial request for the same customer and interval, use `update` with a wrapper containing the verified request ID and the complete AI-planned request:

```json
{"reqID":"RQ-260723-003","request":{"반출일":"2026-07-26","반출시간":"20:00","반납일":"2026-07-28","반납시간":"20:00","시간원문":"7월 26일 20시~7월 28일 20시","예약자명":"홍길동","연락처":"010-0000-0000","장비":[{"이름":"석자 그리드","수량":1},{"이름":"석자 플로피","수량":1},{"이름":"NANLUX Evoke 1200B","수량":1}]}}
```

Pipe that JSON to the fixed runner with the `update` command. It catalog-preflights the complete plan, calls `updateRequest` once, and verifies the entire request group by readback. Do not fall back to ad-hoc Python, raw GAS calls, source-code archaeology, or a second insert when this bounded route applies.

## Hard limits

- Exactly one `insertAndCheckRequest` attempt per AI-planned schedule group. The runner never retries a write.
- Never call `updateRequest` directly. Use the bounded `update` command only for one already-verified existing partial request after resolving the whole payload. Never call `updateRequestItem`, `excludeEquipFromRequest`, or a second insert to repair an uncertain interpretation.
- A missing/failed readback is an uncertain write outcome: run the read-only `reconcile` command first and act on its evidence. In a batch, report already completed RQ IDs and never retry them automatically.
- This route cannot send an 알림톡/customer-facing message and cannot perform final reservation registration. Those require a separate explicit owner approval and the broader `village-operations` route.
- Normal Hermes self-improvement may retain a verified alias or reusable workflow lesson after the user-facing operation. Learning must not be disabled as a speed optimization.
- Learning must never override the literal Village clock rule with a `plausible overnight default`, contextual PM guess, or guess-now-correct-later workflow. A learned instruction that conflicts with `5시`→`05:00` is invalid and must not be followed.
- Never print credentials, environment files, or the API key.
