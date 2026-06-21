import test from 'node:test';
import assert from 'node:assert/strict';
import { executeVillageDocumentCommand, planVillageDocumentCommand } from '../tools/village-doc-send/runner.mjs';

test('plans natural Slack command by resolving customer/date to tradeId before document action', async () => {
  const calls = [];
  const fakeFetchJson = async (url) => {
    calls.push(String(url));
    return { candidates: [{ tradeId: '260528-005', name: '김태완', checkout: '2026-06-01 22:00' }] };
  };

  const plan = await planVillageDocumentCommand('6월 1일 김태완 건 견적서 발송해줘', {
    now: new Date('2026-06-01T09:00:00+09:00'),
    scheduleApiBaseUrl: 'https://schedule.example/exec',
    scheduleApiKey: 'schedule-key',
    fetchJson: fakeFetchJson,
  });

  assert.equal(calls.length, 1);
  assert.match(calls[0], /action=tradeCandidates/);
  assert.match(calls[0], /name=%EA%B9%80%ED%83%9C%EC%99%84/);
  assert.equal(plan.ok, true);
  assert.equal(plan.tradeId, '260528-005');
  assert.deepEqual(plan.action.body, { action: 'sendEstimate', id: '260528-005' });
});

test('returns ambiguous instead of sending when customer/date has multiple candidates', async () => {
  const plan = await planVillageDocumentCommand('6월 1일 김태완 건 견적서 발송해줘', {
    now: new Date('2026-06-01T09:00:00+09:00'),
    scheduleApiBaseUrl: 'https://schedule.example/exec',
    scheduleApiKey: 'schedule-key',
    fetchJson: async () => ({ candidates: [{ tradeId: '1' }, { tradeId: '2' }] }),
  });

  assert.deepEqual(plan, {
    ok: false,
    reason: 'ambiguous',
    parsed: plan.parsed,
    candidates: [{ tradeId: '1' }, { tradeId: '2' }],
  });
});

test('execute mode resolves once and posts document action to my-gas-project with ops key', async () => {
  const calls = [];
  const fakeFetchJson = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).includes('schedule.example')) {
      return { candidates: [{ tradeId: '260528-005', name: '김태완', checkout: '2026-06-01 22:00' }] };
    }
    return { status: 'OK', action: 'sendEstimate', tradeID: '260528-005', message: '견적서 발송 요청 완료' };
  };

  const result = await executeVillageDocumentCommand('6월 1일 김태완 건 견적서 발송해줘', {
    now: new Date('2026-06-01T09:00:00+09:00'),
    scheduleApiBaseUrl: 'https://schedule.example/exec',
    scheduleApiKey: 'schedule-key',
    documentApiBaseUrl: 'https://docs.example/exec',
    documentApiKey: 'doc-key',
    fetchJson: fakeFetchJson,
  });

  assert.equal(result.ok, true);
  assert.equal(result.tradeId, '260528-005');
  assert.deepEqual(result.response, { status: 'OK', action: 'sendEstimate', tradeID: '260528-005', message: '견적서 발송 요청 완료' });
  assert.equal(calls.length, 2);
  assert.match(calls[1].url, /^https:\/\/docs\.example\/exec$/);
  assert.equal(calls[1].options.method, 'POST');
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    action: 'sendEstimate',
    id: '260528-005',
    key: 'doc-key',
  });
});

test('execute mode refuses preview-only requests before posting', async () => {
  let calledDocumentApi = false;
  const result = await executeVillageDocumentCommand('6월 1일 김태완 건 견적서 만들어줘', {
    now: new Date('2026-06-01T09:00:00+09:00'),
    scheduleApiBaseUrl: 'https://schedule.example/exec',
    scheduleApiKey: 'schedule-key',
    documentApiBaseUrl: 'https://docs.example/exec',
    documentApiKey: 'doc-key',
    fetchJson: async (url) => {
      if (String(url).includes('docs.example')) calledDocumentApi = true;
      return { candidates: [{ tradeId: '260528-005', name: '김태완' }] };
    },
  });

  assert.equal(calledDocumentApi, false);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not_send_request');
});

test('execute mode fetches contract info instead of trying an unsupported customer send', async () => {
  const calls = [];
  const fakeFetchJson = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).includes('schedule.example')) {
      return { candidates: [{ tradeId: '260602-001', name: '김태완', checkout: '2026-06-02 10:00' }] };
    }
    return { status: 'OK', tradeID: '260602-001', contractLink: 'https://docs.example/contract' };
  };

  const result = await executeVillageDocumentCommand('김태완 내일 계약서 링크 보내줘', {
    now: new Date('2026-06-01T09:00:00+09:00'),
    scheduleApiBaseUrl: 'https://schedule.example/exec',
    scheduleApiKey: 'schedule-key',
    documentApiBaseUrl: 'https://docs.example/exec',
    documentApiKey: 'doc-key',
    fetchJson: fakeFetchJson,
  });

  assert.equal(result.ok, true);
  assert.equal(result.tradeId, '260602-001');
  assert.equal(calls.length, 2);
  assert.match(calls[1].url, /action=info/);
  assert.match(calls[1].url, /id=260602-001/);
  assert.match(calls[1].url, /key=doc-key/);
  assert.equal(calls[1].options.method, 'GET');
});

test('runner blocks payment update wording in document-send workflow', async () => {
  let called = false;
  const result = await planVillageDocumentCommand('김태완 오늘 결제수단 카드로 처리하고 견적서 발송', {
    now: new Date('2026-06-01T09:00:00+09:00'),
    scheduleApiBaseUrl: 'https://schedule.example/exec',
    scheduleApiKey: 'schedule-key',
    fetchJson: async () => {
      called = true;
      return { candidates: [{ tradeId: '260601-003', name: '김태완' }] };
    },
  });

  assert.equal(called, false);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'payment_out_of_scope_for_document_channel');
});


