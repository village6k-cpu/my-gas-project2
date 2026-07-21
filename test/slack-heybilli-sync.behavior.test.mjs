import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractCustomerHint,
  extractCustomerHintFromConversation,
  extractTradeId,
  groupOperationalMessages,
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

test('routine checkout and no-exception return reports do not create reconciliation work', () => {
  assert.equal(isOperationalMessage('[반출] 김혜령 감독님\nAX700 바디/캡\n배터리 2개'), false);
  assert.equal(isOperationalMessage('[반납] 이용주 감독님\n특이사항 없음'), false);
  assert.equal(isOperationalMessage('그리고 이거 2개 샀는데 1개가 갑자기 안 보이더라'), false);
  assert.equal(isOperationalMessage('파이로S에서 바로 연결하다 안돼서 저렇게 챙겨갔습니다'), false);
  assert.equal(isOperationalMessage('[반출] 장희광 감독님\n현장 추가\n매트박스'), true);
  assert.equal(isOperationalMessage('[반납] 최민석 감독님\n셔틀러 플로우텍 2개 없음'), true);
});

test('nearby top-level corrections are grouped without merging a new tagged report', () => {
  const groups = groupOperationalMessages([
    { ts: '1000.000001', user: 'U1', text: '[반납] 최민석 감독님\n셔틀러 플로우텍 2개 없음' },
    { ts: '1063.000001', user: 'U2', text: '1개 반출했는데 1개도 없나?' },
    { ts: '1066.000001', user: 'U2', text: '어플 반출완료 안 누르면 반납완료가 안 눌러집니다' },
    { ts: '1100.000001', user: 'U1', text: '[반출] 장희광 감독님\n현장 추가 매트박스' },
  ]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].nearby.length, 2);
  assert.equal(groups[1].nearby.length, 0);
});

test('Slack thread roots with self thread_ts stay visible and reply text can supply customer name', () => {
  const groups = groupOperationalMessages([
    {
      ts: '2000.000001',
      thread_ts: '2000.000001',
      reply_count: 2,
      user: 'U1',
      text: '[반납] 장희광 감독님\n니시 가변 ND 없음',
    },
    {
      ts: '2100.000001',
      user: 'U2',
      text: '[반납] 감독님 이름을 못 찾겠습니다',
    },
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].root.ts, '2000.000001');
  assert.equal(extractCustomerHint('[반납] 감독님 이름을 못 찾겠습니다\n최민석 맞나요?'), '');
  assert.equal(extractCustomerHintFromConversation(
    { text: '[반납] 감독님 이름을 못 찾겠습니다' },
    [{ text: '최민석 맞나요?' }, { text: '네 맞아요' }],
  ), '최민석');
  assert.equal(extractCustomerHintFromConversation(
    { text: '[반납] 감독님 이름을 못 찾겠습니다' },
    [{ text: '최민석 맞나요?' }, { text: '앞캡도 확인해 주세요' }],
  ), '');
});
