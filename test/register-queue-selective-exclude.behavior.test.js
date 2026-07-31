const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const backend = fs.readFileSync(path.resolve(__dirname, '..', 'checkAvailability.js'), 'utf8');

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`${name} function body is incomplete`);
}

function loadContext(names) {
  const context = {};
  vm.createContext(context);
  vm.runInContext(
    names.map((n) => extractFunction(backend, n)).join('\n') +
      '\n' +
      names.map((n) => `this.${n} = ${n};`).join('\n'),
    context
  );
  return context;
}

test('개고생2.0 입력 중/확인완료에서 죽은 등록은 복구 가능한 상태로 취급된다', () => {
  const ctx = loadContext(['normalizeRegisterQueueStatus_', 'isRecoverableRegisterStatus_']);
  assert.equal(ctx.normalizeRegisterQueueStatus_('⏳ 개고생2.0 입력 중...'), '등록대기');
  assert.equal(ctx.normalizeRegisterQueueStatus_('✅ 개고생2.0 확인완료 (행152)'), '등록대기');
  assert.equal(ctx.isRecoverableRegisterStatus_('⏳ 개고생2.0 입력 중...'), true);
  // 기존 상태들은 그대로
  assert.equal(ctx.normalizeRegisterQueueStatus_('등록대기'), '등록대기');
  assert.equal(ctx.normalizeRegisterQueueStatus_('⏳ 등록 처리 중...'), '등록대기');
  assert.equal(ctx.normalizeRegisterQueueStatus_('제외'), '제외');
  assert.equal(ctx.normalizeRegisterQueueStatus_('등록완료'), '등록완료');
});

test('scheduleRegister는 제외 행을 등록대기로 덮어쓰지 않는다', () => {
  const body = extractFunction(backend, 'scheduleRegister');
  // O열(15열)까지 읽어 제외 행을 건너뛰고 대상 행을 골라야 한다
  assert.match(body, /getRange\(2,\s*1,\s*lastRow - 1,\s*15\)/, 'A~O열을 함께 읽어야 한다');
  assert.match(body, /제외/, '제외 행 스킵 로직 필요');
});

test('미등록 장비(❓)는 자유입력 품목으로 보고 등록을 차단하지 않는다', () => {
  const ctx = loadContext(['getBlockingRegisterIssue_']);
  const mk = (result, opts = {}) => {
    const row = new Array(18).fill('');
    row[0] = 'RQ-1';
    row[8] = result;
    row[14] = opts.status || '';
    row[16] = opts.tag || '';
    return row;
  };
  // 최상위 미등록도 자유입력 품목이므로 일반 등록에서 통과
  assert.equal(ctx.getBlockingRegisterIssue_([mk('❓ 미등록 장비')], 'RQ-1'), '');
  // 바로등록 승인에서도 동일하게 통과
  assert.equal(ctx.getBlockingRegisterIssue_([mk('❓ 미등록 장비')], 'RQ-1', true), '');
  // 세트 구성품([세트] 태그)은 기존처럼 면제
  assert.equal(ctx.getBlockingRegisterIssue_([mk('❓ 미등록 장비', { tag: '[세트]조명세트' })], 'RQ-1'), '');
  // 제외 행 면제
  assert.equal(ctx.getBlockingRegisterIssue_([mk('❓ 미등록 장비', { status: '제외' })], 'RQ-1'), '');
});

test('등록 복구 모드는 O열 추론이 아니라 명시 fromQueue 플래그로만 켜진다', () => {
  const registerBody = extractFunction(backend, 'registerByReqID');
  assert.match(registerBody, /startedFromRegisterQueue = registerOptions\.fromQueue === true/,
    'O열 등록대기 추론은 onEdit pre-mark 때문에 신규 중복을 조용히 완료 처리한다');
  assert.doesNotMatch(registerBody, /startedFromRegisterQueue = requestHasRecoverableRegisterStatus_/,
    '옛 O열 추론이 부활하면 안 된다');
  // 큐 드레인 경로는 복구 모드를 명시한다
  assert.match(backend, /registerByReqID\(sheet, qRow, \{ fromQueue: true \}\)/);
  assert.match(backend, /registerByReqID\(sheet, pendingRow, \{ fromQueue: true \}\)/);
});
