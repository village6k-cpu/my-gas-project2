import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { extractOwnerInterventionCards, mergeCorrectionsLedger, runMiner } from './mine-kakao-corrections.mjs';
import { buildCorrectionsPromptText } from './worker.mjs';

const NOW = new Date('2026-08-12T00:00:00.000Z');

function entry(at, overrides = {}) {
  return { at, customer: '임선', dedupeKey: 'chat:12345|q|r', ...overrides };
}

test('extractOwnerInterventionCards finds staff messages that the bot never sent', () => {
  const entries = [
    entry('2026-08-11T02:00:00.000Z', { result: { sent: true, text: '반납 날짜와 시간을 한 번만 다시 알려주세요!' } }),
    entry('2026-08-11T04:30:00.000Z', {
      result: { sent: false },
      evidence: [
        { sender: '임선', message: '반출 변경 요청입니다' },
        { sender: '빌리지님', message: '반납 날짜와 시간을 한 번만 다시 알려주세요!' },
        { sender: '빌리지님', message: '전화로 확인했습니다. 8월 11일 오전 2시 30분 반출로 변경해두었어요.' },
        { sender: '빌리지님', message: '알림톡/브랜드메시지는 관리자센터에서 확인할 수 없어요.' },
        { sender: '임선', message: '감사합니다' }
      ]
    })
  ];
  const cards = extractOwnerInterventionCards(entries, { now: NOW });
  assert.equal(cards.length, 1);
  assert.match(cards[0], /사장 수동응대/);
  assert.match(cards[0], /전화로 확인했습니다/);
  assert.match(cards[0], /직전 봇 발송/);
  assert.doesNotMatch(cards[0], /알림톡\/브랜드메시지/);
});

test('extractOwnerInterventionCards ignores stale windows and customer messages', () => {
  const entries = [
    entry('2026-08-01T02:00:00.000Z', {
      result: { sent: false },
      evidence: [{ sender: '빌리지님', message: '옛날 수동 응대 메시지입니다' }]
    }),
    entry('2026-08-11T05:00:00.000Z', {
      result: { sent: false },
      evidence: [{ sender: '임선', message: '고객이 보낸 메시지는 교정 대상이 아닙니다' }]
    })
  ];
  assert.deepEqual(extractOwnerInterventionCards(entries, { now: NOW }), []);
});

test('mergeCorrectionsLedger dedupes, keeps newest section first, and prunes old sections', () => {
  const existing = [
    '# 빌리지 카카오 응대 교정 원장',
    '(헤더 설명)',
    '',
    '## 2026-08-10',
    '- [08-10 김세원] 사장 수동응대: "기존 사례"',
    '',
    '## 2026-05-01',
    '- [05-01 아무개] 사장 수동응대: "오래된 사례"'
  ].join('\n');
  const { output, added } = mergeCorrectionsLedger(existing, [
    '- [08-11 임선] 사장 수동응대: "새 사례"',
    '- [08-10 김세원] 사장 수동응대: "기존 사례"'
  ], { now: NOW });

  assert.equal(added, 1);
  assert.match(output, /## 2026-08-12\n- \[08-11 임선\]/);
  assert.match(output, /기존 사례/);
  assert.doesNotMatch(output, /오래된 사례/);
  assert.ok(output.indexOf('2026-08-12') < output.indexOf('2026-08-10'), '최신 섹션이 위');
});

test('runMiner writes the ledger end to end and is idempotent', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmp-corrections-'));
  const logPath = path.join(tmpDir, 'auto-replies.ndjson');
  const outPath = path.join(tmpDir, 'corrections-latest.md');
  const lines = [
    JSON.stringify(entry('2026-08-11T02:00:00.000Z', { result: { sent: true, text: '봇이 보낸 안내' } })),
    JSON.stringify(entry('2026-08-11T04:30:00.000Z', {
      result: { sent: false },
      evidence: [{ sender: '빌리지님', message: '사장이 직접 정리해서 보낸 안내 메시지' }]
    }))
  ];
  fs.writeFileSync(logPath, lines.join(String.fromCharCode(10)));

  const first = runMiner({ logPath, outPath, now: NOW });
  assert.equal(first.ok, true);
  assert.equal(first.added, 1);
  const ledger = fs.readFileSync(outPath, 'utf8');
  assert.match(ledger, /사장이 직접 정리해서 보낸 안내 메시지/);

  const second = runMiner({ logPath, outPath, now: NOW });
  assert.equal(second.added, 0, '같은 사례는 재적재하지 않는다');

  // 워커 프롬프트 주입까지 이어지는지
  const block = buildCorrectionsPromptText({ correctionsPath: outPath });
  assert.match(block, /VILLAGE_CORRECTIONS/);
  assert.match(block, /사장이 직접 정리해서 보낸 안내 메시지/);
  assert.equal(buildCorrectionsPromptText({ correctionsPath: path.join(tmpDir, '없는파일.md') }), '');
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
