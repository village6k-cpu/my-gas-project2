// @ts-nocheck
// 후속조치 의미기반 중복제거/요약 로직 — apps/follow-up-dashboard/api/follow-ups.js 이식 (순수 JS)

export const TYPE_LABELS = {
  reply_needed: '답변 필요',
  quote_send: '견적서 발송',
  tax_invoice: '세금계산서/증빙',
  schedule_check: '스케줄 확인',
  reservation_review: '예약 후보 확인',
  price_review: '가격/할인 확인',
  payment_check: '입금/결제 확인',
  contract_document: '계약/서류',
  return_extension: '반납/연장/변경',
  damage_repair: '파손/수리',
  sheet_duplicate_check: '시트 중복 확인',
  completed_log: '처리 완료 기록'
};

function normalizeKeyPart(value, maxLength = 120) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^0-9a-z가-힣_./:-]+/g, ' ')
    .trim()
    .slice(0, maxLength) || 'unknown';
}

function normalizeCustomerForTask(value) {
  const normalized = normalizeKeyPart(value, 80);
  return normalized
    .replace(/\/.*$/, '')
    .replace(/\s+(?:파손|미반납|누락|분실|반납|확인).*$/, '')
    .trim() || normalized;
}

function text(value) {
  return String(value ?? '').trim();
}

function combinedFollowUpText(item = {}) {
  return [
    item.title,
    item.summary,
    item.recommended_action,
    Array.isArray(item.evidence) ? item.evidence.join(' ') : ''
  ].map(text).join(' ').normalize('NFKC');
}

function extractAmountAnchors(value) {
  return (text(value).normalize('NFKC').match(/\d[\d,]*(?:\.\d+)?\s*(?:만원|원)/g) || [])
    .map((v) => v.replace(/[\s,]+/g, ''));
}

function extractDateAnchors(value) {
  const input = text(value).normalize('NFKC');
  const currentYear = new Date().getFullYear();
  const pad = (value) => String(value).padStart(2, '0');
  const anchors = [];
  for (const match of input.matchAll(/(\d{4})[-./](\d{1,2})[-./](\d{1,2})/g)) {
    anchors.push(`${match[1]}-${pad(match[2])}-${pad(match[3])}`);
  }
  for (const match of input.matchAll(/(\d{1,2})\s*월\s*(\d{1,2})\s*일/g)) {
    anchors.push(`${currentYear}-${pad(match[1])}-${pad(match[2])}`);
  }
  for (const match of input.matchAll(/(\d{1,2})\/(\d{1,2})(?:\s*[-~]\s*(\d{1,2})\/(\d{1,2}))?/g)) {
    anchors.push(`${currentYear}-${pad(match[1])}-${pad(match[2])}`);
    if (match[3] && match[4]) anchors.push(`${currentYear}-${pad(match[3])}-${pad(match[4])}`);
  }
  return Array.from(new Set(anchors));
}

function extractTopicBuckets(combined) {
  const buckets = [];
  if (/(반납|다음\s*회차|메모리|배터리|픽업|라오와|장비\s*반납|확인\s*후\s*가져다|가져다\s*드리)/.test(combined)) buckets.push('operations_update');
  if (/(결제|계약|견적|정산|서류|거래명세|세금계산|계산서)/.test(combined)) buckets.push('payment_docs');
  if (/(입금|결제|미수|환불)/.test(combined)) buckets.push('payment_check');
  if (/(학생\s*할인|학생할인|할인율|몇\s*프로|몇\s*퍼센트|할인)/.test(combined)) buckets.push('discount_policy');
  if (!buckets.includes('discount_policy') && !buckets.includes('operations_update') && /(위치|주소|어디|찾아가|오시는\s*길)/.test(combined)) buckets.push('location_faq');
  if (/(예약|반출|반납|대여|렌탈|촬영|일정)/.test(combined)) buckets.push('reservation_review');
  if (/(미반납|누락|분실|파손|손상|수리|고장|회수|경고\s*메시지|배터리)/.test(combined)) buckets.push('damage_repair');
  return buckets;
}

function isReservationTask(item = {}, combined = '') {
  const type = String(item.type || '');
  if (type === 'reservation_review') return true;
  if (type === 'sheet_duplicate_check' && /(확인요청|예약|반출|반납|대여|렌탈)/.test(combined)) return true;
  if (!['reply_needed', 'schedule_check', 'quote_send'].includes(type)) return false;
  return /(예약\s*(?:가능|진행|요청|의사|접수)|대여\s*가능|렌탈\s*가능|대여\s*할\s*수|대여\s*할수|렌탈\s*할\s*수|장비\s*예약)/.test(combined);
}

function reservationScopeAnchors(item = {}, combined = '') {
  const roomKey = normalizeKeyPart(item.room_key || '', 120);
  if (roomKey && roomKey !== 'unknown') return [`room:${roomKey}`];
  const dates = extractDateAnchors(combined);
  if (dates.length) return [...new Set(dates)];
  const amounts = extractAmountAnchors(combined);
  if (amounts.length) return [...new Set(amounts)];
  if (roomKey && roomKey !== 'unknown') return [`room:${roomKey}`];
  return [];
}

function taskOwnerKey(item = {}, customer = normalizeCustomerForTask(item.customer_name)) {
  const roomKey = normalizeKeyPart(item.room_key || '', 120);
  return roomKey && roomKey !== 'unknown' ? `room:${roomKey}` : customer;
}

function isUnstablePreviewRoomKey(item = {}) {
  return /^preview:[a-f0-9]{12,}$/i.test(String(item.room_key || '').trim());
}

function concreteScopeAnchors(combined = '') {
  return [...new Set([
    ...extractDateAnchors(combined),
    ...extractAmountAnchors(combined)
  ])];
}

function isLowInformationDiagnosticItem(item = {}) {
  const combined = combinedFollowUpText(item);
  return /(채팅방.*(?:본문|메시지).*확인|카카오\s*대화.*확인|대화\s*최신\s*메시지\s*확인|메시지\s*본문\s*확인|채팅방\s*로드\s*실패|불러오는데\s*실패|본문을\s*읽지\s*못|말풍선\s*텍스트가\s*읽히지|AX\/?CUA|CUA\/?AX|preview\s*text|preview만|미리보기.*판단|대상\s*카카오\s*대화\s*불일치|AI\s*처리\s*보류|자동\s*분류\/시트\s*입력.*중단|화면\s*검증\s*전|화면\s*확인\s*필요|수동\s*확인\s*필요)/i.test(combined);
}

export function buildDashboardSemanticKey(item) {
  const customer = normalizeCustomerForTask(item.customer_name);
  const owner = taskOwnerKey(item, customer);
  const type = normalizeKeyPart(item.type, 60);
  const combined = combinedFollowUpText(item);
  const specificAnchors = [
    ...extractAmountAnchors(combined),
    ...extractDateAnchors(combined)
  ];
  const buckets = extractTopicBuckets(combined);
  if (type === 'quote_send') {
    const scope = reservationScopeAnchors(item, combined);
    return ['semantic', owner, 'quote_send', ...scope]
      .map((v) => normalizeKeyPart(v, 120))
      .join(':');
  }
  if (isReservationTask(item, combined)) {
    const scope = reservationScopeAnchors(item, combined);
    return ['semantic', owner, 'reservation_review', ...scope]
      .map((v) => normalizeKeyPart(v, 120))
      .join(':');
  }
  if (buckets.includes('operations_update')) {
    return ['semantic', customer, 'operations_update'].map((v) => normalizeKeyPart(v, 120)).join(':');
  }
  if (buckets.includes('discount_policy')) {
    return ['semantic', owner, type, ...new Set(specificAnchors), 'discount_policy'].map((v) => normalizeKeyPart(v, 120)).join(':');
  }
  if (buckets.includes('damage_repair')) {
    return ['semantic', owner, 'damage_repair', ...new Set(specificAnchors)].map((v) => normalizeKeyPart(v, 120)).join(':');
  }
  if (!specificAnchors.length && !buckets.length) return `exact:${normalizeKeyPart(item.follow_up_key || item.id || item.title || '', 200)}`;
  return ['semantic', owner, type, ...new Set(specificAnchors), ...new Set(buckets)].map((v) => normalizeKeyPart(v, 120)).join(':');
}

function buildDashboardAlternateSemanticKeys(item) {
  const customer = normalizeCustomerForTask(item.customer_name);
  const owner = taskOwnerKey(item, customer);
  const type = normalizeKeyPart(item.type, 60);
  const combined = combinedFollowUpText(item);
  const buckets = extractTopicBuckets(combined);
  const anchors = concreteScopeAnchors(combined);
  const keys = [];
  const add = (parts) => keys.push(parts.map((v) => normalizeKeyPart(v, 120)).join(':'));
  const addPerAnchor = (baseParts) => {
    if (anchors.length) add([...baseParts, ...anchors]);
    for (const anchor of anchors) add([...baseParts, anchor]);
  };
  const addScoped = (baseParts) => {
    if (anchors.length) addPerAnchor(baseParts);
    else add(baseParts);
  };

  if (buckets.includes('damage_repair')) add(['semantic', owner, 'damage_repair']);

  if (buckets.includes('payment_docs') && ['contract_document', 'quote_send', 'tax_invoice'].includes(type)) {
    addScoped(['semantic', owner, 'payment_docs']);
    if (isUnstablePreviewRoomKey(item)) addScoped(['semantic', customer, 'payment_docs']);
  }

  if (buckets.includes('reservation_review') && !isReservationTask(item, combined)) {
    addPerAnchor(['semantic', owner, 'reservation_review']);
    if (isUnstablePreviewRoomKey(item)) addPerAnchor(['semantic', customer, 'reservation_review']);
  }

  if (type === 'price_review' && anchors.length) {
    addPerAnchor(['semantic', owner, 'price_review']);
    if (isUnstablePreviewRoomKey(item)) addPerAnchor(['semantic', customer, 'price_review']);
  }

  if (!isUnstablePreviewRoomKey(item) || !anchors.length) return Array.from(new Set(keys));
  if (type === 'quote_send') {
    addPerAnchor(['semantic', customer, 'quote_send']);
  }
  if (isReservationTask(item, combined)) {
    addPerAnchor(['semantic', customer, 'reservation_review']);
  }
  if (!['quote_send', 'price_review'].includes(type)) {
    addPerAnchor(['semantic', customer, type]);
  }
  return Array.from(new Set(keys));
}

function dashboardSemanticKeys(item) {
  return Array.from(new Set([buildDashboardSemanticKey(item), ...buildDashboardAlternateSemanticKeys(item)]));
}

function mergeDuplicateFollowUpItem(primary, duplicate) {
  const priorityRank = { urgent: 0, high: 1, normal: 2, low: 3 };
  const merged = { ...primary };
  if ((priorityRank[duplicate.priority] ?? 2) < (priorityRank[merged.priority] ?? 2)) merged.priority = duplicate.priority;
  if (!text(merged.suggested_reply_draft) && text(duplicate.suggested_reply_draft)) {
    merged.suggested_reply_draft = duplicate.suggested_reply_draft;
  }
  const evidence = [
    ...(Array.isArray(primary.evidence) ? primary.evidence : []),
    ...(Array.isArray(duplicate.evidence) ? duplicate.evidence : [])
  ].map(text).filter(Boolean);
  merged.evidence = Array.from(new Set(evidence)).slice(0, 12);
  return merged;
}

function mergeLowInformationDiagnosticItems(items) {
  const diagnosticsByCustomer = new Map();
  const concreteByCustomer = new Map();
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index] || {};
    const customer = normalizeCustomerForTask(item.customer_name);
    const target = isLowInformationDiagnosticItem(item) ? diagnosticsByCustomer : concreteByCustomer;
    const entries = target.get(customer) || [];
    entries.push(index);
    target.set(customer, entries);
  }

  const remove = new Set();
  const merged = [...items];
  for (const [customer, diagnosticIndexes] of diagnosticsByCustomer.entries()) {
    const concreteIndexes = concreteByCustomer.get(customer) || [];
    if (!concreteIndexes.length && diagnosticIndexes.length < 2) continue;
    const targetIndex = concreteIndexes[0] ?? diagnosticIndexes[0];
    for (const diagnosticIndex of diagnosticIndexes) {
      if (diagnosticIndex === targetIndex) continue;
      merged[targetIndex] = mergeDuplicateFollowUpItem(merged[targetIndex], merged[diagnosticIndex]);
      remove.add(diagnosticIndex);
    }
  }
  return merged.filter((_, index) => !remove.has(index));
}

export function dedupeFollowUpItems(items) {
  const seen = new Map();
  const deduped = [];
  for (const item of Array.isArray(items) ? items : []) {
    const keys = dashboardSemanticKeys(item || {});
    const matchedKey = keys.find((key) => seen.has(key));
    if (matchedKey) {
      const index = seen.get(matchedKey);
      deduped[index] = mergeDuplicateFollowUpItem(deduped[index], item);
      for (const key of keys) seen.set(key, index);
      continue;
    }
    for (const key of keys) seen.set(key, deduped.length);
    deduped.push(item);
  }
  return mergeLowInformationDiagnosticItems(deduped);
}

export function duplicateFollowUpIdsForItem(current, candidates) {
  const targetKeys = new Set(dashboardSemanticKeys(current || {}));
  const targetCustomer = normalizeCustomerForTask(current?.customer_name);
  const ids = [];
  for (const item of Array.isArray(candidates) ? candidates : []) {
    if (!item?.id) continue;
    const itemKeys = dashboardSemanticKeys(item || {});
    const keyMatch = itemKeys.some((key) => targetKeys.has(key));
    const sameCustomer = normalizeCustomerForTask(item.customer_name) === targetCustomer;
    const diagnosticMatch = sameCustomer && isLowInformationDiagnosticItem(item);
    if (keyMatch || diagnosticMatch) ids.push(item.id);
  }
  return Array.from(new Set(ids));
}

export function shouldHideLowValueActiveItem(item) {
  if (item?.status && ['done', 'dismissed'].includes(item.status)) return false;
  if (item?.type !== 'completed_log') return false;
  const combined = combinedFollowUpText(item);
  const hasActionableRecord = /(미반납|누락|분실|파손|손상|수리|입금|결제|변경|추가|확인\s*필요|등록\s*필요|기록\s*필요|메모|특이사항|현장\s*반납|반영)/.test(combined);
  if (hasActionableRecord) return false;
  if (/(감사|감사히|잘\s*썼|잘썼|고맙)/.test(combined)) return true;
  return /(반납\s*완료|반납을\s*완료|수신\s*확인|내부\s*확인|실물\s*반납\s*상태만)/.test(combined);
}

export function summarize(items) {
  const openItems = items.filter((x) => !['done', 'dismissed'].includes(x.status));
  const byType = {};
  for (const item of openItems) byType[item.type] = (byType[item.type] || 0) + 1;
  return {
    total: items.length,
    open: openItems.length,
    urgent: openItems.filter((x) => x.priority === 'urgent').length,
    high: openItems.filter((x) => x.priority === 'high').length,
    byType: Object.entries(byType).map(([type, count]) => ({ type, label: TYPE_LABELS[type] || type, count }))
  };
}
