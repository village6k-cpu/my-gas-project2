import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSlackBackstopRow,
  collectSlackBackstopCandidates,
  looksActionableSlackTask,
  looksResolvedSlackThread,
  normalizeChannelRefs
} from './slack-followup-backstop.mjs';

const NOW = Date.parse('2026-06-19T12:00:00.000Z');
const tsHoursAgo = (hours) => String((NOW - hours * 36e5) / 1000);

test('normalizeChannelRefs splits comma-separated Slack channel refs', () => {
  assert.deepEqual(normalizeChannelRefs('스케쥴-agent, #정산-agent, C123'), ['스케쥴-agent', '#정산-agent', 'C123']);
});

test('looksActionableSlackTask detects Heybilli mention and work keywords', () => {
  const result = looksActionableSlackTask({ ts: tsHoursAgo(3), text: '헤이빌리 이 건 견적서 발송 확인 필요' });
  assert.equal(result.actionable, true);
  assert.ok(result.reasons.includes('mentions_heybilli'));
  assert.ok(result.reasons.includes('action_keyword'));
});

test('looksActionableSlackTask detects bot task card blocks', () => {
  const result = looksActionableSlackTask({
    ts: tsHoursAgo(3),
    subtype: 'bot_message',
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text: '*작업*\n고객 예약 확인 필요' } }]
  });
  assert.equal(result.actionable, true);
  assert.ok(result.reasons.includes('bot_task_card'));
});

test('looksActionableSlackTask ignores pure settlement event notifications', () => {
  const result = looksActionableSlackTask({ ts: tsHoursAgo(1), text: ':moneybag: *입금 132,000원* — 공강혁' });
  assert.equal(result.actionable, false);
  assert.ok(result.reasons.includes('pure_settlement_notification'));
});

test('looksActionableSlackTask keeps settlement notifications when Heybilli is explicitly called', () => {
  const result = looksActionableSlackTask({ ts: tsHoursAgo(1), text: '헤이빌리 :moneybag: *입금 132,000원* — 공강혁 확인 필요' });
  assert.equal(result.actionable, true);
  assert.ok(result.reasons.includes('mentions_heybilli'));
});

test('looksResolvedSlackThread closes candidates after completion marker', () => {
  const root = { ts: tsHoursAgo(5), text: '헤이빌리 세금계산서 확인 필요' };
  const done = { ts: tsHoursAgo(2), text: '처리 완료했습니다 ✅' };
  const result = looksResolvedSlackThread([root, done], { candidateTs: root.ts });
  assert.equal(result.resolved, true);
});

test('collectSlackBackstopCandidates keeps any unresolved task and skips resolved one', () => {
  const channel = { id: 'C123', name: '서류발송-agent' };
  const unresolved = { ts: tsHoursAgo(0.1), text: '헤이빌리 견적서 발송 확인 필요' };
  const resolved = { ts: tsHoursAgo(9), text: '헤이빌리 계약서 발송 확인 필요', thread_ts: tsHoursAgo(9) };
  const done = { ts: tsHoursAgo(7), text: '완료', thread_ts: resolved.ts };
  const messages = [unresolved, resolved];
  const candidates = collectSlackBackstopCandidates(channel, messages, {
    [unresolved.ts]: [unresolved],
    [resolved.ts]: [resolved, done]
  }, { nowMs: NOW });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].message.ts, unresolved.ts);
});

test('buildSlackBackstopRow creates stable follow-up row for dashboard', () => {
  const message = { ts: tsHoursAgo(30), text: '헤이빌리 입금 확인 필요' };
  const row = buildSlackBackstopRow({
    channel: { id: 'C999', name: '정산-agent' },
    message,
    text: message.text,
    reasons: ['mentions_heybilli', 'action_keyword'],
    ageHours: 30
  }, { nowMs: NOW });
  assert.equal(row.source, 'slack_backstop');
  assert.equal(row.type, 'payment_check');
  assert.equal(row.priority, 'high');
  assert.match(row.follow_up_key, /^slack-backstop:/);
  assert.equal(row.payload.slack_backstop.channel_name, '정산-agent');
});
