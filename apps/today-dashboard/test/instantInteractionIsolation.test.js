const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const appRoot = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(appRoot, file), "utf8");

function section(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `${startMarker} 구현을 찾을 수 있어야 한다`);
  return source.slice(start, end);
}

test("백그라운드 동기화 상태는 카드 전체 busy로 노출하지 않는다", () => {
  const today = read("components/TodayView.tsx");
  const card = read("components/ScheduleCard.tsx");
  const actions = read("components/TradeActions.tsx");

  assert.doesNotMatch(today, /savingTrades|saving=\{/,
    "내부 동기화 상태를 ScheduleCard prop으로 전달하면 안 된다");
  assert.doesNotMatch(card, /\bsaving\b|백그라운드 동기화|상태 변경 중/,
    "카드 전체가 저장 상태를 표시하거나 완료 버튼을 막으면 안 된다");
  assert.doesNotMatch(actions, /\bbusy\b/,
    "편집·할인·취소·삭제를 하나의 busy로 묶으면 안 된다");
});

test("내부 원장 동기화는 전역 저장 중 토스트를 띄우지 않는다", () => {
  const store = read("lib/data/store.ts");
  const begin = section(store, "function beginTradeSave", "\nfunction beginTradeTransition");
  const snapshot = section(store, "type DashboardSnapshot", "\nlet dashSnapshot");

  assert.doesNotMatch(begin, /toast:\s*\{|저장 중|kind:\s*"saving"/,
    "서버 왕복 시간 동안 전역 저장 중 토스트를 띄우면 안 된다");
  assert.doesNotMatch(snapshot, /savingTrades/,
    "내부 동기화 토큰 변경이 화면 전체 재렌더를 일으키면 안 된다");
});

test("일상 결제 필드는 화면을 먼저 바꾸고 원장 대기는 내부 동기화로만 남긴다", () => {
  const store = read("lib/data/store.ts");
  const controls = read("components/PaymentControls.tsx");
  const payment = section(store, "export async function setPaymentMethod", "\nasync function setTradeProofField_");
  const proof = section(store, "async function setTradeProofField_", "\nexport function setDepositStatus");
  const billing = section(store, "export async function setBillingCompany", "\n// 확인요청 M열");

  for (const [label, source] of [["결제수단", payment], ["증빙", proof], ["발행처", billing]]) {
    assert.ok(source.indexOf("mutateTrade(") < source.indexOf("beginTradeSave("),
      `${label}은 서버 저장 표시보다 화면 값을 먼저 바꿔야 한다`);
    assert.match(source, /await gasMutationRetrying/,
      `${label} 원장 성공 확인과 실패 롤백은 유지해야 한다`);
  }

  assert.match(controls, /onChange=\{\(v\) => setPaymentMethod\(/,
    "결제수단 셀렉트는 서버 Promise를 UI 로딩 상태로 연결하지 않아야 한다");
  assert.doesNotMatch(controls, /savingPayment|savingProof|savingDeposit|savingBilling/,
    "일상 결제 필드마다 서버 왕복 동안 스피너를 띄우면 안 된다");
});

test("위험한 외부 부작용만 해당 버튼 단위 진행 상태를 유지한다", () => {
  const controls = read("components/PaymentControls.tsx");
  const actions = read("components/TradeActions.tsx");
  const store = read("lib/data/store.ts");
  assert.match(controls, /issuing[\s\S]*disabled=\{issuing\}/,
    "실제 증빙 발행은 중복 요청 방지를 위해 발행 버튼만 막아야 한다");
  assert.match(controls, /sendingStatement[\s\S]*disabled=\{sendingStatement\}/,
    "명세서 발송은 발송 버튼만 막아야 한다");
  assert.match(controls, /sendingPayAppLink[\s\S]*disabled=\{sendingPayAppLink\}/,
    "결제링크 발송은 발송 버튼만 막아야 한다");
  assert.match(store, /export function isTradeDestructiveActionBlocked[\s\S]*hasTradePending\(tradeId\)/,
    "완전삭제용 가드는 내부 미확정 원장 쓰기를 확인해야 한다");
  assert.equal(
    (actions.match(/isTradeDestructiveActionBlocked\(trade\.tradeId\)/g) || []).length,
    2,
    "완전삭제는 확인창 전과 실제 호출 직전에 내부 저장 상태를 재검사해야 한다",
  );
});
