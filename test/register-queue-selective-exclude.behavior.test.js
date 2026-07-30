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

test('최상위 미등록 장비(❓)는 바로등록 승인 없이는 등록을 차단한다', () => {
  const ctx = loadContext(['getBlockingRegisterIssue_']);
  const mk = (result, opts = {}) => {
    const row = new Array(18).fill('');
    row[0] = 'RQ-1';
    row[8] = result;
    row[14] = opts.status || '';
    row[16] = opts.tag || '';
    return row;
  };
  // 최상위 미등록 → 차단
  assert.match(String(ctx.getBlockingRegisterIssue_([mk('❓ 미등록 장비')], 'RQ-1')), /미등록/);
  // 바로등록 승인 시 통과 (사장 최종 승인)
  assert.equal(ctx.getBlockingRegisterIssue_([mk('❓ 미등록 장비')], 'RQ-1', true), '');
  // 세트 구성품([세트] 태그)은 기존처럼 면제
  assert.equal(ctx.getBlockingRegisterIssue_([mk('❓ 미등록 장비', { tag: '[세트]조명세트' })], 'RQ-1'), '');
  // 제외 행 면제
  assert.equal(ctx.getBlockingRegisterIssue_([mk('❓ 미등록 장비', { status: '제외' })], 'RQ-1'), '');
});
