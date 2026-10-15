const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const script = fs.readFileSync(path.resolve(__dirname, '../scripts/endwork.sh'), 'utf8');

test('endwork compares GAS snapshots through repo-relative paths on Windows Git Bash', () => {
  assert.match(script, /TMP_GAS="\$\(mktemp -d "\$ROOT\/\.git\/gas-endwork-remote\.XXXXXX"\)"/);
  assert.match(script, /TMP_HEAD="\$\(mktemp -d "\$ROOT\/\.git\/gas-endwork-head\.XXXXXX"\)"/);
  assert.match(script, /TMP_GAS_REL="\$\{TMP_GAS#\$ROOT\/\}"/);
  assert.match(script, /TMP_HEAD_REL="\$\{TMP_HEAD#\$ROOT\/\}"/);
  assert.match(script, /git diff --no-index --quiet --ignore-cr-at-eol -- "\$TMP_GAS_REL\/\$f" "\$TMP_HEAD_REL\/\$f"/);
  assert.doesNotMatch(script, /mktemp -d \/tmp\/gas-endwork-/);
});
