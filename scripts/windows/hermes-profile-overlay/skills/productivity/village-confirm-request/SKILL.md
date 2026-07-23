---
name: village-confirm-request
description: "Bounded execution and readback layer for Village confirmation-request plans produced with full AI reasoning in village-operations, including multi-schedule batches."
version: 1.1.0
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

`C:/Village/my-gas-project2-worktrees/ax2-hermes-final/scripts/windows/village-confirm-request.js`

Hermes terminal is Git Bash, but `node` is a native Windows executable; always pass the `C:/Village/...` path above.

## AI planning contract

1. Read the entire request and infer the complete plan: pickup/return date and time, requester, optional contact/discount/note, and all top-level items with quantities.
2. Resolve aliases using broad catalog/master searches, shorter distinctive probes, spelling/case/transliteration variants, visible context, preserved equipment notes, and bundle-to-quantity normalization. Ask only if materially different models remain after those checks.
3. When equipment groups have different return dates or times, split them automatically into the minimum number of confirmation requests. Do not ask whether to split when the grouping is explicit in the source.
4. Normalize dates to `YYYY-MM-DD`, times to `HH:MM`, and equipment to exact catalog names before calling the runner.

## Execution

For one planned schedule, use `create`. For multiple AI-planned schedule groups, use `create-batch` in one command:

```bash
python - <<'PY' | node 'C:/Village/my-gas-project2-worktrees/ax2-hermes-final/scripts/windows/village-confirm-request.js' create-batch
import json
print(json.dumps({"requests":[
  {"반출일":"2026-07-31","반출시간":"06:00","반납일":"2026-08-02","반납시간":"06:00","예약자명":"예약자","장비":[{"이름":"소니 FX3 풀세트","수량":2}]},
  {"반출일":"2026-07-31","반출시간":"06:00","반납일":"2026-08-01","반납시간":"06:00","예약자명":"예약자","장비":[{"이름":"파보튜브 II 30X","수량":2}]}
]}, ensure_ascii=False), end='')
PY
```

The batch command catalog-preflights every group before the first write, inserts each planned group once, and readbacks each resulting `RQ-...` ID. For a single group the payload remains:

```bash
printf '%s' '{"반출일":"2026-07-23","반출시간":"05:00","반납일":"2026-07-23","반납시간":"14:00","예약자명":"예약자","장비":[{"이름":"정확한 카탈로그명","수량":1}]}' | node 'C:/Village/my-gas-project2-worktrees/ax2-hermes-final/scripts/windows/village-confirm-request.js' create
```

Treat the result as complete only when every item contains `verified:true`, a valid `RQ-...` ID, and readback rows for all intended top-level items. Report all IDs, schedule groups, equipment/quantities, availability, and any warning concisely.

## Hard limits

- Exactly one `insertAndCheckRequest` attempt per AI-planned schedule group. The runner never retries a write.
- Never call `updateRequest`, `updateRequestItem`, `excludeEquipFromRequest`, or a second insert to repair an uncertain interpretation. Resolve the whole payload before create.
- A missing/failed readback is an uncertain write outcome. In a batch, report already completed RQ IDs and never retry them automatically.
- This route cannot send an 알림톡/customer-facing message and cannot perform final reservation registration. Those require a separate explicit owner approval and the broader `village-operations` route.
- Normal Hermes self-improvement may retain a verified alias or reusable workflow lesson after the user-facing operation. Learning must not be disabled as a speed optimization.
- Never print credentials, environment files, or the API key.
