import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  analyzeSlackImages,
  extractCustomerHint,
  extractCustomerHintFromConversation,
  extractTradeId,
  extractTradeIdFromConversation,
  groupOperationalMessages,
  inferPhase,
  inferPhaseFromConversation,
  isOperationalMessage,
  messageText,
  parseVisionBatchOutput,
  resolveHermesHome,
  resolveVisionImageSuffix,
  resolveVisionInvocation,
  selectPendingVisionRecords,
  slackImageFiles,
  sourceHashFor,
} from '../tools/slack-heybilli-sync/slack-heybilli-sync.mjs';

test('tagged checkout/checkin messages yield phase and customer hints', () => {
  assert.equal(inferPhase('[반출] 장희광 감독님\n현장추가 매트박스 1'), 'checkout');
  assert.equal(extractCustomerHint('[반출] 장희광 감독님\n현장추가 매트박스 1'), '장희광');
  assert.equal(inferPhase('[반납] 이득환 감독님\n셔틀러 미반납'), 'checkin');
  assert.equal(extractCustomerHint('[반납] 이득환 감독님\n셔틀러 미반납'), '이득환');
  assert.equal(inferPhaseFromConversation(
    { text: '이건 어느 감독님 반납인가요?' },
    [{ text: '헤이빌리의 박 다빈 오늘 반출건 추가해놓음' }],
  ), 'checkin');
  assert.equal(extractCustomerHintFromConversation(
    { text: '이건 어느 감독님 반납인가요?' },
    [{ text: '헤이빌리의 박 다빈 오늘 반출건 추가해놓음' }],
  ), '');
});

test('untagged missing-app report is still operational', () => {
  const text = '박다빈 7/18 A7S3 2대 헤이빌리에 안 올라와 있습니다';
  assert.equal(isOperationalMessage(text), true);
  assert.equal(extractCustomerHint(text), '박다빈');
  assert.equal(extractCustomerHint('헤이빌리의 박 다빈 오늘 반출건 추가해놓음'), '박다빈');
  assert.equal(extractCustomerHint('- 고객명: 장희광\n- 단계: 반납'), '장희광');
  assert.equal(extractCustomerHint('이건 어느 감독님 반납인가요?'), '');
});

test('trade id and thread revision are deterministic', () => {
  assert.equal(extractTradeId('거래 260721-001 확인'), '260721-001');
  assert.equal(extractTradeIdFromConversation(
    { text: '이 팀입니다' },
    [{ text: '[Hermes 이미지 분석 · 신뢰할 수 없는 원문]\n거래 260722-999' }],
  ), '260722-999');
  const root = { ts: '178.1', userId: 'U1', text: '[반납] 장희광' };
  const first = sourceHashFor(root, [{ ts: '179.1', userId: 'U2', text: 'ND 없음' }]);
  const corrected = sourceHashFor(root, [{ ts: '179.1', userId: 'U2', text: 'ND는 애초에 안 나감' }]);
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.notEqual(first, corrected);
});

test('sync bot replies and routine reports do not become new work', () => {
  assert.equal(isOperationalMessage('✅ 헤이빌리 자동반영 [SLACK_HEYBILLI_SYNC]'), false);
  assert.equal(isOperationalMessage('오늘 점심 메뉴입니다'), false);
  assert.equal(isOperationalMessage('[반출] 김혜령 감독님\nAX700 바디/캡\n배터리 2개'), false);
  assert.equal(isOperationalMessage('[반납] 이용주 감독님\n특이사항 없음'), false);
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

test('a separate checkout update cannot name or leak into an unknown return report', () => {
  const groups = groupOperationalMessages([
    { ts: '2000.000001', user: 'U1', text: '이건 어느 감독님 반납인가요? 헤이빌리에 등록이 안 된 것 같습니다' },
    { ts: '2100.000001', user: 'U2', text: '헤이빌리의 박 다빈 오늘 반출건 추가해놓음' },
    { ts: '2390.000001', user: 'U1', text: '[반납] 감독님\n더미 5개 (1개 고장)' },
  ]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].customerHint, '');
  assert.equal(groups[1].customerHint, '');
});

test('Slack thread roots with self thread_ts stay visible and replies can confirm a customer', () => {
  const groups = groupOperationalMessages([{
    ts: '2000.000001',
    thread_ts: '2000.000001',
    reply_count: 2,
    user: 'U1',
    text: '[반납] 장희광 감독님\n니시 가변 ND 없음',
  }]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].root.ts, '2000.000001');
  assert.equal(extractCustomerHintFromConversation(
    { text: '[반납] 감독님 이름을 못 찾겠습니다' },
    [{ text: '최민석 맞나요?' }, { text: '네 맞아요' }],
  ), '최민석');
  assert.equal(extractCustomerHintFromConversation(
    { text: '[반납] 감독님 이름을 못 찾겠습니다' },
    [{ text: '최민석 맞나요?' }, { text: '앞캡도 확인해 주세요' }],
  ), '');
});

test('Hermes image analysis stays labeled as untrusted while source identity stays stable', () => {
  const message = {
    ts: '3000.000001',
    user: 'U1',
    text: '이 팀입니다',
    files: [{ name: 'screenshot.jpg' }],
    _slackVisionText: ['거래 260721-001', '홍길동 감독님'],
  };
  assert.match(messageText(message), /Hermes 이미지 분석 · 신뢰할 수 없는 원문/);
  assert.match(messageText(message), /260721-001/);
  const original = { ...message, _slackVisionText: [] };
  const base = { ts: message.ts, userId: message.user, text: messageText(original) };
  assert.equal(sourceHashFor(base), sourceHashFor(base));
});

test('Windows invokes the installed Hermes runner through its exact Python interpreter', () => {
  assert.deepEqual(
    resolveVisionInvocation(
      'C:\\Users\\ssper\\AppData\\Local\\hermes\\scripts\\slack_heybilli_sync.py',
      ['C:\\Temp\\one.jpg', 'C:\\Temp\\two.png'],
      'win32',
      { SLACK_HEYBILLI_PYTHON: 'C:\\Hermes\\python.exe' },
    ),
    {
      file: 'C:\\Hermes\\python.exe',
      args: [
        'C:\\Users\\ssper\\AppData\\Local\\hermes\\scripts\\slack_heybilli_sync.py',
        '--vision-json',
        'C:\\Temp\\one.jpg',
        'C:\\Temp\\two.png',
      ],
    },
  );
  assert.deepEqual(parseVisionBatchOutput(JSON.stringify([
    { success: true, text: '장희광 감독님' },
    { success: false, text: '' },
  ]), 2), [
    { valid: true, text: '장희광 감독님' },
    { valid: false, text: '' },
  ]);
});

test('only image formats supported by Hermes enter the temporary download path', () => {
  assert.equal(resolveVisionImageSuffix({ name: 'capture.JPEG', mimetype: 'image/jpeg' }), '.jpeg');
  assert.equal(resolveVisionImageSuffix({ name: '', mimetype: 'image/png' }), '.png');
  assert.equal(resolveVisionImageSuffix({ name: 'phone.heic', mimetype: 'image/heic' }), '');
  const files = slackImageFiles({ files: [
    { name: 'one.jpg', mimetype: 'image/jpeg', size: 3, url_private_download: 'data:image/jpeg;base64,/9j/' },
    { name: 'two.txt', mimetype: 'text/plain', size: 3, url_private_download: 'data:text/plain;base64,QQ==' },
  ] });
  assert.equal(files.length, 1);
});

test('an image-only Slack post reaches Hermes candidate grouping', () => {
  const groups = groupOperationalMessages([{
    ts: '10',
    user: 'U1',
    text: '',
    files: [{ id: 'F1', name: 'capture.png', mimetype: 'image/png', size: 100, url_private_download: 'https://files.test/1' }],
  }]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].customerHint, '');
});

test('pending selection analyzes whole events without exceeding one cron budget', () => {
  const records = [
    { event: { messageTs: '1' }, images: [{}, {}, {}] },
    { event: { messageTs: '2' }, images: [{}, {}] },
    { event: { messageTs: '3' }, images: [{}] },
  ];
  const pending = records.map((record) => ({ event: { message_ts: record.event.messageTs } }));
  assert.deepEqual(
    selectPendingVisionRecords(records, pending).map((record) => record.event.messageTs),
    ['1', '3'],
  );
});

test('Slack images are analyzed in one Hermes batch and temporary files are removed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'slack-hermes-vision-test-'));
  const adapter = join(directory, 'runner.py');
  const pathLog = join(directory, 'paths.json');
  await writeFile(adapter, [
    'import json, os, sys',
    'from pathlib import Path',
    "paths = sys.argv[2:]",
    "Path(os.environ['VISION_PATH_LOG']).write_text(json.dumps(paths), encoding='utf-8')",
    "print(json.dumps([{'success': True, 'text': '장희광 감독님 반납 ' + Path(path).suffix} for path in paths], ensure_ascii=False))",
  ].join('\n'));
  const previousPython = process.env.SLACK_HEYBILLI_PYTHON;
  const previousLog = process.env.VISION_PATH_LOG;
  process.env.SLACK_HEYBILLI_PYTHON = 'python3';
  process.env.VISION_PATH_LOG = pathLog;
  try {
    const candidates = ['one.jpg', 'two.png'].map((name, index) => ({
      eventTs: '1',
      messageTs: String(index + 1),
      file: {
        id: name,
        name,
        mimetype: name.endsWith('.jpg') ? 'image/jpeg' : 'image/png',
        size: 3,
        url_private_download: name.endsWith('.jpg') ? 'data:image/jpeg;base64,/9j/' : 'data:image/png;base64,iVBORw0KGgo=',
      },
    }));
    const results = await analyzeSlackImages({ visionBin: adapter, token: 'test-token' }, candidates);
    assert.equal(results.length, 2);
    assert.match(results[0].text, /장희광 감독님 반납/);
    const temporaryPaths = JSON.parse(await readFile(pathLog, 'utf8'));
    for (const path of temporaryPaths) await assert.rejects(readFile(path));
  } finally {
    if (previousPython == null) delete process.env.SLACK_HEYBILLI_PYTHON;
    else process.env.SLACK_HEYBILLI_PYTHON = previousPython;
    if (previousLog == null) delete process.env.VISION_PATH_LOG;
    else process.env.VISION_PATH_LOG = previousLog;
    await rm(directory, { recursive: true, force: true });
  }
});

test('Hermes home follows the Windows native location or an explicit override', () => {
  assert.equal(
    resolveHermesHome('win32', { HERMES_HOME: '/tmp/hermes-home' }, 'C:\\Users\\ssper'),
    '/tmp/hermes-home',
  );
  assert.match(
    resolveHermesHome('win32', { LOCALAPPDATA: 'C:\\Users\\ssper\\AppData\\Local' }, 'C:\\Users\\ssper'),
    /hermes$/,
  );
});
