const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

function section(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `${start} section not found`);
  return source.slice(from, to);
}

// GAS 실사고 재현(2026-08): 스크립트당 트리거 20개 상한.
// regenPendingContracts 좀비 10개 + watchdog 4개가 쿼터를 채워 계약서 재생성 큐 28건이
// 최대 31시간 멈췄고, 앱 카드가 "계약서 갱신중"에서 영구히 못 빠져나왔다.
const TRIGGER_QUOTA = 20;

function makeScriptApp(quota = TRIGGER_QUOTA) {
  let seq = 0;
  const triggers = [];
  return {
    triggers,
    api: {
      newTrigger(handler) {
        return {
          timeBased() { return this; },
          after() { return this; },
          create() {
            if (triggers.length >= quota) {
              throw new Error('스크립트에 트리거가 너무 많습니다. 스크립트에서 기존 트리거를 삭제해야 새로 추가할 수 있습니다.');
            }
            const t = { handler, id: `t${++seq}` };
            triggers.push(t);
            return { getUniqueId: () => t.id, getHandlerFunction: () => t.handler };
          },
        };
      },
      getProjectTriggers() {
        return triggers.map((t) => ({
          getUniqueId: () => t.id,
          getHandlerFunction: () => t.handler,
        }));
      },
      deleteTrigger(ref) {
        const id = ref.getUniqueId();
        const i = triggers.findIndex((t) => t.id === id);
        if (i >= 0) triggers.splice(i, 1);
      },
    },
  };
}

function loadTriggerPrimitives(scriptApp) {
  const source = section(
    read('Code.js'),
    'var ONE_SHOT_TRIGGER_HANDLERS_',
    '\nfunction scheduleContractRegenUnderLock_',
  );
  const logs = [];
  const context = {
    ScriptApp: scriptApp.api,
    Logger: { log: (m) => logs.push(String(m)) },
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  context.__logs = logs;
  return context;
}

function countOf(scriptApp, handler) {
  return scriptApp.triggers.filter((t) => t.handler === handler).length;
}

test('one-shot 트리거 교체는 반복 호출해도 개수가 1로 수렴한다', () => {
  const scriptApp = makeScriptApp();
  const ctx = loadTriggerPrimitives(scriptApp);

  for (let i = 0; i < 50; i += 1) {
    ctx.replaceOneShotTrigger_('regenPendingContracts', 3000);
  }

  assert.equal(countOf(scriptApp, 'regenPendingContracts'), 1,
    '잠금 실패마다 트리거가 1씩 늘면 20개 쿼터를 먹고 모든 큐가 죽는다');
  assert.equal(scriptApp.triggers.length, 1);
});

test('교체 도중에도 실행 경로가 0개가 되는 창이 없다', () => {
  const scriptApp = makeScriptApp();
  const ctx = loadTriggerPrimitives(scriptApp);
  ctx.replaceOneShotTrigger_('regenPendingContracts', 3000);

  // create 직전 시점의 개수를 관찰한다 — 항상 1개 이상 남아 있어야 한다.
  const observed = [];
  const realNewTrigger = scriptApp.api.newTrigger;
  scriptApp.api.newTrigger = function (handler) {
    observed.push(scriptApp.triggers.length);
    return realNewTrigger.call(this, handler);
  };
  ctx.replaceOneShotTrigger_('regenPendingContracts', 3000);

  assert.deepEqual(observed, [1], 'create 시점에 기존 트리거가 남아 있어야 고아 큐가 안 생긴다');
  assert.equal(countOf(scriptApp, 'regenPendingContracts'), 1);
});

test('쿼터가 이미 좀비로 가득 차 있어도 스스로 회복한다', () => {
  const scriptApp = makeScriptApp();
  const ctx = loadTriggerPrimitives(scriptApp);

  // 실제 사고 상태 재현: regen 좀비 10 + watchdog 4 + 반복 트리거 6 = 20개(쿼터 소진).
  for (let i = 0; i < 10; i += 1) scriptApp.api.newTrigger('regenPendingContracts').create();
  for (let i = 0; i < 4; i += 1) scriptApp.api.newTrigger('regenPendingContractsWatchdog').create();
  for (const recurring of ['flushDirtyToSupabase', 'warmDashboardCache', 'onEditInstallable',
    'onChangeInstallable', 'autoClearRequests', 'checkGuideAlimtalk']) {
    scriptApp.api.newTrigger(recurring).create();
  }
  assert.equal(scriptApp.triggers.length, TRIGGER_QUOTA, '사고 당시 상태 = 쿼터 정확히 소진');
  assert.throws(() => scriptApp.api.newTrigger('regenPendingContracts').create(), /너무 많습니다/);

  const created = ctx.replaceOneShotTrigger_('regenPendingContracts', 3000);

  assert.ok(created, '쿼터 소진 상태에서도 트리거를 확보해야 큐가 다시 돈다');
  assert.equal(countOf(scriptApp, 'regenPendingContracts'), 1);
  assert.ok(scriptApp.triggers.length < TRIGGER_QUOTA, '쿼터에 여유가 생겨야 다른 큐도 살아난다');
  assert.equal(countOf(scriptApp, 'flushDirtyToSupabase'), 1, '매분 도는 복구 트리거는 살아 있어야 한다');
});

test('남의 핸들러 좀비가 쿼터를 먹었어도 내 큐가 되살아난다', () => {
  const scriptApp = makeScriptApp();
  const ctx = loadTriggerPrimitives(scriptApp);

  // regen은 트리거가 0개인데 다른 one-shot 핸들러 좀비가 쿼터를 다 먹은 상황.
  // 자기 핸들러만 정리해서는 절대 못 빠져나온다 → 전체 one-shot 프루닝이 필요하다.
  for (let i = 0; i < 14; i += 1) scriptApp.api.newTrigger('syncTemplateMasterDebounced').create();
  for (const recurring of ['flushDirtyToSupabase', 'warmDashboardCache', 'onEditInstallable',
    'onChangeInstallable', 'autoClearRequests', 'checkGuideAlimtalk']) {
    scriptApp.api.newTrigger(recurring).create();
  }
  assert.equal(scriptApp.triggers.length, TRIGGER_QUOTA);
  assert.equal(countOf(scriptApp, 'regenPendingContracts'), 0);

  const created = ctx.replaceOneShotTrigger_('regenPendingContracts', 3000);

  assert.ok(created);
  assert.equal(countOf(scriptApp, 'regenPendingContracts'), 1);
  assert.equal(countOf(scriptApp, 'syncTemplateMasterDebounced'), 1, '남의 좀비도 1개로 정리해야 자리가 난다');
  assert.equal(countOf(scriptApp, 'flushDirtyToSupabase'), 1, '반복 트리거는 건드리지 않는다');
  assert.match(ctx.__logs.join('\n'), /쿼터 소진/, '자가복구는 로그로 남겨 원인 추적이 가능해야 한다');
});

test('반복 트리거는 절대 정리 대상이 아니다', () => {
  const scriptApp = makeScriptApp();
  const ctx = loadTriggerPrimitives(scriptApp);
  for (let i = 0; i < 3; i += 1) scriptApp.api.newTrigger('flushDirtyToSupabase').create();
  for (let i = 0; i < 3; i += 1) scriptApp.api.newTrigger('onEditInstallable').create();

  ctx.pruneAllOneShotTriggers_();

  assert.equal(countOf(scriptApp, 'flushDirtyToSupabase'), 3,
    '매분 도는 복구 트리거를 지우면 큐를 깨울 마지막 수단이 사라진다');
  assert.equal(countOf(scriptApp, 'onEditInstallable'), 3);
});

test('쿼터 외 오류는 삼키지 않고 그대로 던진다', () => {
  const scriptApp = makeScriptApp();
  const ctx = loadTriggerPrimitives(scriptApp);
  scriptApp.api.newTrigger = () => ({
    timeBased() { return this; },
    after() { return this; },
    create() { throw new Error('권한이 없습니다'); },
  });

  assert.throws(() => ctx.replaceOneShotTrigger_('regenPendingContracts', 3000), /권한이 없습니다/);
});

test('모든 one-shot 스케줄러가 공용 프리미티브를 쓴다 (직접 newTrigger 금지)', () => {
  const sources = {
    'Code.js': read('Code.js'),
    'checkAvailability.js': read('checkAvailability.js'),
  };
  // 이 핸들러들은 발화 뒤에도 목록에 남으므로 직접 create 하면 개수가 단조증가한다.
  const guarded = [
    'regenPendingContracts',
    'regenPendingContractsWatchdog',
    'syncTemplateMasterDebounced',
    'processCancelledTradeCleanup',
    'flushDashboardStructureProjectionQueue_',
    '_runPendingRegister',
    '_runPendingScheduleFormat',
  ];

  for (const [file, source] of Object.entries(sources)) {
    for (const line of source.split('\n')) {
      if (!line.includes('ScriptApp.newTrigger')) continue;
      for (const handler of guarded) {
        const named = line.includes(`'${handler}'`) || line.includes(`"${handler}"`) ||
          (handler === 'regenPendingContractsWatchdog' && line.includes('CONTRACT_REGEN_WATCHDOG_HANDLER_')) ||
          (handler === 'processCancelledTradeCleanup' && line.includes('CANCEL_CLEANUP_HANDLER_'));
        assert.ok(!named,
          `${file}: one-shot 트리거를 직접 만들면 안 된다(replaceOneShotTrigger_ 사용): ${line.trim()}`);
      }
    }
  }
});

// 두 번째 근본 원인: 영구 조건을 일시 오류로 취급해 큐가 절대 비지 않던 문제.
// 260809-001은 계약마스터에서 완전삭제된 거래인데 30분마다 영원히 재시도됐다.
test('계약마스터에 없는 거래는 재시도를 끊고 큐에서 종결한다', () => {
  const code = read('Code.js');
  const finish = section(code, 'function finishPendingContractRegen_', '\n/**');
  assert.match(finish, /outcome\.permanentlyGone[\s\S]{0,200}deleteProperty\(claim\.editKey\)/,
    '영구 조건은 editTS를 지워 큐를 종결해야 한다 — degraded(30분)조차 영구 조건엔 "영원히"와 같다');

  const regen = section(code, 'function regenPendingContracts()', '\n// ─────');
  assert.match(regen, /계약마스터에서 찾을 수 없습니다\/\.test\(regenErrorMessage\)/);
  assert.match(regen, /isTradeMissingFromContractMaster_\(ss, 거래ID\)/,
    '에러 문자열만 믿지 말고 실제 부재를 한 번 더 확인해야 한다');
  assert.match(regen, /permanentlyGone: regenPermanentlyGone/);
});

test('계약마스터 부재 확인은 불확실하면 재시도를 유지한다', () => {
  const code = read('Code.js');
  const lookup = section(code, 'function isTradeMissingFromContractMaster_', '\n/**');
  assert.match(lookup, /catch \(lookupErr\)[\s\S]{0,220}return false;/,
    '조회 실패를 "없음"으로 오판하면 정상 거래의 계약서 갱신을 영구히 잃는다');
  assert.match(lookup, /if \(!tid\) return false;/);
  assert.match(lookup, /if \(!cm\) return false;/);
  assert.match(lookup, /if \(lastRow < 2\) return false;/);
});

// 세 번째 근본 원인: 큐 키 삭제 전에 dirty를 찍어 매분 도는 flush가 pending=true를
// 밀어넣고, 이후 마킹이 없어 앱 카드가 영구히 "계약서 갱신중"으로 굳던 경쟁 상태
// (race condition = 두 작업이 동시에 돌며 서로를 덮는 것). 6월 건까지 13개 관측.
test('Supabase 전파는 큐 키가 지워진 뒤에만 예약한다', () => {
  const code = read('Code.js');
  const regen = section(code, 'function regenPendingContracts()', '\n// ─────');

  const finishAt = regen.indexOf('finishPendingContractRegen_(props, claim');
  const markAt = regen.indexOf('supaMarkTradeDirty_(거래ID)');
  assert.ok(finishAt >= 0 && markAt > finishAt,
    'dirty 마킹이 큐 키 삭제보다 먼저면 flushDirtyToSupabase가 그 틈에 pending=true를 굳힌다');

  assert.match(regen, /finishResult && \(finishResult\.success \|\| finishResult\.permanentlyGone\)[\s\S]{0,120}supaMarkTradeDirty_/,
    '큐에서 실제로 내려간 경우에만 전파해야 한다 — 재시도 중인 건은 pending이 맞다');

  // 주석 언급은 허용하고 실제 호출만 잡는다.
  const successBlock = regen.slice(regen.indexOf('regenSucceeded = true;'), finishAt);
  const stripComments = (s) => s.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.ok(!/supaMarkTradeDirty_\(/.test(stripComments(successBlock)),
    '성공 블록(큐 키가 아직 살아 있는 시점)에서 전파를 찍으면 안 된다');
});

test('직접 재생성 경로는 큐 키를 지운 뒤 전파한다', () => {
  const gen = read('generatecontract.js');
  const clear = section(gen, 'function clearDirectContractRegenPending_', '\n}');
  const deleteAt = clear.indexOf("deleteProperty('contractEditTS_'");
  const markAt = clear.indexOf('supaMarkTradeDirty_');
  assert.ok(deleteAt >= 0 && markAt > deleteAt,
    'regenPendingContracts와 같은 순서 불변식을 지켜야 한다');
});

// 네 번째 원인(경합의 진원지): 전역 ScriptLock을 쥔 채 ScriptApp 트리거 I/O(수 초)를
// 하면 onEdit·대시보드 변경·Supabase flush가 waitLock(10초)에서 줄줄이 실패한다.
// 그 잠금 실패가 트리거 누수 경로를 때려 20개 쿼터 사고로 번졌다.
test('...UnderLock_ 함수 안에서는 ScriptApp을 건드리지 않는다', () => {
  const code = read('Code.js');
  const offenders = [];
  const lines = code.split('\n');
  let current = null;
  let depth = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const start = line.match(/^function (\w*UnderLock_)\(/);
    if (start) { current = start[1]; depth = 0; }
    if (!current) continue;
    depth += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
    if (/ScriptApp\./.test(line)) offenders.push(`${current} (Code.js:${i + 1}): ${line.trim()}`);
    if (depth <= 0 && line.trim() === '}') current = null;
  }
  assert.deepEqual(offenders, [],
    '잠금 구간에서 트리거 I/O를 하면 전역 잠금이 수 초간 묶여 다른 실행이 waitLock에서 실패한다');
});

test('watchdog은 잠금 안에서 계획만 세우고 잠금 밖에서 실행한다', () => {
  const code = read('Code.js');
  const plan = section(code, 'function planContractRegenWatchdogUnderLock_', '\n/**');
  assert.doesNotMatch(plan, /ScriptApp\./, '계획 단계는 props만 만져야 한다');
  assert.match(plan, /props\.setProperty\(CONTRACT_REGEN_WATCHDOG_PROP_/);

  // claim 경로: 잠금 해제 뒤에 commit이 오고, 그 commit은 호출자가 Drive 작업을
  // 시작하기 전(= 함수 return 전)에 끝나야 한다.
  const claim = section(code, 'function claimPendingContractRegen_', '\n/**');
  assert.match(claim, /watchdogPlan = planContractRegenWatchdogUnderLock_/);
  const releaseAt = claim.indexOf('lock.releaseLock()');
  const commitAt = claim.indexOf('commitContractRegenWatchdogPlan_');
  assert.ok(releaseAt >= 0 && commitAt > releaseAt,
    '트리거 I/O는 releaseLock 뒤에 와야 한다');
  assert.ok(claim.slice(claim.indexOf('} finally {')).includes('commitContractRegenWatchdogPlan_'),
    'commit은 finally 안이라 어느 return 경로로 나가도 실행된다');
});

test('취소 정리 트리거 헬퍼는 이름이 잠금 상태를 정직하게 말한다', () => {
  const code = read('Code.js');
  // 이름이 UnderLock_인데 실제로는 잠금 밖에서 호출되면, 다음 사람이 잠금 안에서
  // 부르도록 유도한다 — 이번 사고가 정확히 그 함정에서 나왔다.
  assert.ok(!/function scheduleCancelledTradeCleanupTriggerUnderLock_/.test(code));
  assert.ok(!/function clearCancelledTradeCleanupTriggersUnderLock_/.test(code));
  assert.match(code, /function scheduleCancelledTradeCleanupTriggerOutsideLock_/);
  assert.match(code, /function clearCancelledTradeCleanupTriggersOutsideLock_/);

  // 호출부는 전부 releaseLock 뒤(finally)여야 한다.
  for (const fn of ['claimNextCancelledTradeCleanup_', 'processCancelledTradeCleanup']) {
    const at = code.indexOf(`function ${fn}`);
    if (at < 0) continue;
    const body = code.slice(at, code.indexOf('\nfunction ', at + 10));
    const releaseAt = body.indexOf('lock.releaseLock()');
    const ensureAt = body.indexOf('ensureCancelledTradeCleanupTrigger_');
    if (ensureAt >= 0) {
      assert.ok(releaseAt >= 0 && ensureAt > releaseAt, `${fn}: 트리거 예약이 잠금 안에 있으면 안 된다`);
    }
  }
});

test('one-shot 핸들러 목록에 반복 트리거가 섞이지 않았다', () => {
  const list = section(read('Code.js'), 'var ONE_SHOT_TRIGGER_HANDLERS_', '];');
  for (const required of ['_runPendingRegister', '_runPendingScheduleFormat']) {
    assert.ok(list.includes(`'${required}'`), `${required} must participate in shared one-shot quota recovery`);
  }
  for (const recurring of ['flushDirtyToSupabase', 'warmDashboardCache', 'onEditInstallable',
    'onChangeInstallable', 'autoClearRequests', 'checkGuideAlimtalk', 'onEditSupabaseMark',
    'syncTemplateMasterFromSetMaster', 'runGrowthAutopilotWeekly']) {
    assert.ok(!list.includes(`'${recurring}'`),
      `반복 트리거 ${recurring}가 one-shot 정리 대상에 들어가면 시스템 복구 경로가 지워진다`);
  }
});
