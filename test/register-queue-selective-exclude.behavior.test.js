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

test('직원확정 자동등록의 operation marker는 legacy 등록 큐가 재실행하지 않는다', () => {
  const ctx = loadContext(['normalizeRegisterQueueStatus_', 'isRecoverableRegisterStatus_']);
  const marker = '⚠️ 자동등록 처리중(재실행 금지) [11111111-2222-4333-8444-555555555555]';
  assert.equal(ctx.normalizeRegisterQueueStatus_(marker), marker);
  assert.equal(ctx.isRecoverableRegisterStatus_(marker), false);

  const registerBody = extractFunction(backend, 'registerByReqID');
  const markerWrite = registerBody.indexOf('자동등록 처리중(재실행 금지)');
  const contractWrite = registerBody.indexOf('const newContractRow');
  assert.ok(markerWrite >= 0 && markerWrite < contractWrite,
    'operation marker must be durable before contract/schedule writes');

  const runnerBody = extractFunction(backend, '_runPendingRegister');
  assert.match(runnerBody, /isConfirmedRegistrationNoReplayStatus_/,
    'property queue entries must be rechecked and confirmed operations skipped');
});

test('자동등록 no-replay 상태는 동시 수동 등록 큐가 등록대기로 덮어쓰지 못한다', () => {
  const ctx = loadContext(['isConfirmedRegistrationNoReplayStatus_', 'markRegisterQueued_']);
  const writes = [];
  let current = '⚠️ 자동등록 처리중(재실행 금지) [11111111-2222-4333-8444-555555555555]';
  const sheet = {
    getRange: (_row, column) => ({
      getDisplayValue: () => current,
      setValue: (value) => { writes.push(['value', column, value]); current = value; return this; },
      setBackground: (value) => { writes.push(['background', column, value]); return this; }
    })
  };

  assert.equal(ctx.markRegisterQueued_(sheet, 2), false);
  assert.deepEqual(writes, []);

  current = '⚠️ 자동등록 후처리 실패 — 수동확인 필요';
  assert.equal(ctx.markRegisterQueued_(sheet, 2), false);
  assert.deepEqual(writes, []);

  current = '';
  assert.equal(ctx.markRegisterQueued_(sheet, 2), true);
  assert.equal(current, '등록대기');

  const registerBody = extractFunction(backend, 'registerByReqID');
  assert.match(
    registerBody,
    /if\s*\(\s*!markRegisterQueued_\(sheet,\s*triggerRow\)\s*\)\s*return;/,
    'lock timeout must not enqueue a confirmed no-replay request after the marker rejects the overwrite'
  );
});

test('락 대기 중 생긴 자동등록 marker는 legacy 큐가 락 획득 후 다시 읽고 종료한다', () => {
  const ctx = loadContext([
    'isConfirmedRegistrationNoReplayStatus_',
    'shouldSkipLegacyRegistrationAfterLock_'
  ]);
  const reqID = 'RQ-260907-001';
  const ordinary = Array(18).fill('');
  ordinary[0] = reqID;
  ordinary[14] = '등록대기';
  const confirmed = ordinary.slice();
  confirmed[14] = '⚠️ 자동등록 처리중(재실행 금지) [11111111-2222-4333-8444-555555555555]';

  assert.equal(ctx.shouldSkipLegacyRegistrationAfterLock_([ordinary], reqID, false), false);
  assert.equal(ctx.shouldSkipLegacyRegistrationAfterLock_([confirmed], reqID, false), true);
  assert.equal(ctx.shouldSkipLegacyRegistrationAfterLock_([confirmed], reqID, true), false,
    'the owning confirmed operation must be allowed to continue');

  const registerBody = extractFunction(backend, 'registerByReqID');
  const freshRead = registerBody.indexOf('const reqID = allData[triggerIdx][0]');
  const postLockGuard = registerBody.indexOf('shouldSkipLegacyRegistrationAfterLock_(');
  const firstBusinessStep = registerBody.indexOf('_processByReqID(sheet, triggerRow)');
  assert.ok(freshRead >= 0 && postLockGuard > freshRead && postLockGuard < firstBusinessStep,
    'the guard must run on fresh post-lock sheet data before any registration business write');
});

test('자동등록 후처리 실패도 operation id를 유지하고 legacy 큐에서 종료한다', () => {
  const ctx = loadContext([
    'isConfirmedRegistrationNoReplayStatus_',
    'handleRegistrationLedgerFailure_'
  ]);
  const operationId = '11111111-2222-4333-8444-555555555555';
  const row = Array(18).fill('');
  row[0] = 'RQ-260907-001';
  const writes = new Map();
  const sheet = {
    getRange: (rowNumber, column) => ({
      setValue(value) { writes.set(`${rowNumber}:${column}`, value); return this; },
      setBackground() { return this; }
    })
  };
  ctx.readRegisteredTradeCorrectionState_ = () => ({ tradeId: '260907-001' });

  assert.throws(
    () => ctx.handleRegistrationLedgerFailure_(
      sheet,
      [row],
      'RQ-260907-001',
      '260907-001',
      new Error('synthetic ledger failure'),
      { noAutomaticReplay: true, confirmedReservationOperationId: operationId }
    ),
    /automatic|trade|registered|등록/i
  );
  const terminal = writes.get('2:15');
  assert.match(terminal, new RegExp(operationId));
  assert.equal(ctx.isConfirmedRegistrationNoReplayStatus_(terminal), true);
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
