const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const script = fs.readFileSync(path.resolve(__dirname, '../scripts/endwork.sh'), 'utf8');

test('endwork compares GAS snapshots through the common Git directory on Windows Git Bash and linked worktrees', () => {
  assert.match(script, /TMP_GAS="\$\(mktemp -d "\$GIT_COMMON_DIR\/gas-endwork-remote\.XXXXXX"\)"/);
  assert.match(script, /TMP_HEAD="\$\(mktemp -d "\$GIT_COMMON_DIR\/gas-endwork-head\.XXXXXX"\)"/);
  assert.match(script, /GIT_COMMON_DIR="\$\(git rev-parse --path-format=absolute --git-common-dir\)"/);
  assert.match(script, /TMP_GAS_REL="\$TMP_GAS"/);
  assert.match(script, /TMP_HEAD_REL="\$TMP_HEAD"/);
  assert.match(script, /git diff --no-index --quiet --ignore-cr-at-eol -- "\$TMP_GAS_REL\/\$f" "\$TMP_HEAD_REL\/\$f"/);
  assert.doesNotMatch(script, /mktemp -d \/tmp\/gas-endwork-/);
});
