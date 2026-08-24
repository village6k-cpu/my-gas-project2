import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { platform, release } from 'node:os';

export const RUNTIME_SCHEMA_VERSION = 'gate0-runtime/v1';
const defaultExec = promisify(execFile);
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const ERRORS = new Set(['command_failed', 'empty_path', 'invalid_path', 'version_failed']);

async function run(exec, file, args) {
  try { return String((await exec(file, args)).stdout ?? '').trim(); }
  catch { return undefined; }
}

function exactKeys(value, keys, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new TypeError(`invalid ${name} keys`);
}

export function validateRuntimeDiagnostics(value) {
  const top = ['schemaVersion', 'status', 'checkedAt', 'node', 'codex', 'branch', 'platform', 'mcp', 'capabilities', ...(value?.errorClass ? ['errorClass'] : [])];
  exactKeys(value, top, 'runtime diagnostics');
  if (value.schemaVersion !== RUNTIME_SCHEMA_VERSION || !['AVAILABLE', 'BLOCKED'].includes(value.status) || !ISO.test(value.checkedAt)) throw new TypeError('invalid runtime header');
  exactKeys(value.node, ['path', 'version'], 'node runtime');
  if (typeof value.node.path !== 'string' || !value.node.path.startsWith('/') || typeof value.node.version !== 'string' || !/^\d+\.\d+\.\d+/.test(value.node.version)) throw new TypeError('invalid node runtime');
  if (value.codex !== null) {
    exactKeys(value.codex, ['path', 'version'], 'codex runtime');
    if (typeof value.codex.path !== 'string' || !value.codex.path.startsWith('/') || typeof value.codex.version !== 'string' || !/^\d+\.\d+\.\d+/.test(value.codex.version)) throw new TypeError('invalid codex runtime');
  }
  if (typeof value.branch !== 'string' || !/^[A-Za-z0-9._/-]+$/.test(value.branch) || typeof value.platform !== 'string' || !/^[A-Za-z0-9._-]+$/.test(value.platform)) throw new TypeError('invalid runtime strings');
  if (!Array.isArray(value.mcp)) throw new TypeError('invalid runtime MCP list');
  for (const item of value.mcp) {
    exactKeys(item, ['name', 'status'], 'runtime MCP item');
    if (!/^[A-Za-z0-9_.:-]+$/.test(item.name) || !['available', 'unavailable', 'unknown'].includes(item.status)) throw new TypeError('invalid runtime MCP item');
  }
  exactKeys(value.capabilities, ['node', 'codex', 'commandArgsCaptured', 'environmentCaptured'], 'runtime capabilities');
  for (const flag of Object.values(value.capabilities)) if (typeof flag !== 'boolean') throw new TypeError('invalid runtime capability');
  if (value.errorClass !== undefined && !ERRORS.has(value.errorClass)) throw new TypeError('invalid runtime error class');
  if (value.status === 'AVAILABLE' && (value.errorClass !== undefined || value.codex === null || !value.capabilities.node || !value.capabilities.codex)) throw new TypeError('invalid available runtime diagnostics');
  if (value.status === 'BLOCKED' && !ERRORS.has(value.errorClass)) throw new TypeError('blocked runtime requires error class');
  return Object.freeze(value);
}

export function serializeRuntimeDiagnostics(value) {
  return JSON.stringify(validateRuntimeDiagnostics(value), null, 2) + '\n';
}

export async function collectRuntime({ exec = defaultExec, cwd = process.cwd(), configuredMcp = [], now = () => new Date().toISOString() } = {}) {
  const node = { path: process.execPath, version: process.versions.node };
  const rawPath = await run(exec, 'which', ['codex']);
  let errorClass;
  if (!rawPath) errorClass = 'empty_path';
  else if (!rawPath.startsWith('/')) errorClass = 'invalid_path';
  let codex = null;
  if (!errorClass) {
    const version = await run(exec, rawPath, ['--version']);
    const match = typeof version === 'string' && version.match(/^codex(?:-cli)?\s+(\d+\.\d+\.\d+)/);
    if (!match) errorClass = 'version_failed';
    else codex = { path: rawPath, version: match[1] };
  }
  const branchValue = await run(exec, 'git', ['-C', cwd, 'branch', '--show-current']);
  if (!branchValue) errorClass ??= 'command_failed';
  const value = {
    schemaVersion: RUNTIME_SCHEMA_VERSION,
    status: errorClass ? 'BLOCKED' : 'AVAILABLE',
    checkedAt: now(),
    node,
    codex,
    branch: branchValue || 'unknown',
    platform: `${platform()}-${release()}`,
    mcp: configuredMcp.map(item => ({ name: String(item.name), status: String(item.status ?? 'unknown') })),
    capabilities: { node: true, codex: Boolean(codex), commandArgsCaptured: false, environmentCaptured: false },
    ...(errorClass ? { errorClass } : {}),
  };
  return validateRuntimeDiagnostics(value);
}

if (import.meta.url === `file://${process.argv[1]}`) process.stdout.write(serializeRuntimeDiagnostics(await collectRuntime()));
