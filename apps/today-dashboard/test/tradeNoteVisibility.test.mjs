import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const appRoot = path.resolve(import.meta.dirname, '..');
function component(file, mocks) {
  const source = fs.readFileSync(path.join(appRoot, 'components', file), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(compiled, {
    module, exports: module.exports,
    require: (name) => name in mocks ? mocks[name] : require(name),
  });
  return module.exports;
}
const { TradeNotes } = component('TradeNotes.tsx', {
  '@/lib/data/store': { setPhaseNote() { throw new Error('render must never save'); } },
});
const Empty = () => null;
const { ScheduleCard } = component('ScheduleCard.tsx', {
  '@/lib/domain/status': {
    isCancelledTrade: () => false,
    phaseForDate: () => 'both',
    returnCompletionBlockers: () => [],
    setupProgress: () => ({ done: 1, total: 1 }),
    timeLabel: () => '오전 9:00',
  },
  '@/lib/data/store': { ensureTradePhotos() {}, setKakaoConversationChecked() {}, toggleReturn() {}, toggleSetup() {} },
  './TradeNotes': { TradeNotes },
  ...Object.fromEntries(['HandoverChecklist', 'RiskPanel', 'PhotoStrip', 'PaymentControls', 'MyReservationLinkButton', 'CustomerSheet', 'TradeActions'].map(name => [`./${name}`, { [name]: Empty }])),
  './icons': { Check: Empty, ChevronRight: Empty, Phone: Empty },
});
const trade = {
  tradeId: 'memo-fixture', customerName: '테스트', customerPhone: '010-0000-0000',
  checkoutAt: '2026-10-16T09:00:00', returnAt: '2026-10-16T18:00:00',
  contractStatus: '예약', setupDone: false, returnDone: false, equipments: [], photos: [], riskWarnings: [],
  noteCheckout: '배터리 2개 추가\n매직암 1개 추가\n케이블 2개 추가\n파우치 함께 회수',
  noteCheckin: '추가 장비까지 수량 확인',
};
const render = (Component, props) => renderToStaticMarkup(React.createElement(Component, props));

for (const tab of ['checkout', 'checkin']) {
  for (const open of [false, true]) {
    test(`${tab}: ${open ? '펼친' : '접힌'} 카드에서도 전체메모 전문은 완료 버튼보다 먼저 나온다`, () => {
      const html = render(ScheduleCard, { trade, date: '2026-10-16', tab, defaultOpen: open });
      assert(html.includes(trade.noteCheckout), '마지막 줄까지 포함한 전문이 필요하다');
      assert(html.includes(trade.noteCheckin), '반출·반납 양쪽 기록이 필요하다');
      const noteEnd = html.indexOf('파우치 함께 회수');
      const completionLabel = tab === 'checkout' ? '반출 완료' : '반납 완료';
      assert(noteEnd < html.indexOf(completionLabel), '메모를 읽기 전에 완료로 넘어가면 안 된다');
      assert.equal(html.split('aria-label="반출 전체 메모"').length - 1, 1, '전문이 중복 표시되면 안 된다');
    });
  }
}
test('완료된 접힌 카드에서도 추가 반출 내역이 남아 있다', () => {
  const html = render(ScheduleCard, { trade: { ...trade, setupDone: true, returnDone: true }, date: '2026-10-16', tab: 'checkin' });
  assert(html.includes(trade.noteCheckout));
  assert(html.includes('반납 완료됨'));
});
test('빈 메모는 강조 영역을 만들지 않고 펼친 카드에서 작성할 수 있다', () => {
  const blank = { ...trade, noteCheckout: '  ', noteCheckin: '' };
  assert.equal(render(TradeNotes, { trade: blank, phase: 'checkout', showAdd: false }), '');
  const html = render(TradeNotes, { trade: blank, phase: 'checkout', showAdd: true });
  assert(html.includes('+ 반출 전체 메모'));
  assert(!html.includes('<section'));
});
test('메모는 HTML이 아닌 원문 텍스트로 렌더링된다', () => {
  const html = render(TradeNotes, { trade: { ...trade, noteCheckout: '<script>alert(1)</script>\n배터리 & 케이블' }, phase: 'checkin', showAdd: false });
  assert(!html.includes('<script>'));
  assert(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;\n배터리 &amp; 케이블'));
});
