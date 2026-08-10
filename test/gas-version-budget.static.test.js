const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

// Apps Script는 프로젝트당 버전 200개만 보존하고, API/clasp로는 삭제할 수 없다
// (에디터 '프로젝트 기록'에서 수동 삭제만 가능). 변경이 없는데도 배포하면 버전만
// 태우다 한도에 걸려 GAS 배포가 전면 차단된다.
// 실제 사고(2026-08): 앱만 고친 배포까지 매번 버전을 태워 200개를 채웠고,
// clasp deploy가 실패하면서 git push·Vercel 배포까지 함께 멈춰 수정이 묶였다.

for (const script of ['scripts/endwork.sh', 'scripts/ci-deploy-gas.sh']) {
  test(`${script}: GAS 변경이 없으면 배포를 건너뛴다`, () => {
    const source = read(script);
    assert.match(source, /PUSH_OUT="\$\(clasp push -f 2>&1\)"/,
      'push 출력을 받아야 변경 여부를 판단할 수 있다');
    assert.match(source, /grep -qi "already up to date" <<<"\$PUSH_OUT"/,
      '변경 없음 신호를 읽어야 한다');

    // 스킵 분기 안에서만 deploy가 실행되어야 한다(무조건 deploy 금지).
    const deployAt = source.indexOf('clasp deploy -i');
    const guardAt = source.indexOf('already up to date');
    assert.ok(guardAt >= 0 && deployAt > guardAt,
      'clasp deploy가 가드보다 앞에 있으면 매번 버전을 태운다');
    assert.match(source.slice(guardAt, deployAt), /else/,
      'deploy는 "변경 있음" 분기에만 있어야 한다');
  });
}

test('스킵 분기가 실제로 두 방향 모두 동작한다', () => {
  const run = (pushOut) =>
    execFileSync('bash', ['-c',
      `PUSH_OUT=${JSON.stringify(pushOut)}; ` +
      'if grep -qi "already up to date" <<<"$PUSH_OUT"; then echo SKIP; else echo DEPLOY; fi',
    ]).toString().trim();

  assert.equal(run('Script is already up to date.'), 'SKIP');
  assert.equal(run('Pushed 9 files.'), 'DEPLOY');
  assert.equal(run(''), 'DEPLOY', '출력이 비면 안전하게 배포해야 한다');
});
