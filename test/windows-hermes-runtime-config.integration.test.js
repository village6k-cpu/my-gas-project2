const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

function topLevelSection(source, name) {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `${name}:`);
  if (start < 0) return '';
  const body = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^[^\s#][^:]*:/.test(lines[index])) break;
    body.push(lines[index]);
  }
  return body.join('\n');
}

test('active Windows Hermes keeps the Mac model budget and Slack display contract', {
  skip: process.platform !== 'win32'
}, () => {
  const configPath = path.join(
    process.env.LOCALAPPDATA || '',
    'hermes',
    'config.yaml'
  );
  assert.equal(fs.existsSync(configPath), true, 'active Hermes config must exist');
  const source = fs.readFileSync(configPath, 'utf8');
  const model = topLevelSection(source, 'model');
  const agent = topLevelSection(source, 'agent');
  const display = topLevelSection(source, 'display');

  assert.match(model, /^\s{2}default:\s*gpt-5\.6-terra\s*$/m);
  assert.match(model, /^\s{2}provider:\s*openai-codex\s*$/m);
  assert.match(agent, /^\s{2}reasoning_effort:\s*xhigh\s*$/m);
  assert.match(agent, /^\s{2}max_turns:\s*90\s*$/m);
  assert.doesNotMatch(agent, /^\s{2}service_tier:\s*fast\s*$/m);
  assert.match(display, /^\s{2}platforms:\s*$/m);
  assert.match(
    display,
    /platforms:\s*\r?\n\s{4}slack:\s*\r?\n(?:\s{6}[^\r\n]+\r?\n)*?\s{6}tool_progress:\s*false/m
  );
  assert.match(display, /platforms:[\s\S]*?slack:[\s\S]*?interim_assistant_messages:\s*false/m);
  assert.doesNotMatch(display, /^\s{2}platform_overrides:\s*$/m);
});

test('Windows gateway is pinned to the validated Mac runtime and remains cut over to Mac', {
  skip: process.platform !== 'win32'
}, () => {
  const home = path.join(process.env.LOCALAPPDATA || '', 'hermes');
  const cmd = fs.readFileSync(path.join(home, 'gateway-service', 'Hermes_Gateway.cmd'), 'utf8');
  const vbs = fs.readFileSync(path.join(home, 'gateway-service', 'Hermes_Gateway.vbs'), 'utf8');
  const runtime = String.raw`C:\Village\hermes-agent-worktrees\mac-parity-v22-71252f0`;
  assert.match(cmd, new RegExp(runtime.replace(/\\/g, '\\\\'), 'i'));
  assert.match(vbs, new RegExp(runtime.replace(/\\/g, '\\\\'), 'i'));
  assert.match(cmd, /\.windows-gateway-disabled/i);
  assert.match(vbs, /\.windows-gateway-disabled/i);
  assert.equal(fs.existsSync(path.join(home, '.windows-gateway-disabled')), true);
});
