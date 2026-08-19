const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const endwork = read('scripts/endwork.sh');
const synccheck = read('scripts/synccheck.sh');
const startwork = read('scripts/startwork.sh');
const agents = read('AGENTS.md');
const claude = read('CLAUDE.md');

assert.match(
  endwork,
  /if \[\[ "\$BRANCH" != "main" \]\]/,
  'endwork must refuse GAS deploys outside main'
);

assert.match(
  endwork,
  /finishbranch\.sh/,
  'endwork must point feature branches to the non-deploy finish script'
);

assert.doesNotMatch(
  synccheck,
  /clasp clone/,
  'synccheck must not rely on clasp clone into an empty temp dir'
);

assert.match(
  synccheck,
  /clasp pull/,
  'synccheck must use clasp pull with copied .clasp.json'
);

assert.doesNotMatch(
  startwork,
  /clasp clone/,
  'startwork must not rely on clasp clone into an empty temp dir'
);

assert.match(
  startwork,
  /clasp pull/,
  'startwork must use clasp pull with copied .clasp.json'
);

['scripts/newtask.sh', 'scripts/finishbranch.sh', 'scripts/integrate.sh'].forEach((file) => {
  assert.ok(fs.existsSync(path.join(root, file)), `${file} must exist`);
});

const finishbranch = read('scripts/finishbranch.sh');
assert.doesNotMatch(
  finishbranch,
  /clasp (push|deploy)/,
  'finishbranch must never touch GAS'
);
assert.match(
  finishbranch,
  /git push -u origin "\$BRANCH"/,
  'finishbranch must push the feature branch with upstream'
);

const integrate = read('scripts/integrate.sh');
assert.match(
  integrate,
  /git merge --no-ff --no-commit/,
  'integrate must leave the merge uncommitted so endwork deploys the merged tree before committing'
);
assert.match(
  integrate,
  /scripts\/endwork\.sh/,
  'integrate must delegate the final GAS deploy and git push to endwork'
);

assert.match(
  agents,
  /멀티 세션 작업 원칙/,
  'AGENTS must document the multi-session workflow'
);
assert.match(
  agents,
  /feature 브랜치에서는 GAS 배포 금지/,
  'AGENTS must explicitly ban GAS deploys from feature branches'
);

[agents, claude].forEach((instructions, index) => {
  const name = index === 0 ? 'AGENTS.md' : 'CLAUDE.md';
  assert.match(
    instructions,
    /AI 자동 실행 — 사용자는 명령어를 외우지 않는다/,
    `${name} must tell agents that the user never memorizes workflow commands`
  );
  assert.match(
    instructions,
    /첫 변경 작업 전에 반드시 `\.\/scripts\/startwork\.sh`를 자동 실행/,
    `${name} must auto-run startwork before the first mutation`
  );
  assert.match(
    instructions,
    /`main`에서는[\s\S]*`\.\/scripts\/endwork\.sh/,
    `${name} must auto-run endwork when main work is complete`
  );
  assert.match(
    instructions,
    /feature 브랜치에서는 `\.\/scripts\/finishbranch\.sh/,
    `${name} must finish feature branches without deploying GAS`
  );
  assert.match(
    instructions,
    /사용자에게 `이 명령어를 직접 치세요`라고 떠넘기지 않는다/,
    `${name} must not delegate routine workflow commands back to the user`
  );
});

console.log('workflow guard static checks passed');
