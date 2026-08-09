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

test('one-shot 핸들러 목록에 반복 트리거가 섞이지 않았다', () => {
  const list = section(read('Code.js'), 'var ONE_SHOT_TRIGGER_HANDLERS_', '];');
  for (const recurring of ['flushDirtyToSupabase', 'warmDashboardCache', 'onEditInstallable',
    'onChangeInstallable', 'autoClearRequests', 'checkGuideAlimtalk', 'onEditSupabaseMark',
    'syncTemplateMasterFromSetMaster', 'runGrowthAutopilotWeekly']) {
    assert.ok(!list.includes(`'${recurring}'`),
      `반복 트리거 ${recurring}가 one-shot 정리 대상에 들어가면 시스템 복구 경로가 지워진다`);
  }
});
