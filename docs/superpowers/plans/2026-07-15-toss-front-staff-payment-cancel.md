# Toss Front Staff Payment Cancel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 직원 설정 화면에서 동일 Toss Front 단말의 최근 결제를 안전하게 전액 취소하고 예약 장부를 `환불`로 동기화한다.

**Architecture:** `settings.html`이 설정 페이지 모드를 선언하고 기존 `app.js`를 로드한다. `app.js`는 Toss 결제 응답을 취소 가능한 공통 레코드로 정규화하고 공식 `requestPaymentCancel`만 호출하며, 예약 결제의 장부 반영은 새 `POST /api/lookup/cancel`이 GAS `updateTradeProof`로 처리한다.

**Tech Stack:** ES5-compatible browser JavaScript, Toss Front SDK v0 Template/Payment/Storage APIs, Next.js 15 Route Handlers, existing Node static regression tests, shell ZIP verification.

## Global Constraints

- 직원 접근은 `프론트 설정 → 7055 → 플러그인 설정` 안에서만 제공한다.
- 고객용 첫 화면에는 취소 메뉴를 노출하지 않는다.
- 전액 취소만 지원하며 실제 카드 승인·취소를 자동 테스트에서 실행하지 않는다.
- Toss 화면은 `sdk.template.*`만 사용하고 Toss 관리 DOM을 직접 변경하지 않는다.
- Toss 승인취소가 성공하기 전에는 예약 장부를 변경하지 않는다.
- 로컬 또는 Toss 취소 캐시로 중복 취소를 차단한다.
- ZIP 최상위 항목은 `index.html`, `settings.html`, `app.js`, `config.js` 네 파일을 유지한다.
- main 통합과 GAS/Vercel 배포는 저장소의 `scripts/integrate.sh` 흐름만 사용한다.

---

### Task 1: 결제 응답 정규화와 취소 가능 레코드 저장

**Files:**
- Create: `test/toss-front-payment-cancel.static.test.js`
- Modify: `toss-front-plugin/village-front/app.js:191-294`

**Interfaces:**
- Consumes: Toss `requestPayment` 또는 `getPayment`의 `{ type, response }`와 기존 `receiptRecords`.
- Produces: `normalizePaymentResponse(response, amount)`, `hasCancelDetails(record)`, 확장된 receipt record 필드.

- [ ] **Step 1: 취소 필수정보를 요구하는 실패 테스트 작성**

```js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const app = fs.readFileSync(path.join(__dirname, '..', 'toss-front-plugin/village-front/app.js'), 'utf8');

assert(app.includes('function normalizePaymentResponse(response, amount)'));
assert(/paymentMethod:\s*normalized\.paymentMethod/.test(app));
assert(/timestamp:\s*normalized\.timestamp/.test(app));
assert(/installment:\s*normalized\.installment/.test(app));
assert(/extraData:\s*normalized\.extraData/.test(app));
assert(/tax:\s*normalized\.tax/.test(app));
assert(/supplyValue:\s*normalized\.supplyValue/.test(app));
```

- [ ] **Step 2: RED 확인**

Run: `node test/toss-front-payment-cancel.static.test.js`

Expected: FAIL because `normalizePaymentResponse` and normalized receipt fields do not exist.

- [ ] **Step 3: 결제수단별 응답을 공통 레코드로 정규화**

```js
function normalizePaymentResponse(response, amount) {
  var r = response || {};
  var method = r.paymentMethod || null;
  var detail = method === 'CARD'
    ? r.card
    : method === 'BARCODE'
      ? r.barcode
      : r.cash && r.cash.cashReceipt;
  detail = detail || {};
  var paidAmount = Number(amount) || 0;
  var tax = Math.floor(paidAmount / 11);
  return {
    paymentMethod: method,
    amount: paidAmount,
    tax: tax,
    supplyValue: paidAmount - tax,
    tip: 0,
    timestamp: detail.timestamp || null,
    approvalNumber: detail.approvalNumber || null,
    installment: detail.installment || 0,
    extraData: r.extraData || null,
    isSelfIssuance: Boolean(detail.isSelfIssuance)
  };
}

function hasCancelDetails(record) {
  return Boolean(
    record && record.paymentKey && record.paymentMethod &&
    Number(record.amount) > 0 && record.timestamp && record.approvalNumber
  );
}
```

`requestCardPayment`은 `normalizePaymentResponse(r, price)`를 결과에 합치고, `rememberReceiptRecord`는 위 필드를 `receiptRecords`에 저장한다. `recoverPending`도 `found.response`를 같은 정규화 함수로 통과시킨다.

- [ ] **Step 4: GREEN 및 기존 영수증 테스트 확인**

Run: `node test/toss-front-payment-cancel.static.test.js && node test/toss-front-receipt-printing.static.test.js && node --check toss-front-plugin/village-front/app.js`

Expected: PASS for all three commands.

- [ ] **Step 5: Task 1 커밋**

```bash
git add test/toss-front-payment-cancel.static.test.js toss-front-plugin/village-front/app.js
git commit -m "feat: 토스 취소용 승인정보 저장"
```

---

### Task 2: 직원 설정 취소 UI와 공식 Toss 전액 취소

**Files:**
- Modify: `test/toss-front-payment-cancel.static.test.js`
- Modify: `test/toss-front-settings-entry.static.test.js`
- Modify: `toss-front-plugin/village-front/app.js:113-122,353-790`
- Modify: `toss-front-plugin/village-front/settings.html:1-100`

**Interfaces:**
- Consumes: Task 1의 `hasCancelDetails(record)`, `normalizePaymentResponse`, `loadReceiptRecords`, `saveReceiptRecords`.
- Produces: `showStaffSettings`, `showCancelablePayments`, `hydrateCancelRecord`, `requestFullPaymentCancel`, `markPaymentCancelled`.

- [ ] **Step 1: 직원 모드·공식 취소·중복 방지 실패 테스트 확장**

```js
assert(/window\.VILLAGE_PAGE_MODE\s*=\s*['"]settings['"]/.test(settings));
assert(settings.includes('./app.js'));
assert(!settings.includes('<style>'));
assert(/VILLAGE_PAGE_MODE\s*===\s*['"]settings['"]/.test(app));
assert(app.includes('최근 결제 취소'));
assert(/sdk\.payment\.requestPaymentCancel\(\{/.test(app));
assert(/sdk\.payment\.getPaymentCancel\(\{\s*paymentKey:/.test(app));
assert(!/showIdle[\s\S]{0,900}결제 취소/.test(app));
assert(app.includes('cancelledAt'));
assert(app.includes('cancelSyncPending'));
```

- [ ] **Step 2: RED 확인**

Run: `node test/toss-front-payment-cancel.static.test.js && node test/toss-front-settings-entry.static.test.js`

Expected: FAIL because settings mode and cancellation flow do not exist.

- [ ] **Step 3: settings.html을 Template 기반 직원 모드 진입점으로 변경**

```html
<body>
  <div id="app"></div>
  <script src="./config.js"></script>
  <script>window.VILLAGE_PAGE_MODE = 'settings';</script>
  <script src="./app.js"></script>
</body>
```

기존 진단용 직접 HTML/CSS와 인라인 `loadSettings`를 제거한다.

- [ ] **Step 4: 최근 결제 목록·복구·이중 확인 구현**

```js
async function hydrateCancelRecord(record) {
  if (hasCancelDetails(record)) return record;
  if (!sdk.payment || typeof sdk.payment.getPayment !== 'function') {
    throw new Error('이 결제의 승인정보를 복구할 수 없습니다.');
  }
  var result = await sdk.payment.getPayment({ paymentKey: record.paymentKey });
  if (!result || result.type !== 'SUCCESS') throw new Error('최근 승인정보를 찾지 못했습니다.');
  return Object.assign({}, record, normalizePaymentResponse(result.response, record.amount));
}

async function requestFullPaymentCancel(record) {
  return sdk.payment.requestPaymentCancel({
    paymentKey: record.paymentKey,
    paymentMethod: record.paymentMethod,
    tax: record.tax,
    supplyValue: record.supplyValue,
    tip: record.tip || 0,
    timestamp: record.timestamp,
    approvalNumber: record.approvalNumber,
    installment: record.installment || 0,
    timeoutMs: 60000,
    extraData: record.extraData || undefined,
    isSelfIssuance: record.isSelfIssuance || false,
    localeCode: 'ko'
  });
}
```

`showStaffSettings`는 `최근 결제 취소` 옵션만 제공한다. `showCancelablePayments`는 `!cancelledAt`인 최근 20건을 표시한다. 선택 시 `hydrateCancelRecord` 후 거래 상세를 보여주고, 별도의 `전액 취소` 버튼으로 최종 실행한다.

- [ ] **Step 5: 중복 차단·성공 기록·장부 보류 상태 구현**

실행 직전 `getPaymentCancel({ paymentKey })`가 `SUCCESS`면 Toss를 다시 호출하지 않고 로컬을 취소 완료로 맞춘다. 새 취소 성공이면 해당 레코드에 아래 값을 저장한다.

```js
{
  cancelledAt: new Date().toISOString(),
  cancelApprovalNumber: cancelDetail.approvalNumber || null,
  cancelSyncPending: record.sourceType === 'reservation'
}
```

`CANCELED`, `TIMEOUT`, 예외는 로컬 완료로 기록하지 않는다. 요청 중 전역 `cancelInFlight`가 참이면 추가 실행을 거부한다.

- [ ] **Step 6: GREEN 및 고객 홈 비노출 확인**

Run: `node test/toss-front-payment-cancel.static.test.js && node test/toss-front-settings-entry.static.test.js && node test/toss-front-idle-background.static.test.js && node --check toss-front-plugin/village-front/app.js`

Expected: PASS; 고객 `showIdle` 옵션에는 취소 문구가 없다.

- [ ] **Step 7: Task 2 커밋**

```bash
git add test/toss-front-payment-cancel.static.test.js test/toss-front-settings-entry.static.test.js toss-front-plugin/village-front/app.js toss-front-plugin/village-front/settings.html
git commit -m "feat: 직원 전용 토스 전액 취소 화면 추가"
```

---

### Task 3: 예약 장부 환불 API와 실패 재시도

**Files:**
- Create: `apps/today-dashboard/app/api/lookup/cancel/route.ts`
- Modify: `test/toss-front-payment-cancel.static.test.js`
- Modify: `test/toss-front-lookup-cors.static.test.js`
- Modify: `toss-front-plugin/village-front/app.js:124-186,260-350`

**Interfaces:**
- Consumes: `{ tradeId, paymentKey, amount, cancelApprovalNumber }`와 기존 `gasPost`.
- Produces: `POST /api/lookup/cancel`, `syncCancelledReservation(record)`, `retryPendingCancelSyncs()`.

- [ ] **Step 1: 장부 환불 계약 실패 테스트 작성**

```js
const cancelRoute = read('apps/today-dashboard/app/api/lookup/cancel/route.ts');
assert(cancelRoute.includes('x-lookup-token'));
assert(/export async function OPTIONS\(\)/.test(cancelRoute));
assert(cancelRoute.includes('action: "updateTradeProof"'));
assert(cancelRoute.includes('field: "depositStatus"'));
assert(cancelRoute.includes('value: "환불"'));
assert(/record\.sourceType\s*===\s*['"]reservation['"]/.test(app));
assert(app.includes('/api/lookup/cancel'));
```

- [ ] **Step 2: RED 확인**

Run: `node test/toss-front-payment-cancel.static.test.js && node test/toss-front-lookup-cors.static.test.js`

Expected: FAIL because the cancel route and sync call do not exist.

- [ ] **Step 3: 토큰·CORS·검증을 포함한 cancel Route Handler 구현**

```ts
interface CancelBody {
  tradeId?: string;
  paymentKey?: string;
  amount?: number;
  cancelApprovalNumber?: string;
}

const gasResult = await gasPost({
  action: "updateTradeProof",
  tid: tradeId.trim(),
  field: "depositStatus",
  value: "환불",
});
```

`LOOKUP_TOKEN` 미설정은 503, 토큰 불일치는 401, JSON 오류 또는 빈 `tradeId/paymentKey`는 400, GAS 실패는 502를 CORS 헤더와 함께 반환한다. 성공 응답은 `ok`, `tradeId`, `paymentKey`, `amount`, `cancelApprovalNumber`, `depositStatus: "환불"`, `gasResult`를 포함한다.

- [ ] **Step 4: 프론트 장부 동기화와 재시도 구현**

```js
async function syncCancelledReservation(record) {
  if (!record || record.sourceType !== 'reservation' || !record.tradeId) return;
  var res = await fetch(CFG.LOOKUP_BASE + '/api/lookup/cancel', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-lookup-token': CFG.LOOKUP_TOKEN },
    body: JSON.stringify({
      tradeId: record.tradeId,
      paymentKey: record.paymentKey,
      amount: record.amount,
      cancelApprovalNumber: record.cancelApprovalNumber || null
    })
  });
  if (!res.ok) throw new Error(await errMsg(res, '환불 장부 반영 실패'));
}
```

취소 성공 후 호출이 성공하면 `cancelSyncPending=false`, 실패하면 `true`를 유지한다. `retryPendingCancelSyncs`는 설정 모드 시작 때 `cancelledAt && cancelSyncPending`인 예약만 재시도하고 Toss 취소 API는 호출하지 않는다.

- [ ] **Step 5: GREEN 및 Next 빌드 확인**

Run: `node test/toss-front-payment-cancel.static.test.js && node test/toss-front-lookup-cors.static.test.js && npm run build`

Working directory for build: `apps/today-dashboard`

Expected: PASS and route table includes `/api/lookup/cancel`.

- [ ] **Step 6: Task 3 커밋**

```bash
git add apps/today-dashboard/app/api/lookup/cancel/route.ts test/toss-front-payment-cancel.static.test.js test/toss-front-lookup-cors.static.test.js toss-front-plugin/village-front/app.js
git commit -m "feat: 토스 취소 장부 환불 동기화"
```

---

### Task 4: 회귀검증, 문서, ZIP 및 배포

**Files:**
- Modify: `toss-front-plugin/README.md`
- Verify: `toss-front-plugin/build-zip.sh`

**Interfaces:**
- Consumes: Tasks 1-3의 완성된 취소 흐름.
- Produces: 운영 가능한 ZIP, main/Vercel/GAS 배포 증거, 단말 업로드 인계.

- [ ] **Step 1: README에 직원 취소 경로와 한계 기록**

다음 내용을 추가한다.

```md
### 직원 결제 취소
- 프론트 설정 → 7055 → 플러그인 설정 → 최근 결제 취소
- 이 플러그인과 동일 단말에서 승인정보를 확보한 결제만 전액 취소
- 예약 결제는 취소 성공 후 입금상태가 `환불`로 반영됨
- 부분 취소와 타 단말 결제는 토스 터미널에서 처리
```

- [ ] **Step 2: 전체 정적·문법·프로덕션 빌드 실행**

Run:

```bash
set -e
for f in test/*.static.test.js; do node "$f" >/dev/null; done
node --check toss-front-plugin/village-front/app.js
bash -n toss-front-plugin/build-zip.sh
cd apps/today-dashboard && npm run build
```

Expected: all commands exit 0 and Next route table contains `/api/lookup/cancel`.

- [ ] **Step 3: SDK mock 브라우저 검증**

로컬 테스트 페이지에서 `requestPayment`, `requestPaymentCancel`, `getPayment`, `getPaymentCancel`, `storage`를 모사한다. 직원 설정 목록 → 상세 → 전액 취소 확인 → 성공 결과를 따라가며 호출 payload가 한 건이고 `paymentKey`, `timestamp`, `approvalNumber`, `tax`, `supplyValue`가 일치하는지 확인한다. 두 번째 클릭은 호출 수를 늘리지 않아야 한다.

- [ ] **Step 4: ZIP 재생성·동일성 확인**

Run:

```bash
./toss-front-plugin/build-zip.sh
test "$(unzip -Z1 toss-front-plugin/village-front.zip | sort | tr '\n' ' ')" = "app.js config.js index.html settings.html "
test "$(shasum -a 256 toss-front-plugin/village-front/app.js | awk '{print $1}')" = "$(unzip -p toss-front-plugin/village-front.zip app.js | shasum -a 256 | awk '{print $1}')"
```

Expected: four exact entries and matching `app.js` hashes.

- [ ] **Step 5: 문서 변경 커밋 후 독립 리뷰 1회**

```bash
git add toss-front-plugin/README.md
git commit -m "docs: 토스 직원 취소 운영 절차 추가"
```

Critical/Important 지적만 수정하고 관련 테스트를 다시 실행한다.

- [ ] **Step 6: feature push 및 main 통합 배포**

Run from feature worktree:

```bash
./scripts/finishbranch.sh "feat: 토스 프론트 직원 결제 취소"
```

Run from canonical main after preserving unrelated user changes:

```bash
./scripts/integrate.sh codex/toss-front-cancel "feat: 토스 프론트 직원 결제 취소"
```

Expected: all integration tests pass, GAS deployment id is printed, and `origin/main` advances.

- [ ] **Step 7: 운영 API와 업로드 ZIP 확인**

Run:

```bash
curl -sS -o /dev/null -w '%{http_code}' -X OPTIONS https://today-dashboard-ten.vercel.app/api/lookup/cancel
curl -sS -o /dev/null -w '%{http_code}' -X POST https://today-dashboard-ten.vercel.app/api/lookup/cancel
```

Expected: `204` then `401`. 토스 개발자센터 로그인이 가능하면 ZIP 업로드 직전 사용자 확인을 받고 업로드하며, 로그인 또는 확인이 없으면 정확한 인계 경로를 보고한다.
