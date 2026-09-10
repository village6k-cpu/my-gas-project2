import test from 'node:test';
import assert from 'node:assert/strict';
import { extractCustomerHint } from '../tools/slack-heybilli-sync/slack-heybilli-sync.mjs';

test('real report: a clear customer name wins over 깨진건 in the body', () => {
  assert.equal(extractCustomerHint('이소연 감독님 fx3\n깨진건 아니고 lcd 메인보드가 나간거 같습니다'), '이소연');
});
test('ordinary untagged names and spaced names are searchable', () => {
  assert.equal(extractCustomerHint('박민호 소프트돔 그리드가 한개없는데 원래 없을까요? 반출이미지에 없습니다'), '박민호');
  assert.equal(extractCustomerHint('이 교직 메모리 반납'), '이교직');
  assert.equal(extractCustomerHint('아나키 반납 장비 이쪽에 두었습니다'), '아나키');
  assert.equal(extractCustomerHint('동교님 반납 오셨는데 내일 반출 거의 그대로 나가신다'), '동교');
  assert.equal(extractCustomerHint('매장에 시네로이드가 없는데 이따 11:00 반출 일정 있습니다'), '');
});
