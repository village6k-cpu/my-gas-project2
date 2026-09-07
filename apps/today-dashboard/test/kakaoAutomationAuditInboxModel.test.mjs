import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const modelUrl = pathToFileURL(path.join(appRoot, 'lib/automation-audit/inbox-model.mjs')).href;
const EVENT_KEY = `kakao:confirmation_request:${'a'.repeat(64)}`;

function item(overrides = {}) {
  return {
    eventKey: EVENT_KEY,
    jobId: 'job-audit-ui',
    roomRevision: 4,
    operationId: 'operation-audit-ui',
    receiptId: 'receipt-audit-ui',
    occurredAt: '2026-09-07T01:00:00.000Z',
    recordedAt: '2026-09-07T01:00:01.000Z',
    effectType: 'confirmation_request',
    actionType: 'create',
    outcome: 'success',
    customerLabel: '테스트 고객',
    targetType: 'request',
    targetId: 'RQ-260907-001',
    summary: '확인요청을 생성했습니다.',
    changeItems: [{ field: 'equipment', before: null, after: '소니 FX3 바디세트 1개' }],
    outboundText: null,
    evidence: { schema: 'village-confirmation-receipt/v1', status: 'ok', readback: true },
    sourceMessageAt: '2026-09-07T00:59:00.000Z',
    historicalImport: false,
    ...overrides,
  };
}

function payload(overrides = {}) {
  return {
    ok: true,
    source: 'kakao_automation_audit_events',
    items: [item()],
    nextCursor: null,
    sync: { delayed: false },
    ...overrides,
  };
}

async function loadModel() {
  return import(`${modelUrl}?test=${Date.now()}-${Math.random()}`);
}

test('audit inbox maps trusted DTOs to compact Korean owner rows and details', async () => {
  const { buildAutomationAuditView } = await loadModel();
  const model = buildAutomationAuditView({ payload: payload(), selectedEventKey: null });

  assert.equal(model.rows.length, 1);
  assert.equal(model.selected.eventKey, EVENT_KEY);
  assert.equal(model.rows[0].occurredLabel, '9/7 10:00');
  assert.equal(model.rows[0].effectLabel, '확인요청');
  assert.equal(model.rows[0].actionLabel, '생성');
  assert.equal(model.rows[0].outcomeLabel, '완료');
  assert.equal(model.rows[0].outcomeIcon, '✓');
  assert.equal(model.rows[0].ownerLine, '테스트 고객 · 확인요청을 생성했습니다.');
  assert.deepEqual(model.rows[0].changeLines, ['장비: 없음 → 소니 FX3 바디세트 1개']);
  assert.equal(model.syncDelayed, false);
  assert.equal(model.emptyLabel, '오늘 자동처리 기록이 없습니다');
});

test('audit inbox exposes every read-only range, effect, and attention filter', async () => {
  const { AUDIT_FILTERS, buildAutomationAuditQuery } = await loadModel();
  assert.deepEqual(AUDIT_FILTERS.ranges.map(({ value }) => value), ['today', '7d', 'custom']);
  assert.deepEqual(AUDIT_FILTERS.effects.map(({ value }) => value), [
    '', 'auto_reply', 'confirmation_request', 'reservation_registration',
    'registered_reservation_change', 'document_send',
  ]);
  assert.deepEqual(AUDIT_FILTERS.outcomes.map(({ value }) => value), [
    '', 'success', 'partial_success', 'failed', 'blocked',
  ]);
  assert.equal(buildAutomationAuditQuery({
    range: 'today', effect: '', outcome: '', search: '', limit: 50,
  }), 'range=today&limit=50');
  assert.equal(buildAutomationAuditQuery({
    range: 'custom', customFrom: '2026-09-01', customTo: '2026-09-03',
    effect: 'registered_reservation_change', outcome: 'partial_success', search: 'RQ-260901', limit: 25,
    after: 'YWZ0ZXI',
  }), 'range=custom&from=2026-08-31T15%3A00%3A00.000Z&to=2026-09-03T15%3A00%3A00.000Z&effect=registered_reservation_change&outcome=partial_success&search=RQ-260901&limit=25&after=YWZ0ZXI');
  assert.equal(buildAutomationAuditQuery({
    range: 'today', effect: 'reservation_registration', outcome: 'success', search: '', limit: 50,
  }), 'range=today&effect=reservation_registration&outcome=success&limit=50');
});

test('audit inbox labels staff-authorized reservation registration distinctly', async () => {
  const { buildAutomationAuditView } = await loadModel();
  const registration = item({
    eventKey: `kakao:reservation_registration:${'b'.repeat(64)}`,
    effectType: 'reservation_registration',
    targetType: 'trade',
    targetId: '260906-001',
    summary: '예약 260906-001을 등록했습니다.',
  });
  const model = buildAutomationAuditView({ payload: payload({ items: [registration] }) });

  assert.equal(model.rows[0].effectLabel, '예약 등록');
  assert.equal(model.rows[0].ownerLine, '테스트 고객 · 예약 260906-001을 등록했습니다.');
});

test('audit outcome badges distinguish success, partial, failure, block, and no action', async () => {
  const { buildAutomationAuditView } = await loadModel();
  const outcomes = ['success', 'partial_success', 'failed', 'blocked', 'no_action'];
  const items = outcomes.map((outcome, index) => item({
    eventKey: `kakao:confirmation_request:${String(index + 1).repeat(64)}`,
    occurredAt: `2026-09-07T00:0${index}:00.000Z`,
    outcome,
    evidence: { schema: 'village-confirmation-receipt/v1', status: outcome, readback: outcome === 'success' },
  }));
  const model = buildAutomationAuditView({ payload: payload({ items }), selectedEventKey: items[3].eventKey });
  assert.deepEqual(model.rows.map(({ outcomeLabel }) => outcomeLabel), ['완료', '일부 완료', '실패', '차단', '처리 없음']);
  assert.deepEqual(model.rows.map(({ outcomeIcon }) => outcomeIcon), ['✓', '!', '×', '⊘', '—']);
  assert.equal(model.selected.eventKey, items[3].eventKey);
});

test('audit inbox preserves delayed and pagination state without creating work counts', async () => {
  const { buildAutomationAuditView } = await loadModel();
  const model = buildAutomationAuditView({
    payload: payload({ items: [], nextCursor: 'YWZ0ZXI', sync: { delayed: true } }),
    selectedEventKey: null,
  });
  assert.deepEqual(model.rows, []);
  assert.equal(model.selected, null);
  assert.equal(model.nextCursor, 'YWZ0ZXI');
  assert.equal(model.syncDelayed, true);
  assert.equal('tabs' in model, false);
  assert.equal('counts' in model, false);
});

test('audit inbox rejects private, malformed, duplicated, or unsafe records', async () => {
  const { buildAutomationAuditQuery, buildAutomationAuditView } = await loadModel();
  const duplicate = item();
  for (const bad of [
    payload({ raw: 'conversation' }),
    payload({ items: [item({ customerLabel: '010-1234-5678' })] }),
    payload({ items: [item({ outboundText: 'token=secret' })] }),
    payload({ items: [item({ outboundText: '우리은행 1005-404-109661로 보내주세요' })] }),
    payload({ items: [item({ evidence: { schema: 'x', status: 'ok', readback: true, stack: 'private' } })] }),
    payload({ items: [duplicate, duplicate] }),
    payload({ items: [item({ occurredAt: 'not-a-time' })] }),
    payload({ items: [item({ changeItems: [{ field: 'phone', before: null, after: 'x' }] })] }),
  ]) assert.throws(() => buildAutomationAuditView({ payload: bad, selectedEventKey: null }), /audit payload invalid/);

  for (const badFilter of [
    { range: 'month', effect: '', outcome: '', search: '', limit: 50 },
    { range: 'custom', customFrom: '', customTo: '', effect: '', outcome: '', search: '', limit: 50 },
    { range: 'today', effect: 'unknown', outcome: '', search: '', limit: 50 },
    { range: 'today', effect: '', outcome: '', search: '010-1234-5678', limit: 50 },
    { range: 'today', effect: '', outcome: '', search: '우리은행 1005-404-109661', limit: 50 },
    { range: 'today', effect: '', outcome: '', search: '', limit: 101 },
  ]) assert.throws(() => buildAutomationAuditQuery(badFilter), /audit filter invalid/);
});
