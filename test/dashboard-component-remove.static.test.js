const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const api = read('sheetAPI.js');
const logic = read('checkAvailability.js');

assert(
  api.includes('params.scheduleId || postBody.scheduleId'),
  'sheetAPI.js must pass scheduleId to removeEquip'
);

[
  'function dashboardRemoveEquipment(tid, equipName, scheduleId)',
  'if (isComponent) {',
  'rowsToDelete.push(targetRow);',
  'hasComponents && rowSetName === setKey'
].forEach((contract) => {
  assert(
    logic.includes(contract),
    `checkAvailability.js must support scheduleId based component removal: ${contract}`
  );
});

['dashboard.html', 'docs/dashboard.html'].forEach((file) => {
  const html = read(file);
  assert(
    !html.includes('if (!eq.isComponent)'),
    `${file} must not hide delete controls for set components`
  );
  [
    "removeEquip(\\'",
    "scheduleId=' + encodeURIComponent(scheduleId || '')",
    '선택한 구성품 행만 삭제됩니다',
    '세트 대표행 삭제 시 같은 세트 구성품도 함께 삭제됩니다'
  ].forEach((contract) => {
    assert(
      html.includes(contract),
      `${file} must pass scheduleId and show correct confirmation copy: ${contract}`
    );
  });
});

console.log('dashboard component remove static checks passed');
