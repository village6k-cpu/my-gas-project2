const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

['dashboard.html', 'docs/dashboard.html'].forEach((file) => {
  const html = read(file);

  assert.match(
    html,
    /var RETURN_STATUS_OPTIONS\s*=\s*\['',\s*'확인필요',\s*'파손',\s*'분실',\s*'미반납',\s*'반납완료'\]/,
    `${file} return status dropdown must not include 정상`
  );

  assert.doesNotMatch(
    html,
    /var RETURN_STATUS_OPTIONS\s*=\s*\[[^\]]*'정상'[^\]]*\]/,
    `${file} must remove 정상 from RETURN_STATUS_OPTIONS`
  );

  assert.match(
    html,
    /function normalizeReturnStatusForSelect\(current\)/,
    `${file} must normalize legacy 정상 values before rendering`
  );

  assert.match(
    html,
    /if \(current === '정상'\) return '반납완료';/,
    `${file} must display legacy 정상 rows as 반납완료`
  );
});

console.log('dashboard return status options static checks passed');
