import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractCustomerHint,
  extractTradeId,
  inferPhase,
  isOperationalMessage,
  sourceHashFor,
} from '../tools/slack-heybilli-sync/slack-heybilli-sync.mjs';

test('tagged checkout/checkin messages yield phase and customer hints', () => {
  assert.equal(inferPhase('[반출] 장희광 감독님\n현장추가 매트박스 1'), 'checkout');
  assert.equal(extractCustomerHint('[반출] 장희광 감독님\n현장추가 매트박스 1'), '장희광');
  assert.equal(inferPhase('[반납] 이득환 감독님\n셔틀러 미반납'), 'checkin');
  assert.equal(extractCustomerHint('[반납] 이득환 감독님\n셔틀러 미반납'), '이득환');
});

test('untagged missing-app report is still operational', () => {
  const text = '박다빈 7/18 A7S3 2대 헤이빌리에 안 올라와 있습니다';
  assert.equal(isOperationalMessage(text), true);
  assert.equal(extractCustomerHint(text), '박다빈');
});

test('trade id and thread revision are deterministic', () => {
  assert.equal(extractTradeId('거래 260721-001 확인'), '260721-001');
  const root = { ts: '178.1', userId: 'U1', text: '[반납] 장희광' };
  const first = sourceHashFor(root, [{ ts: '179.1', userId: 'U2', text: 'ND 없음' }]);
  const corrected = sourceHashFor(root, [{ ts: '179.1', userId: 'U2', text: 'ND는 애초에 안 나감' }]);
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.notEqual(first, corrected);
});

test('sync bot replies do not become new operational work', () => {
  assert.equal(isOperationalMessage('✅ 헤이빌리 자동반영 [SLACK_HEYBILLI_SYNC]'), false);
  assert.equal(isOperationalMessage('오늘 점심 메뉴입니다'), false);
});
