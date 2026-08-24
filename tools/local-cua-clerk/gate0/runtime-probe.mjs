import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { platform, release } from 'node:os';
import { makeProbe } from './probe-contract.mjs';
const defaultExec = promisify(execFile);
async function run(exec, file, args) { try { const r = await exec(file, args); return String(r.stdout ?? '').trim(); } catch (error) { return { errorClass: error.code || 'command_failed' }; } }
export async function collectRuntime({ exec = defaultExec, cwd = process.cwd(), configuredMcp = [] } = {}) { const nodePath = process.execPath; const nodeVersion = process.versions.node; const codexPath = await run(exec, 'which', ['codex']); const codexVersion = codexPath.errorClass ? codexPath : await run(exec, codexPath, ['--version']); const branch = await run(exec, 'git', ['-C', cwd, 'branch', '--show-current']); const evidence = { path: nodePath, version: nodeVersion, branch: typeof branch === 'string' ? branch : 'unknown', platform: `${platform()}-${release()}`, mcp: configuredMcp.map((item) => ({ name: String(item.name), status: String(item.status ?? 'unknown') })), capabilities: { node: true, codex: !codexPath.errorClass, commandArgsCaptured: false, environmentCaptured: false } }; if (typeof codexVersion === 'string') evidence.capabilities.codexVersionObserved = true; return makeProbe({ probeId: 'launchagent_security', result: codexPath.errorClass ? 'BLOCKED' : 'PASS', evidence, errorClass: codexPath.errorClass }); }
if (import.meta.url === `file://${process.argv[1]}`) process.stdout.write(JSON.stringify(await collectRuntime(), null, 2) + '\n');
