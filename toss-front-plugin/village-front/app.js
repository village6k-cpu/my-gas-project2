'use strict';
/*
 * VILLAGE 셀프 카드결제 — 토스 프론트 플러그인
 *
 * 손님이 매장 단말기에서 직접:
 *   대기화면 → 전화번호(또는 예약번호) 입력 → 예약 조회(우리 서버)
 *   → (여러 건이면) 선택 → 금액 확인 → 카드결제 → 시트 '입금완료' 반영 → 결과
 *
 * 서버 연동 (today-dashboard):
 *   GET  {LOOKUP_BASE}/api/lookup?phone= | ?reservation=   (헤더 x-lookup-token)
 *   POST {LOOKUP_BASE}/api/lookup/confirm                  (헤더 x-lookup-token)
 *
 * 단말기 SDK : window.TossFrontSDK  (index.html에서 CDN 로드)
 * 설정       : window.CONFIG        (config.js)
 *
 * ⚠️ 화면 시그니처는 토스 공식 Template API 레퍼런스 기준으로 작성.
 *    실제 단말기에서 1회 테스트로 최종 확인 필요(여기선 단말기 실행 불가).
 *    모든 화면은 safe()로 감싸 오류 시 대기화면으로 안전 복귀.
 */

var sdk = window.TossFrontSDK;
var CFG = window.CONFIG || {};

// 개발/미리보기: 실제 단말 시리얼·매장정보가 없을 때만 override
if (CFG.TEST_MODE && sdk && sdk.overrides) {
  try {
    sdk.overrides({ serialNumber: CFG.TEST_SERIAL, merchant: CFG.TEST_MERCHANT });
  } catch (e) {
    console.warn('[village] overrides 실패(실단말기에선 무시 가능):', e);
  }
}

// ──────────────────────────────────────────────────────────────
// 유틸
// ──────────────────────────────────────────────────────────────
function won(n) {
  if (n == null || isNaN(n)) return '-';
  return Number(n).toLocaleString('ko-KR') + '원';
}

function shortDate(iso) {
  var m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? Number(m[2]) + '/' + Number(m[3]) : '';
}

function parseAmount(value) {
  var digits = String(value || '').replace(/[^\d]/g, '');
  var amount = Number(digits);
  return amount > 0 ? amount : 0;
}

// 화면 렌더는 항상 try/catch — 오류 시 대기화면 복귀(손님이 갇히지 않게)
function safe(fn) {
  return function () {
    try {
      return fn.apply(null, arguments);
    } catch (e) {
      console.error('[village] 화면 오류 — 대기화면 복귀:', e);
      try { showIdle(); } catch (_) {}
    }
  };
}

async function errMsg(res, fallback) {
  var msg = fallback + ' (' + res.status + ')';
  try { var j = await res.json(); if (j && j.error) msg = j.error; } catch (e) {}
  return msg;
}

function ensureAppRoot() {
  var root = document.getElementById('app');
  if (!root) {
    root = document.createElement('div');
    root.id = 'app';
    document.body.appendChild(root);
  }
  return root;
}

function isTossDevAddressText(text) {
  var normalized = String(text || '').replace(/\s+/g, ' ').trim();
  return /(?:^|[^\d])(?:https?:\/\/)?(?:\d{1,3}\.){3}\d{1,3}:\d{2,5}(?:\/)?(?:$|[^\d])/.test(
    normalized
  );
}

function shouldHideTossDevAddressElement(el) {
  if (!el || el === document.documentElement || el === document.body || el.id === 'app') return false;
  var tag = String(el.tagName || '').toLowerCase();
  if (tag === 'script' || tag === 'style' || tag === 'link' || tag === 'meta') return false;
  if (el.querySelector && el.querySelector('#app')) return false;
  if (el.children && el.children.length > 4) return false;
  var text = String(el.textContent || '').replace(/\s+/g, ' ').trim();
  if (text.length > 96) return false;
  return isTossDevAddressText(text);
}

function hideTossDevAddressBadges(root) {
  var scope = root && root.querySelectorAll ? root : document.body;
  if (!scope) return;

  var nodes = [];
  if (scope.nodeType === 1) nodes.push(scope);
  if (scope.querySelectorAll) {
    Array.prototype.push.apply(nodes, Array.prototype.slice.call(scope.querySelectorAll('*')));
  }

  nodes.forEach(function (el) {
    if (!shouldHideTossDevAddressElement(el)) return;
    el.setAttribute('data-village-hidden-dev-address', '1');
    el.style.setProperty('display', 'none', 'important');
  });
}

function inspectTossDevAddressMutationNode(node) {
  if (!node) return;
  if (node.nodeType === 1) hideTossDevAddressBadges(node);
  if (node.parentElement) hideTossDevAddressBadges(node.parentElement);
}

function installTossDevAddressBadgeGuard() {
  hideTossDevAddressBadges(document.body);
  if (!window.MutationObserver || !document.body) return;

  var observer = new MutationObserver(function (mutations) {
    mutations.forEach(function (mutation) {
      inspectTossDevAddressMutationNode(mutation.target);
      Array.prototype.forEach.call(mutation.addedNodes || [], function (node) {
        inspectTossDevAddressMutationNode(node);
      });
    });
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  setInterval(function () { hideTossDevAddressBadges(document.body); }, 1000);
}

function openTossFrontSettings() {
  if (sdk && sdk.app && typeof sdk.app.openSetting === 'function') {
    return sdk.app.openSetting();
  }
  console.warn('[village] sdk.app.openSetting 사용 불가');
}

function installTossSettingsHotzone() {
  var zone = document.getElementById('village-settings-hotzone');
  if (!zone) return;

  var settingsTapCount = 0;
  var firstSettingsTapAt = 0;
  var resetAfterMs = 2500;

  function onSettingsTap(event) {
    if (event && event.preventDefault) event.preventDefault();
    var now = Date.now();
    if (!firstSettingsTapAt || now - firstSettingsTapAt > resetAfterMs) {
      firstSettingsTapAt = now;
      settingsTapCount = 0;
    }

    settingsTapCount += 1;
    if (settingsTapCount >= 5) {
      settingsTapCount = 0;
      firstSettingsTapAt = 0;
      openTossFrontSettings();
    }
  }

  if (window.PointerEvent) {
    zone.onpointerup = onSettingsTap;
  } else {
    zone.ontouchend = onSettingsTap;
    zone.onclick = onSettingsTap;
  }
}

function leaveVillageIdle() {
  document.body.classList.remove('village-idle-page');
  var root = document.getElementById('app');
  if (root) {
    root.className = '';
    root.innerHTML = '';
  }
}

function renderVillageIdle() {
  var root = ensureAppRoot();
  document.body.classList.add('village-idle-page');
  root.className = 'village-idle';
  root.innerHTML = [
    '<div class="village-dev-badge-mask" aria-hidden="true"></div>',
    '<section class="village-idle__content" aria-label="VILLAGE 셀프결제">',
    '  <img class="village-idle__logo" src="./assets/village-logo.png" alt="VILLAGE" />',
    '  <p class="village-idle__title">예약 조회 · 셀프 결제</p>',
    '  <p class="village-idle__copy">전화번호 또는 예약번호로<br />미결제 예약을 확인하고<br />카드로 결제하세요.</p>',
    '  <div class="village-idle__actions">',
    '    <button id="village-phone-button" class="village-idle__button village-idle__button--primary" type="button">전화번호로 결제</button>',
    '    <button id="village-reservation-button" class="village-idle__button village-idle__button--secondary" type="button">예약번호로 결제</button>',
    '    <button id="village-amount-button" class="village-idle__button village-idle__button--tertiary" type="button">금액 직접 결제</button>',
    '  </div>',
    '  <button id="village-settings-hotzone" class="village-settings-hotzone" type="button" aria-label="설정" tabindex="-1"></button>',
    '</section>',
  ].join('');

  document.getElementById('village-phone-button').onclick = function () {
    showPhoneInput();
  };
  document.getElementById('village-reservation-button').onclick = function () {
    showReservationInput();
  };
  document.getElementById('village-amount-button').onclick = function () {
    showManualAmountInput();
  };
  installTossSettingsHotzone();
}

function restoreVillageIdleIfEmpty() {
  if (!document.body || !document.body.classList.contains('village-idle-page')) return;
  var root = document.getElementById('app');
  if (!root || String(root.className || '').indexOf('village-idle') === -1) return;
  if (
    !document.getElementById('village-phone-button') ||
    !document.getElementById('village-reservation-button') ||
    !document.getElementById('village-amount-button')
  ) {
    renderVillageIdle();
  }
}

function returnToIdle() {
  setTimeout(function () { showIdle(); }, 0);
  setTimeout(restoreVillageIdleIfEmpty, 120);
  setTimeout(restoreVillageIdleIfEmpty, 500);
}

function installVillageIdleRecoveryGuard() {
  if (window.__villageIdleRecoveryGuardInstalled) return;
  window.__villageIdleRecoveryGuardInstalled = true;
  window.addEventListener('pageshow', restoreVillageIdleIfEmpty);
  window.addEventListener('popstate', function () {
    setTimeout(restoreVillageIdleIfEmpty, 120);
  });
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) restoreVillageIdleIfEmpty();
  });
  setInterval(restoreVillageIdleIfEmpty, 750);
}

// ──────────────────────────────────────────────────────────────
// 서버 호출
// ──────────────────────────────────────────────────────────────
async function lookup(query) {
  var qs = [];
  if (query.phone) qs.push('phone=' + encodeURIComponent(query.phone));
  if (query.reservation) qs.push('reservation=' + encodeURIComponent(query.reservation));
  var url = CFG.LOOKUP_BASE + '/api/lookup?' + qs.join('&');

  var res = await fetch(url, { headers: { 'x-lookup-token': CFG.LOOKUP_TOKEN } });
  if (!res.ok) throw new Error(await errMsg(res, '조회 실패'));
  var data = await res.json();
  return (data && data.matches) || [];
}

async function confirmPaid(trade, payment) {
  var res = await fetch(CFG.LOOKUP_BASE + '/api/lookup/confirm', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-lookup-token': CFG.LOOKUP_TOKEN },
    body: JSON.stringify({
      tradeId: trade.tradeId,
      method: '카드결제',
      paidAmount: payment.amount,
      paymentKey: payment.paymentKey,
      approvalNumber: payment.approvalNumber,
    }),
  });
  if (!res.ok) throw new Error(await errMsg(res, '결제완료 반영 실패'));
  return res.json();
}

// ──────────────────────────────────────────────────────────────
// 결제 (단말기 카드 승인) — 토스 공식 예제 패턴
// ──────────────────────────────────────────────────────────────
async function requestCardPayment(price, pendingTradeId) {
  var paymentKey =
    typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : 'vlg-' + Date.now();
  var tax = Math.floor(price / 11); // 부가세 10% 포함가 기준
  var supplyValue = price - tax;

  if (pendingTradeId) {
    // 결제 중 이탈 대비 — 예약 결제는 진행중 결제를 백업해 시트 반영을 복구한다.
    await storageSet('pending', { paymentKey: paymentKey, tradeId: pendingTradeId, amount: price });
  }

  var result = await sdk.payment.requestPayment({
    paymentKey: paymentKey,
    tax: tax,
    supplyValue: supplyValue,
    tip: 0,
    timeoutMs: 60000,
  });

  if (result && result.type === 'SUCCESS') {
    var r = result.response || {};
    return {
      paymentKey: paymentKey,
      amount: r.amount != null ? r.amount : price,
      approvalNumber: r.approvalNumber,
      raw: r,
    };
  }

  if (pendingTradeId) await storageDel('pending');
  var t = (result && result.type) || 'UNKNOWN';
  var err = new Error('결제가 완료되지 않았습니다 (' + t + ')');
  err.paymentType = t;
  throw err;
}

async function chargeCard(trade) {
  return requestCardPayment(Number(trade.amount), trade.tradeId);
}

async function chargeManualAmount(amount) {
  return requestCardPayment(Number(amount), null);
}

// sdk.storage 래퍼 (없으면 조용히 무시)
async function storageSet(key, val) {
  try { if (sdk.storage) await sdk.storage.set({ key: key, value: JSON.stringify(val) }); } catch (e) {}
}
async function storageGet(key) {
  try {
    if (sdk.storage) {
      var r = await sdk.storage.get({ key: key });
      return r && r.value ? JSON.parse(r.value) : null;
    }
  } catch (e) {}
  return null;
}
async function storageDel(key) {
  try { if (sdk.storage) await sdk.storage.set({ key: key, value: '' }); } catch (e) {}
}

// ──────────────────────────────────────────────────────────────
// 화면들
// ──────────────────────────────────────────────────────────────

// 1) 대기화면 — 예약 조회 결제 / 현장 금액 결제 제공
var showIdle = safe(function () {
  renderVillageIdle();
});

// 2) 전화번호 입력
var showPhoneInput = safe(function () {
  leaveVillageIdle();
  sdk.template.renderInputPage({
    type: 'phone',
    top: { title: '전화번호를 입력해주세요', subtitle: '예약하실 때 사용한 번호예요' },
    input: { placeholder: "'-' 없이 숫자만", maxLength: 11 },
    button: { label: '예약 조회' },
    onSubmit: async function (value) { await runLookup({ phone: value }); },
    onBack: function () { returnToIdle(); },
  });
});

// 2-b) 예약번호 입력
var showReservationInput = safe(function () {
  leaveVillageIdle();
  sdk.template.renderInputPage({
    type: 'text',
    top: { title: '예약번호를 입력해주세요', subtitle: '문자로 받으신 예약번호예요' },
    input: { placeholder: '예약번호' },
    button: { label: '예약 조회' },
    onSubmit: async function (value) { await runLookup({ reservation: value }); },
    onBack: function () { returnToIdle(); },
  });
});

// 2-c) 현장 금액 직접 입력
var showManualAmountInput = safe(function () {
  leaveVillageIdle();
  sdk.template.renderInputPage({
    type: 'number',
    top: { title: '결제 금액을 입력해주세요', subtitle: '현장에서 바로 결제할 금액이에요' },
    input: { placeholder: '금액 입력', maxLength: 8 },
    button: { label: '금액 확인' },
    disclaimer: '예약 조회 없이 입력한 금액으로 카드 결제됩니다.',
    onSubmit: async function (value) {
      var amount = parseAmount(value);
      if (!amount) {
        return showError('금액을 확인해주세요', '1원 이상 입력해주세요.', { retryManual: true });
      }
      return showManualOrder(amount);
    },
    onBack: function () { returnToIdle(); },
  });
});

// 조회 실행 + 결과 분기
async function runLookup(query) {
  try { if (sdk.template.openToast) sdk.template.openToast({ message: '예약을 조회하고 있어요…' }); } catch (e) {}

  var matches;
  try {
    matches = await lookup(query);
  } catch (e) {
    return showError('조회 실패', e.message || '잠시 후 다시 시도해주세요.', { retry: true });
  }

  if (!matches || matches.length === 0) {
    return showError('예약을 찾지 못했어요', '번호를 다시 확인하시거나 직원을 불러주세요.', { retry: true });
  }

  // 결제 가능한 금액이 있는 건만
  var payable = matches.filter(function (m) { return m.amount != null && Number(m.amount) > 0; });
  if (payable.length === 0) {
    return showError('결제할 금액이 없어요', '금액 확인이 필요합니다. 직원을 불러주세요.', { retry: true });
  }

  if (payable.length === 1) return showOrder(payable[0]);
  return showSelect(payable);
}

// 3) 예약 여러 건 → 선택
var showSelect = safe(function (items) {
  sdk.template.renderSelectPage({
    title: '결제할 예약을 선택하세요',
    subtitle: items.length + '건의 미결제 예약이 있어요',
    options: items.map(function (m) {
      return {
        title: won(m.amount),
        subtitle: m.customerName + (m.checkoutAt ? ' · ' + shortDate(m.checkoutAt) : ''),
        description: m.itemSummary || '',
        onClick: function () { showOrder(m); },
      };
    }),
    onBack: function () { returnToIdle(); },
  });
});

// 4) 금액 확인(주문서) → 결제
var showOrder = safe(function (m) {
  var amount = Number(m.amount);
  sdk.template.renderOrderPage({
    order: {
      items: [{ label: m.itemSummary || (m.customerName + ' 대여'), value: amount, quantity: 1 }],
      discounts: [],
      summary: { totalAmount: amount },
    },
    onClick: function () { doCharge(m); },
    onBack: function () { returnToIdle(); },
  });
});

var showManualOrder = safe(function (amount) {
  sdk.template.renderOrderPage({
    order: {
      items: [{ label: '현장 입력 금액', value: amount, quantity: 1 }],
      discounts: [],
      summary: { totalAmount: amount },
    },
    onClick: function () { doManualCharge(amount); },
    onBack: function () { showManualAmountInput(); },
  });
});

// 5) 예약 결제 실행 → 시트 반영
async function doCharge(m) {
  var payment;
  try {
    payment = await chargeCard(m);
  } catch (e) {
    return showError('결제 실패', e.message || '결제가 취소되었습니다.', { retry: false });
  }

  // 카드 승인 성공 → 시트 '입금완료' 반영
  try {
    await confirmPaid(m, payment);
  } catch (e) {
    // 카드는 승인됐는데 시트 반영만 실패 → 손님에겐 완료로 안내, pending 유지(다음 부팅 때 복구)
    console.error('[village] confirmPaid 실패(카드는 승인됨):', e);
    return showSuccess(payment, { syncWarning: true });
  }

  await storageDel('pending');
  return showSuccess(payment, {});
}

// 5-b) 현장 금액 결제 실행 — 예약/시트 반영 없이 카드 승인만 수행
async function doManualCharge(amount) {
  var payment;
  try {
    payment = await chargeManualAmount(amount);
  } catch (e) {
    return showError('결제 실패', e.message || '결제가 취소되었습니다.', { retryManual: true });
  }

  return showSuccess(payment, {});
}

// 6) 결과 화면
var showSuccess = safe(function (payment, opts) {
  opts = opts || {};
  sdk.template.renderResultPage({
    type: 'image',
    status: 'success',
    title: '결제가 완료되었어요',
    description: won(payment.amount) + (opts.syncWarning ? ' · 영수증 처리는 잠시 후 반영돼요' : ''),
    timerMs: 5000,
    onTimeout: function () { returnToIdle(); },
    buttons: [{ label: '확인', onClick: function () { returnToIdle(); }, closeOnClick: true }],
  });
});

var showError = safe(function (title, desc, opts) {
  opts = opts || {};
  var buttons = [];
  if (opts.retry) buttons.push({ label: '다시 조회', onClick: function () { returnToIdle(); } });
  if (opts.retryManual) buttons.push({ label: '금액 다시 입력', onClick: function () { showManualAmountInput(); } });
  buttons.push({ label: '처음으로', onClick: function () { returnToIdle(); }, closeOnClick: true });
  sdk.template.renderResultPage({
    type: 'image',
    status: 'error',
    title: title,
    description: desc,
    timerMs: 8000,
    onTimeout: function () { returnToIdle(); },
    buttons: buttons,
  });
});

// ──────────────────────────────────────────────────────────────
// 부팅: 미완료(이탈) 결제 복구 → 대기화면
// ──────────────────────────────────────────────────────────────
async function recoverPending() {
  var pending = await storageGet('pending');
  if (!pending || !pending.paymentKey) return;
  try {
    var found = sdk.payment.getPaymentByKey ? await sdk.payment.getPaymentByKey(pending.paymentKey) : null;
    if (found) {
      await confirmPaid(
        { tradeId: pending.tradeId },
        { amount: pending.amount, paymentKey: pending.paymentKey, approvalNumber: found.approvalNumber }
      );
    }
  } catch (e) {
    console.error('[village] 미완료 결제 복구 실패:', e);
  }
  await storageDel('pending');
}

(async function init() {
  installTossDevAddressBadgeGuard();
  if (!sdk || !sdk.template) {
    var el = document.getElementById('app');
    if (el) el.innerText = 'TossFrontSDK 로드 실패 — 단말기/네트워크를 확인하세요.';
    return;
  }
  try { await recoverPending(); } catch (e) {}
  installVillageIdleRecoveryGuard();
  showIdle();
})();
