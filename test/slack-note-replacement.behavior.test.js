const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'apps/today-dashboard/lib/server/slackOps.ts'), 'utf8');
const ts = require(path.join(root, 'apps/today-dashboard/node_modules/typescript'));

function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);
  let depth = 0;
  let opened = false;
  for (let i = start; i < source.length; i += 1) {
    if (source[i] === '{') {
      depth += 1;
      opened = true;
    } else if (source[i] === '}') {
      depth -= 1;
      if (opened && depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated function: ${name}`);
}

const snippet = [
  'type SlackReply = { ts: string; text: string };',
  'type StoredEvent = { message_ts: string; applied_plan: unknown };',
  extractFunction('cleanText'),
  extractFunction('conciseOperationalNote'),
  extractFunction('noteBlock'),
  extractFunction('previousAppliedNoteTexts'),
  extractFunction('removePreviousAppliedNoteBlocks'),
  extractFunction('upsertNoteBlock'),
  'globalThis.upsertNoteBlock = upsertNoteBlock;',
].join('\n');
const compiled = ts.transpileModule(snippet, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
const context = {};
vm.createContext(context);
vm.runInContext(compiled, context);

const previousSummary = 'C스탠드 1개 미반납\n\n직원이 수량을 재확인 중';
const existing = `수동 메모 유지\n\n${previousSummary}\n\n다른 수동 메모 유지`;
const event = {
  message_ts: '1777777777.000100',
  applied_plan: { summary: previousSummary, actions: [] },
};
const updated = context.upsertNoteBlock(existing, event, 'C스탠드 2개 미반납으로 정정');

assert.equal(updated, '수동 메모 유지\n\n다른 수동 메모 유지\n\nC스탠드 2개 미반납으로 정정');
assert(!updated.includes('1개 미반납'));
assert(!updated.includes('직원이 수량을 재확인 중'));

const updatedFromCrLf = context.upsertNoteBlock(
  existing.replace(/\n/g, '\r\n'),
  event,
  'C스탠드 2개 미반납으로 정정',
);
assert.equal(updatedFromCrLf, updated, 'CRLF notes must be replaced exactly like LF notes');

console.log('Slack corrected-note replacement behavior passed');
