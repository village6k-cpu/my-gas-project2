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
 *   GET  {LOOKUP_BASE}/api/lookup/receipts?phone= | ?reservation=
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
var RECEIPT_RECORDS_KEY = 'receiptRecords';
var RECEIPT_RECORD_LIMIT = 80;

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

function asciiReceiptText(value, fallback) {
  var text = String(value || '').replace(/[^\x20-\x7E]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) text = String(fallback || '-').replace(/[^\x20-\x7E]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) text = '-';
  return text.length > 64 ? text.slice(0, 61) + '...' : text;
}

function two(n) {
  return String(n).padStart(2, '0');
}

function receiptDateTime(value) {
  if (!value) return '-';
  var date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '-';
  var kst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  return [
    kst.getUTCFullYear(),
    '-',
    two(kst.getUTCMonth() + 1),
    '-',
    two(kst.getUTCDate()),
    ' ',
    two(kst.getUTCHours()),
    ':',
    two(kst.getUTCMinutes()),
    ':',
    two(kst.getUTCSeconds())
  ].join('');
}

function manualReceiptDateKey(value) {
  var stamp = receiptDateTime(value);
  return stamp && stamp !== '-' ? stamp.slice(0, 10) : '날짜 없음';
}

function formatReceiptDateLabel(dateKey) {
  return dateKey === '날짜 없음' ? dateKey : dateKey.replace(/-/g, '.');
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

function openTossFrontSettings() {
  if (sdk && sdk.app && typeof sdk.app.openSetting === 'function') {
    return sdk.app.openSetting();
  }
  console.warn('[village] sdk.app.openSetting 사용 불가');
}

function returnToIdle() {
  setTimeout(function () { showIdle(); }, 0);
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

async function lookupReceipts(query) {
  var qs = [];
  if (query.phone) qs.push('phone=' + encodeURIComponent(query.phone));
  if (query.reservation) qs.push('reservation=' + encodeURIComponent(query.reservation));
  var url = CFG.LOOKUP_BASE + '/api/lookup/receipts?' + qs.join('&');

  var res = await fetch(url, { headers: { 'x-lookup-token': CFG.LOOKUP_TOKEN } });
  if (!res.ok) throw new Error(await errMsg(res, '영수증 조회 실패'));
  var data = await res.json();
  return attachStoredReceiptKeys((data && data.matches) || []);
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

async function ensureStillPayable(trade) {
  var matches = await lookup({ reservation: trade.tradeId });
  var fresh = null;
  for (var i = 0; i < matches.length; i += 1) {
    if (matches[i] && matches[i].tradeId === trade.tradeId) {
      fresh = matches[i];
      break;
    }
  }
  if (!fresh) {
    throw new Error('이 예약은 더 이상 단말 결제 대상이 아닙니다. 직원을 불러주세요.');
  }

  var selectedAmount = Number(trade.amount);
  var freshAmount = Number(fresh.amount);
  if (!freshAmount || selectedAmount !== freshAmount) {
    throw new Error('결제금액이 변경됐습니다. 다시 조회한 뒤 결제해주세요.');
  }
  return fresh;
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

async function printOfficialPaymentReceipt(paymentKey) {
  if (!paymentKey) throw new Error('영수증 출력에 필요한 결제키가 없습니다.');
  if (!sdk.printer || typeof sdk.printer.printReceipt !== 'function') {
    throw new Error('토스 공식 영수증 출력 기능을 사용할 수 없습니다.');
  }
  return sdk.printer.printReceipt({ paymentKey: paymentKey, count: 1 });
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

async function loadReceiptRecords() {
  var records = await storageGet(RECEIPT_RECORDS_KEY);
  return Array.isArray(records) ? records : [];
}

async function saveReceiptRecords(records) {
  await storageSet(RECEIPT_RECORDS_KEY, records.slice(0, RECEIPT_RECORD_LIMIT));
}

async function rememberReceiptRecord(trade, payment) {
  if (!payment || !payment.paymentKey) return;
  var record = {
    tradeId: trade && trade.tradeId ? trade.tradeId : null,
    sourceType: trade && trade.sourceType ? trade.sourceType : 'reservation',
    paymentKey: payment.paymentKey,
    amount: payment.amount,
    approvalNumber: payment.approvalNumber || null,
    paidAt: new Date().toISOString(),
    customerName: trade && trade.customerName ? trade.customerName : '현장 결제',
    itemSummary: trade && trade.itemSummary ? trade.itemSummary : '현장 입력 금액',
    checkoutAt: trade && trade.checkoutAt ? trade.checkoutAt : '',
    returnAt: trade && trade.returnAt ? trade.returnAt : '',
    depositStatus: '입금완료',
    paymentMethod: '카드결제'
  };
  var records = await loadReceiptRecords();
  var filtered = records.filter(function (r) {
    if (!r) return false;
    if (r.paymentKey === record.paymentKey) return false;
    if (record.tradeId && r.tradeId === record.tradeId) return false;
    return true;
  });
  filtered.unshift(record);
  await saveReceiptRecords(filtered);
}

function buildManualReceiptRecord(amount, payment) {
  var key = payment && payment.paymentKey ? payment.paymentKey : 'manual-' + Date.now();
  return {
    tradeId: 'manual-' + String(key).slice(0, 12),
    sourceType: 'manual',
    amount: Number(amount),
    customerName: '현장 직접 결제',
    itemSummary: '현장 입력 금액',
    checkoutAt: '',
    returnAt: '',
    depositStatus: '입금완료',
    paymentMethod: '카드결제'
  };
}

async function loadManualReceiptRecords() {
  var records = await loadReceiptRecords();
  return records.filter(function (r) {
    return r && r.sourceType === 'manual' && r.paymentKey;
  });
}

function groupManualReceiptRecordsByDate(records) {
  var grouped = {};
  records.forEach(function (record) {
    var key = manualReceiptDateKey(record.paidAt);
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(record);
  });
  return Object.keys(grouped)
    .sort(function (a, b) { return a < b ? 1 : a > b ? -1 : 0; })
    .map(function (dateKey) {
      grouped[dateKey].sort(function (a, b) {
        return String(b.paidAt || '').localeCompare(String(a.paidAt || ''));
      });
      return { dateKey: dateKey, records: grouped[dateKey] };
    });
}

async function attachStoredReceiptKeys(matches) {
  var records = await loadReceiptRecords();
  if (!records.length) return matches;
  var byTrade = {};
  for (var i = 0; i < records.length; i += 1) {
    var r = records[i];
    if (r && r.tradeId && r.paymentKey && !byTrade[r.tradeId]) byTrade[r.tradeId] = r;
  }
  return matches.map(function (m) {
    var stored = byTrade[m.tradeId];
    return stored ? Object.assign({}, m, {
      paymentKey: stored.paymentKey,
      approvalNumber: stored.approvalNumber || null,
      paidAt: stored.paidAt || null
    }) : m;
  });
}

// ──────────────────────────────────────────────────────────────
// 화면들
// ──────────────────────────────────────────────────────────────

// 1) 대기화면 — 토스 공식 Template API로만 구성
var showIdle = safe(function () {
  sdk.template.renderSelectPage({
    title: 'VILLAGE 셀프 결제',
    subtitle: '원하는 메뉴를 선택해주세요',
    navbarButton: { label: '설정', onClick: function () { openTossFrontSettings(); } },
    options: [
      {
        title: '전화번호로 결제',
        subtitle: '최근 결제 가능 예약 조회',
        description: '전화번호로 미결제 예약을 찾아요',
        onClick: function () { showPhoneInput(); }
      },
      {
        title: '금액 직접 결제',
        subtitle: '예약 조회 없이 카드 결제',
        description: '현장에서 결제할 금액을 직접 입력해요',
        onClick: function () { showManualAmountInput(); }
      },
      {
        title: '영수증 재출력',
        subtitle: '이 프론트에서 결제한 건만',
        description: '토스 공식 카드 영수증을 다시 출력해요',
        onClick: function () { showReceiptMenu(); }
      }
    ]
  });
});

// 2) 전화번호 입력
var showPhoneInput = safe(function () {
  sdk.template.renderInputPage({
    type: 'phone',
    top: { title: '전화번호를 입력해주세요', subtitle: '최근 결제 가능 예약만 표시돼요' },
    input: { placeholder: "'-' 없이 숫자만", maxLength: 11 },
    button: { label: '예약 조회' },
    onSubmit: async function (value) { await runLookup({ phone: value }); },
    onBack: function () { returnToIdle(); },
  });
});

// 2-b) 현장 금액 직접 입력
var showManualAmountInput = safe(function () {
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

var showReceiptMenu = safe(function () {
  sdk.template.renderSelectPage({
    title: '영수증 재출력',
    subtitle: '예약 결제와 직접 결제를 구분해서 찾습니다',
    options: [
      {
        title: '예약 영수증 조회',
        subtitle: '전화번호 또는 예약번호로 찾기',
        description: '이 프론트에서 결제한 예약 영수증',
        onClick: function () { showReceiptLookupInput(); }
      },
      {
        title: '최근 직접결제',
        subtitle: '이 프론트에서 결제한 금액 직접 결제',
        description: '결제일 기준으로 찾기',
        onClick: function () { showManualReceiptDateSelect(); }
      }
    ],
    onBack: function () { returnToIdle(); },
  });
});

function parseReceiptLookupValue(value) {
  var raw = String(value || '').trim();
  var digits = raw.replace(/[^\d]/g, '');
  if (!raw) return null;
  if (digits.length >= 8 && digits.length <= 11 && raw.replace(/[\d\s-]/g, '') === '') {
    return { phone: digits };
  }
  return { reservation: raw };
}

var showReceiptLookupInput = safe(function () {
  sdk.template.renderInputPage({
    type: 'text',
    top: { title: '영수증 재출력', subtitle: '전화번호 또는 예약번호를 입력해주세요' },
    input: { placeholder: '전화번호 / 예약번호' },
    button: { label: '결제내역 조회' },
    disclaimer: '이 프론트에서 결제한 예약만 공식 영수증을 재출력할 수 있습니다.',
    onSubmit: async function (value) {
      var query = parseReceiptLookupValue(value);
      if (!query) {
        return showError('입력값을 확인해주세요', '전화번호 또는 예약번호가 필요합니다.', { retryReceipt: true });
      }
      return runReceiptLookup(query);
    },
    onBack: function () { showReceiptMenu(); },
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
    return showError('결제 가능 예약을 찾지 못했어요', '번호를 다시 확인하시거나 직원을 불러주세요.', { retry: true });
  }

  // 결제 가능한 금액이 있는 건만
  var payable = matches.filter(function (m) { return m.amount != null && Number(m.amount) > 0; });
  if (payable.length === 0) {
    return showError('결제할 금액이 없어요', '금액 확인이 필요합니다. 직원을 불러주세요.', { retry: true });
  }

  if (payable.length === 1) return showOrder(payable[0]);
  return showSelect(payable);
}

async function runReceiptLookup(query) {
  try { if (sdk.template.openToast) sdk.template.openToast({ message: '결제내역을 조회하고 있어요…' }); } catch (e) {}

  var matches;
  try {
    matches = await lookupReceipts(query);
  } catch (e) {
    return showError('영수증 조회 실패', e.message || '잠시 후 다시 시도해주세요.', { retryReceipt: true });
  }

  matches = matches || [];
  matches = matches.filter(function (m) { return m && m.paymentKey; });
  if (matches.length === 0) {
    return showError(
      '재출력 가능한 토스 영수증이 없어요',
      '이 프론트에서 결제한 예약만 공식 영수증을 다시 출력할 수 있어요.',
      { retryReceipt: true }
    );
  }

  if (matches.length === 1) return showReceiptConfirm(matches[0]);
  return showReceiptSelect(matches);
}

// 3) 예약 여러 건 → 선택
var showSelect = safe(function (items) {
  sdk.template.renderSelectPage({
    title: '결제할 예약을 선택하세요',
    subtitle: items.length + '건의 결제 가능 예약이 있어요',
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

var showReceiptSelect = safe(function (items) {
  sdk.template.renderSelectPage({
    title: '영수증 출력할 결제건을 선택하세요',
    subtitle: items.length + '건의 결제완료 내역이 있어요',
    options: items.map(function (m) {
      return {
        title: won(m.amount),
        subtitle: m.customerName + (m.checkoutAt ? ' · ' + shortDate(m.checkoutAt) : ''),
        description: (m.itemSummary || '') + ' · 토스 영수증',
        onClick: function () { showReceiptConfirm(m); },
      };
    }),
    onBack: function () { showReceiptMenu(); },
  });
});

async function showManualReceiptDateSelect() {
  var items = await loadManualReceiptRecords();
  if (!items.length) {
    return showError('최근 직접결제 영수증이 없어요', '이 프론트에서 새로 결제한 금액 직접 결제건만 표시됩니다.', { retryReceiptMenu: true });
  }
  var groups = groupManualReceiptRecordsByDate(items);
  return sdk.template.renderSelectPage({
    title: '결제일을 선택하세요',
    subtitle: '금액 직접 결제는 결제일 기준으로 찾습니다',
    options: groups.map(function (group) {
      return {
        title: formatReceiptDateLabel(group.dateKey),
        subtitle: group.records.length + '건',
        description: '결제일',
        onClick: function () { showManualReceiptSelectForDate(group.dateKey, group.records); }
      };
    }),
    onBack: function () { showReceiptMenu(); },
  });
}

function showManualReceiptSelectForDate(dateKey, records) {
  return sdk.template.renderSelectPage({
    title: formatReceiptDateLabel(dateKey) + ' 직접결제',
    subtitle: records.length + '건의 직접결제 내역',
    options: records.map(function (m) {
      return {
        title: won(m.amount),
        subtitle: receiptDateTime(m.paidAt),
        description: '승인번호 ' + asciiReceiptText(m.approvalNumber, '-'),
        onClick: function () { showReceiptConfirm(m); },
      };
    }),
    onBack: function () { showManualReceiptDateSelect(); },
  });
}

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

var showReceiptConfirm = safe(function (m) {
  var desc = [
    m.customerName,
    shortDate(m.checkoutAt),
    won(m.amount),
    '공식 카드 영수증'
  ].filter(Boolean).join(' · ');
  sdk.template.renderResultPage({
    type: 'image',
    status: 'success',
    title: '토스 영수증을 출력할까요',
    description: desc,
    timerMs: 0,
    buttons: [
      { label: '출력하기', onClick: function () { doPrintReceipt(m); } },
      { label: '처음으로', onClick: function () { returnToIdle(); }, closeOnClick: true }
    ],
  });
});

async function doPrintReceipt(trade) {
  try {
    await printOfficialPaymentReceipt(trade && trade.paymentKey);
  } catch (e) {
    return showError('영수증 출력 실패', e.message || '프린터 연결을 확인해주세요.', { retryReceipt: true });
  }

  return showPrintResult(
    '출력 요청이 완료됐어요',
    '토스 카드 영수증을 출력했어요.'
  );
}

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
  var trade = m;
  var payment;
  try {
    trade = await ensureStillPayable(m);
  } catch (e) {
    return showError('결제 전 확인 실패', e.message || '예약 상태를 다시 확인해주세요.', { retry: true });
  }

  try {
    payment = await chargeCard(trade);
  } catch (e) {
    return showError('결제 실패', e.message || '결제가 취소되었습니다.', { retry: false });
  }

  await rememberReceiptRecord(trade, payment);

  // 카드 승인 성공 → 시트 '입금완료' 반영
  try {
    await confirmPaid(trade, payment);
  } catch (e) {
    // 카드는 승인됐는데 시트 반영만 실패 → 손님에겐 완료로 안내, pending 유지(다음 부팅 때 복구)
    console.error('[village] confirmPaid 실패(카드는 승인됨):', e);
    return showSuccess(payment, { syncWarning: true });
  }

  await storageDel('pending');
  return showSuccess(payment, { trade: trade });
}

// 5-b) 현장 금액 결제 실행 — 예약/시트 반영 없이 카드 승인만 수행
async function doManualCharge(amount) {
  var payment;
  try {
    payment = await chargeManualAmount(amount);
  } catch (e) {
    return showError('결제 실패', e.message || '결제가 취소되었습니다.', { retryManual: true });
  }

  await rememberReceiptRecord(buildManualReceiptRecord(amount, payment), payment);
  return showSuccess(payment, {});
}

// 6) 결과 화면
var showSuccess = safe(function (payment, opts) {
  opts = opts || {};
  var buttons = [];
  if (payment && payment.paymentKey) {
    buttons.push({
      label: '영수증 출력',
      onClick: async function () {
        try {
          await printOfficialPaymentReceipt(payment.paymentKey);
        } catch (e) {
          return showError('영수증 출력 실패', e.message || '프린터 연결을 확인해주세요.', {});
        }
        return showPrintResult('영수증을 출력했어요', '카드 영수증 출력 요청이 완료됐어요.');
      }
    });
  }
  buttons.push({ label: '확인', onClick: function () { returnToIdle(); }, closeOnClick: true });
  sdk.template.renderResultPage({
    type: 'image',
    status: 'success',
    title: '결제가 완료되었어요',
    description: won(payment.amount) + (opts.syncWarning ? ' · 결제 반영은 잠시 후 처리돼요' : ''),
    timerMs: 5000,
    onTimeout: function () { returnToIdle(); },
    buttons: buttons,
  });
});

var showPrintResult = safe(function (title, desc) {
  sdk.template.renderResultPage({
    type: 'image',
    status: 'success',
    title: title,
    description: desc,
    timerMs: 3500,
    onTimeout: function () { returnToIdle(); },
    buttons: [{ label: '확인', onClick: function () { returnToIdle(); }, closeOnClick: true }],
  });
});

var showError = safe(function (title, desc, opts) {
  opts = opts || {};
  var buttons = [];
  if (opts.retry) buttons.push({ label: '다시 조회', onClick: function () { returnToIdle(); } });
  if (opts.retryManual) buttons.push({ label: '금액 다시 입력', onClick: function () { showManualAmountInput(); } });
  if (opts.retryReceipt) buttons.push({ label: '다시 조회', onClick: function () { showReceiptLookupInput(); } });
  if (opts.retryReceiptMenu) buttons.push({ label: '영수증 메뉴', onClick: function () { showReceiptMenu(); } });
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
    var found = sdk.payment.getPayment ? await sdk.payment.getPayment({ paymentKey: pending.paymentKey }) : null;
    if (found && found.type === 'SUCCESS') {
      var response = found.response || {};
      await confirmPaid(
        { tradeId: pending.tradeId },
        {
          amount: pending.amount,
          paymentKey: pending.paymentKey,
          approvalNumber: response.approvalNumber
        }
      );
      await rememberReceiptRecord(
        { tradeId: pending.tradeId, customerName: '복구된 예약 결제', itemSummary: '예약 결제', checkoutAt: '', returnAt: '' },
        {
          amount: pending.amount,
          paymentKey: pending.paymentKey,
          approvalNumber: response.approvalNumber
        }
      );
    }
  } catch (e) {
    console.error('[village] 미완료 결제 복구 실패:', e);
  }
  await storageDel('pending');
}

(async function init() {
  if (!sdk || !sdk.template) {
    var el = document.getElementById('app');
    if (el) el.innerText = 'TossFrontSDK 로드 실패 — 단말기/네트워크를 확인하세요.';
    return;
  }
  try { await recoverPending(); } catch (e) {}
  showIdle();
})();
