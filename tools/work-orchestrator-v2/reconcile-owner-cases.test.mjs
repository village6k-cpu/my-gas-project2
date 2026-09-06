import assert from 'node:assert/strict';
import test from 'node:test';
import * as reconciliation from './reconcile-owner-cases.mjs';

const assignments = [{
  id: '11111111-1111-4111-8111-111111111111',
  expectedVersion: 4,
  caseKey: 'jeong:2026-09-03:applebox-pickup-missing',
  title: '정원근 애플박스 반출 누락',
  requestSummary: '예약한 애플박스 풀과 풀세트를 무인 반출하려는 문의입니다.',
  problemSummary: '현장에는 풀 하나만 있고 계약서도 확인되지 않았습니다.',
  nextActionSummary: '전화 안내 후 누락 장비와 계약서를 확인하세요.',
  taskKey: 'applebox-pickup-recovery'
}];

test('owner case reconciliation is dry-run by default and uses exact id/version assignments', async () => {
  const calls = [];
  const store = { reconcileOwnerCases: async (input) => { calls.push(input); return { applied: false, planned: 1, updated: 0, stale: 0, rows: [] }; } };
  const result = await reconciliation.runOwnerCaseReconciliation({ store, assignments });
  assert.deepEqual(calls, [{ assignments, apply: false }]);
  assert.deepEqual(result, { applied: false, planned: 1, updated: 0, stale: 0, rows: [] });
});

test('owner case reconciliation rejects private or malformed assignment text before store access', async () => {
  let called = false;
  const store = { reconcileOwnerCases: async () => { called = true; } };
  for (const invalid of [
    [{ ...assignments[0], expectedVersion: 0 }],
    [{ ...assignments[0], problemSummary: '연락처 010-1111-2222' }],
    [{ ...assignments[0], extra: true }]
  ]) await assert.rejects(reconciliation.runOwnerCaseReconciliation({ store, assignments: invalid }), /invalid/i);
  assert.equal(called, false);
});
