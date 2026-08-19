# Village 확인요청 고객DB 우선 보강

Use this when Village Kakao DOM watcher / AI worker / GAS 확인요청 flows need to fill customer segment/discount type (`할인유형`, 확인요청 M열).

## Durable rule

카톡 대화/LLM 추정보다 **빌리지 2.0 / 개고생2.0 `고객DB`의 I열 `할인유형`이 우선**이다.

Supported normalized values:

- `일반`
- `학생`
- `개인사업자/프리랜서`
- `단골`
- `제휴`

If Kakao text is silent or the AI inferred `일반`, but 고객DB says `학생`/`단골`/`개인사업자/프리랜서`/`제휴`, the final 확인요청 payload and M열 must use the DB value.

연락처가 없어도 확인요청 생성 자체를 막지 않는다. 고객DB에서 이름이 단일 매칭되면 L열을 보강하고, 매칭이 없거나 동명이인이면 L열 공란으로 RQ를 생성한 뒤 등록 전 연락처를 확인한다. 연락처 필수는 `등록` 단계의 규칙이지 `확인요청` 생성 차단 조건이 아니다.

## Where to implement/check

Project: `C:\Village\runtimes\my-gas-project2-production`

Important files:

- `tools/ai-browser-worker/worker.mjs`
  - Before `appendToSheet`, enrich `insertAndCheckRequest` payload from Village 2.0 고객DB `A,B,I`.
  - Normalize phone before matching; prefer phone match, then name fallback.
  - Include lookup details in worker result (`customerDbDiscountLookup`, `discountPatchResult`) so status/debug output proves the enrichment happened.
- `checkAvailability.js`
  - GAS `insertAndCheckRequest` should repeat the same DB-first enrichment as a second guard before dedupe and row append.
  - `reqForDedupe` should include both resolved phone and resolved discount so downstream duplicate/check logic sees the final customer identity/segment.
- `Code.js`
  - Manual/trigger lookup (`lookupDiscountForSelectedRow`, `lookupDiscountFromCustomerDB`) should not be limited to only `단골`/`제휴`; it should accept all normalized DB values above and overwrite M열 when DB has a value.
- `tools/kakao-dom-bridge/README.md` / worker prompt text
  - Remove stale instructions like “AI must never write 단골/제휴.” Replace with “고객DB I열 outranks Kakao text.”

## Verification pattern

Run unit/static tests:

```bash
cd /c/Village/runtimes/my-gas-project2-production
node --test test/confirm-request-*.test.js test/confirm-request-*.static.test.js
node --test tools/ai-browser-worker/worker.test.mjs
```

Do a read-only live DB probe before claiming success:

1. Read Village 2.0 `고객DB` via GViz `SELECT A,B,I`.
2. Pick a row with normalized `할인유형` (for example `단골` or `제휴`).
3. Build a fake `insertAndCheckRequest` payload where Kakao/AI says `일반`.
4. Run the worker enrichment function in dry-run/read-only mode.
5. Success means the enriched payload’s `args.할인유형` equals the DB value and no sheet write happened.

Expected proof shape:

```json
{
  "lookupMatched": true,
  "matchedBy": "phone",
  "beforeDiscount": "일반",
  "afterDiscount": "단골",
  "overridesKakaoGeneral": true
}
```

## Pitfalls

- The older GAS Web App `action=info&sheet=고객DB` may expose only A/B headers. That does **not** prove I열 is absent. Use the Village 2.0 GViz path or Apps Script openById/openByUrl fallback to read A,B,I.
- Do not rely only on worker logs. If GAS normalizes or overwrites values, search the returned RQ row and patch/verify M열 when necessary.
- Existing tests may assert older exact source snippets such as `Object.assign({}, req, { 연락처: resolvedPhone })`; update static tests when the correct source now includes `할인유형: resolvedDiscount`.
- After local code changes, `clasp push` alone is not sufficient for deployed GAS web-app behavior; update the deployed web app with the known deployment ID, then restart/check the Kakao automation bridge if the live worker may have cached old code.
