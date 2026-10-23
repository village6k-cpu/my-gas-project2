import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Execute the actual listen callback without importing operational clients or opening a socket.
const source = fs.readFileSync(new URL('./server.mjs', import.meta.url), 'utf8');
const marker = "if (process.env.KAKAO_DOM_BRIDGE_NO_LISTEN !== '1') {";
assert.equal(source.split(marker).length, 2, 'unique startup boundary');
const startup = source.slice(source.indexOf(marker));
const healthSource = source.slice(source.indexOf('export function buildHealthConfig('), source.indexOf('\n}\n', source.indexOf('export function buildHealthConfig(')) + 3).replace('export ', '');

async function boot(transport, { noListen = false, enabled = true } = {}) {
  const calls = [], timers = [], notifications = { application: 'pending', terminal: 'pending' };
  const record = name => () => { calls.push(name); };
  const timer = kind => (fn, delay) => { timers.push({ kind, fn, delay }); return { unref() {} }; };
  const context = {
    process: { env: { KAKAO_DOM_BRIDGE_NO_LISTEN: noListen ? '1' : '0' } },
    console: { info() {} },
    CONFIG: { hermesTransport: transport, port: 0, queueDir: 'unused', workerCommand: 'unused',
      supabaseRecoveryEnabled: enabled, supabaseRecoveryIntervalMs: 300000,
      slackActionPollEnabled: enabled, slackActionPollIntervalMs: 30000,
      p0SlackEscalationEnabled: enabled, p0SlackEscalationIntervalMs: 30000,
      kakaoTabCleanupEnabled: enabled, kakaoTabCleanupIntervalMs: 30000,
      workOrchestrator: { digestEnabled: enabled } },
    ensureQueueDir: record('ensure_directory'),
    server: { listen(_port, _host, callback) { calls.push('listen'); callback(); } },
    gatewayTransportEnabled: transport !== 'cli',
    getGatewayResultApplicationCoordinator() {
      calls.push('gateway_coordinator');
      return { recoverPendingApplications: async () => calls.push('apply_history'),
        recoverApplicationFailureNotifications: async () => { calls.push('application_notifications'); notifications.application = 'delivered'; return []; } };
    },
    getGatewayFailureNotificationCoordinator() { return { recover: async () => { calls.push('terminal_notifications'); notifications.terminal = 'delivered'; return []; } }; },
    getKakaoAutomationAuditCoordinator() { return { recover: async () => calls.push('audit_import') }; },
    appendNdjson: record('error_log'), nowIso: () => '2026-10-23T15:00:00Z',
    setTimeout: timer('timeout'), setInterval: timer('interval'),
    runSupabaseRecoverySweep: record('supabase_recovery'), runSlackActionPoll: record('slack_actions'),
    workOrchestratorActionPoller: { enabled },
    workOrchestratorImmediateNoticeUpdatePoller: { enabled, poll: record('notice_updates') },
    workOrchestratorP0Runtime: { enabled }, runP0SlackEscalationSweep: record('p0_notifications'),
    cleanupIdleKakaoConversationTabs: record('tab_cleanup'),
    workOrchestratorDigestRuntime: { start: async () => calls.push('digest') },
    workOrchestratorNoticeCleanupRuntime: { start: async () => calls.push('notice_cleanup') }
  };
  vm.runInNewContext(startup, context);
  // Flush the actual async recovery chain, then fire every registered background callback once.
  for (let i = 0; i < 8; i++) await Promise.resolve();
  for (const timer of timers) await timer.fn();
  return { calls, timers, notifications };
}

test('gateway_no_send startup leaves historical application/notification obligations untouched', async () => {
  const { calls, notifications } = await boot('gateway_no_send');
  assert.deepEqual(calls, ['ensure_directory', 'listen']);
  assert.deepEqual(notifications, { application: 'pending', terminal: 'pending' });
});
test('gateway_no_send does not schedule delayed or interval side effects even with all flags on', async () => {
  const { timers } = await boot('gateway_no_send');
  assert.equal(timers.length, 0);
});
test('normal gateway startup preserves application-before-notification recovery order', async () => {
  const { calls, timers } = await boot('gateway');
  for (const name of ['apply_history', 'application_notifications', 'terminal_notifications', 'audit_import', 'supabase_recovery', 'slack_actions', 'notice_updates', 'p0_notifications', 'tab_cleanup', 'digest', 'notice_cleanup']) assert.ok(calls.includes(name), name);
  assert.ok(calls.indexOf('apply_history') < calls.indexOf('application_notifications'));
  assert.ok(calls.indexOf('application_notifications') < calls.indexOf('terminal_notifications'));
  assert.ok(calls.indexOf('terminal_notifications') < calls.indexOf('audit_import'));
  assert.equal(timers.length, 10);
});
test('cli startup retains its background services without gateway recovery', async () => {
  const { calls, timers } = await boot('cli');
  assert.ok(!calls.includes('gateway_coordinator'));
  assert.ok(calls.includes('supabase_recovery'));
  assert.equal(timers.length, 10);
});
test('NO_LISTEN import mode still creates no directory, listener, or background work', async () => {
  const { calls, timers } = await boot('gateway_no_send', { noListen: true });
  assert.deepEqual(calls, []); assert.equal(timers.length, 0);
});
test('health identifies startup hold separately from runtime sending readiness', () => {
  const build = vm.runInNewContext(healthSource + '\nbuildHealthConfig');
  assert.equal(build({ hermesTransport: 'gateway_no_send' }).startupBackgroundWorkHeld, true);
  assert.equal(build({ hermesTransport: 'gateway' }).startupBackgroundWorkHeld, false);
  assert.equal(build({ hermesTransport: 'cli' }).startupBackgroundWorkHeld, false);
});