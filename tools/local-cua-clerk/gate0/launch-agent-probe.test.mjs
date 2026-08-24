import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeLaunchAgentPlist, runLaunchAgentProbe, safeLabel } from './launch-agent-probe.mjs';

test('plist is one-shot and contains the immutable runner contract paths', () => {
  const plist = makeLaunchAgentPlist({ label: 'com.village.gate0.01234567-89ab-cdef-0123-456789abcdef', runnerPath: '/repo/codex-probe-runner.mjs', codexPath: '/opt/codex', outputPath: '/tmp/result.json', allowTestOverrides: true });
  assert.match(plist, /RunAtLoad/); assert.match(plist, /KeepAlive/); assert.match(plist, /--probe-id/); assert.match(plist, /launchagent_cua/); assert.throws(() => makeLaunchAgentPlist({ label: 'com.other.label', runnerPath: '/x', codexPath: '/y', outputPath: '/z' }));
  assert.equal(safeLabel('com.village.gate0.01234567-89ab-cdef-0123-456789abcdef'), true); assert.equal(safeLabel('com.village.gate0.other'), false);
});

test('launch agent timeout boots out its own label and removes only its temporary directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gate0-test-')); const calls = [];
  const result = await runLaunchAgentProbe({ codexPath: '/opt/codex', runnerPath: '/repo/codex-probe-runner.mjs', allowTestOverrides: true, tempRoot: root, timeoutMs: 2, launchctl: async args => { calls.push(args); }, now: () => '2026-08-24T00:00:00.000Z', runId: '0123456789abcdef' });
  assert.equal(result.result, 'BLOCKED'); assert.equal(calls.length, 2); assert.equal(calls[0][0], 'bootstrap'); assert.equal(calls[1][0], 'bootout'); assert.match(calls[1][2], /^gui\/\d+\/com\.village\.gate0\.[a-f0-9-]+$/); assert.deepEqual(await readdir(root), []);
});

test('bootstrap error still boots out exact label and cleanup is idempotent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gate0-test-')); const calls = [];
  const result = await runLaunchAgentProbe({ codexPath: '/opt/codex', runnerPath: '/repo/runner.mjs', allowTestOverrides: true, tempRoot: root, launchctl: async args => { calls.push(args); if (args[0] === 'bootstrap') throw new Error('partial'); }, runId: '0123456789abcdef' });
  assert.equal(result.result, 'BLOCKED'); assert.equal(calls.length, 2); assert.equal(calls[1][0], 'bootout'); assert.deepEqual(await readdir(root), []);
});

test('successful result is cleaned after return', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gate0-test-')); const calls = [];
  const result = await runLaunchAgentProbe({ codexPath: '/opt/codex', runnerPath: '/repo/runner.mjs', allowTestOverrides: true, tempRoot: root, timeoutMs: 20, launchctl: async args => { calls.push(args); }, resultWriter: async output => writeFile(output, JSON.stringify({ schemaVersion: 'gate0-probe/v1', probeId: 'launchagent_cua', result: 'PASS', checkedAt: '2026-08-24T00:00:00.000Z', runId: '0123456789abcdef', evidence: { status: 'available', criterion: 'chrome_accessibility_screenshot', pointer: 'boolean_only' } })), runId: '0123456789abcdef' });
  assert.equal(result.result, 'PASS'); assert.equal(calls.at(-1)[0], 'bootout'); assert.deepEqual(await readdir(root), []);
});

test('cleanup remains idempotent across repeated probes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gate0-test-')); const launchctl = async () => {};
  await runLaunchAgentProbe({ codexPath: '/opt/codex', runnerPath: '/repo/runner.mjs', allowTestOverrides: true, tempRoot: root, timeoutMs: 1, launchctl, runId: '0123456789abcdef' });
  await runLaunchAgentProbe({ codexPath: '/opt/codex', runnerPath: '/repo/runner.mjs', allowTestOverrides: true, tempRoot: root, timeoutMs: 1, launchctl, runId: '0123456789abcdef' });
  assert.deepEqual(await readdir(root), []);
});
