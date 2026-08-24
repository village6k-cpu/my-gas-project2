import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeLaunchAgentPlist, runLaunchAgentProbe, safeLabel, MINIMAL_ENVIRONMENT } from './launch-agent-probe.mjs';

const runId = '0123456789abcdef';
const confirmsRemoval = calls => async args => {
  calls.push(args);
  if (args[0] === 'print') throw Object.assign(new Error('not found'), { code: 113 });
};

test('plist is one-shot and contains the immutable runner contract paths', () => {
  const plist = makeLaunchAgentPlist({ label: 'com.village.gate0.01234567-89ab-cdef-0123-456789abcdef', runnerPath: '/repo/codex-probe-runner.mjs', codexPath: '/opt/codex', outputPath: '/tmp/result.json', runId, workingDirectory: '/repo', allowTestOverrides: true });
  assert.match(plist, /RunAtLoad/); assert.match(plist, /KeepAlive/); assert.match(plist, /--probe-id/); assert.match(plist, /launchagent_cua/); assert.match(plist, /<key>WorkingDirectory<\/key><string>\/repo<\/string>/); assert.match(plist, new RegExp(`<key>LANG<\\/key><string>${MINIMAL_ENVIRONMENT.LANG}<\\/string><key>PATH<\\/key><string>${MINIMAL_ENVIRONMENT.PATH.replaceAll('/', '\\/')}<\\/string>`)); assert.doesNotMatch(plist, /HOME|USER|SHELL/); assert.throws(() => makeLaunchAgentPlist({ label: 'com.other.label', runnerPath: '/x', codexPath: '/y', outputPath: '/z', runId }));
  assert.equal(safeLabel('com.village.gate0.01234567-89ab-cdef-0123-456789abcdef'), true); assert.equal(safeLabel('com.village.gate0.other'), false);
});

test('launch agent timeout boots out its own label and removes only its temporary directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gate0-test-')); const calls = [];
  const result = await runLaunchAgentProbe({ codexPath: '/opt/codex', runnerPath: '/repo/codex-probe-runner.mjs', allowTestOverrides: true, tempRoot: root, timeoutMs: 2, launchctl: confirmsRemoval(calls), now: () => '2026-08-24T00:00:00.000Z', runId });
  assert.equal(result.result, 'BLOCKED'); assert.equal(calls.length, 3); assert.equal(calls[0][0], 'bootstrap'); assert.deepEqual(calls[1].slice(0, 1), ['bootout']); assert.equal(calls[1].length, 2); assert.match(calls[1][1], /^gui\/\d+\/com\.village\.gate0\.[a-f0-9-]+$/); assert.deepEqual(calls[2], ['print', calls[1][1]]); assert.deepEqual(await readdir(root), []);
  await rm(root, { recursive: true, force: true });
});

test('bootstrap error still boots out exact label and cleanup is idempotent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gate0-test-')); const calls = [];
  const result = await runLaunchAgentProbe({ codexPath: '/opt/codex', runnerPath: '/repo/runner.mjs', allowTestOverrides: true, tempRoot: root, launchctl: async args => { calls.push(args); if (args[0] === 'bootstrap') throw new Error('partial'); if (args[0] === 'print') throw Object.assign(new Error('not found'), { code: 113 }); }, runId });
  assert.equal(result.result, 'BLOCKED'); assert.equal(calls.length, 3); assert.equal(calls[1][0], 'bootout'); assert.deepEqual(await readdir(root), []);
  await rm(root, { recursive: true, force: true });
});

test('successful result is cleaned after return', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gate0-test-')); const calls = [];
  const result = await runLaunchAgentProbe({ codexPath: '/opt/codex', runnerPath: '/repo/runner.mjs', allowTestOverrides: true, tempRoot: root, timeoutMs: 20, launchctl: confirmsRemoval(calls), resultWriter: async output => writeFile(output, JSON.stringify({ schemaVersion: 'gate0-probe/v1', probeId: 'launchagent_cua', result: 'PASS', checkedAt: '2026-08-24T00:00:00.000Z', runId, evidence: { status: 'available', criterion: 'chrome_accessibility_screenshot', pointer: 'boolean_only' } })), runId });
  assert.equal(result.result, 'PASS'); assert.deepEqual(calls.at(-2), ['bootout', calls.at(-1)[1]]); assert.equal(calls.at(-1)[0], 'print'); assert.deepEqual(await readdir(root), []);
  await rm(root, { recursive: true, force: true });
});

test('bootout failure overrides an otherwise PASS result and retains only private recovery files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gate0-test-')); const calls = [];
  const result = await runLaunchAgentProbe({ codexPath: '/opt/codex', runnerPath: '/repo/runner.mjs', allowTestOverrides: true, tempRoot: root, timeoutMs: 20, launchctl: async args => { calls.push(args); if (args[0] === 'bootout') throw Object.assign(new Error('failed'), { code: 5 }); }, resultWriter: async output => writeFile(output, JSON.stringify({ schemaVersion: 'gate0-probe/v1', probeId: 'launchagent_cua', result: 'PASS', checkedAt: '2026-08-24T00:00:00.000Z', runId, evidence: { status: 'available', criterion: 'chrome_accessibility_screenshot', pointer: 'boolean_only' } })), runId });
  assert.equal(result.result, 'BLOCKED'); assert.equal(result.errorClass, 'cleanup_incomplete'); assert.equal(result.evidence.pointer, 'cleanup_mapping_retained');
  const [ownedDir] = await readdir(root); const files = (await readdir(join(root, ownedDir))).sort();
  assert.deepEqual(files, ['probe.plist', 'recovery.json']);
  const mapping = JSON.parse(await readFile(join(root, ownedDir, 'recovery.json'), 'utf8'));
  assert.equal(mapping.ownerRunId, runId); assert.equal(mapping.label, mapping.serviceTarget.split('/').at(-1)); assert.deepEqual(calls.at(-1), ['bootout', mapping.serviceTarget]); assert.equal(calls.at(-1).length, 2);
  await rm(root, { recursive: true, force: true });
});

test('cleanup remains idempotent across repeated probes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gate0-test-')); const launchctl = async () => {};
  const confirming = async args => { if (args[0] === 'print') throw Object.assign(new Error('not found'), { code: 113 }); return launchctl(args); };
  await runLaunchAgentProbe({ codexPath: '/opt/codex', runnerPath: '/repo/runner.mjs', allowTestOverrides: true, tempRoot: root, timeoutMs: 1, launchctl: confirming, runId });
  await runLaunchAgentProbe({ codexPath: '/opt/codex', runnerPath: '/repo/runner.mjs', allowTestOverrides: true, tempRoot: root, timeoutMs: 1, launchctl: confirming, runId });
  assert.deepEqual(await readdir(root), []); await rm(root, { recursive: true, force: true });
});
