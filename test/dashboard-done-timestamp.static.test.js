const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const logic = read('checkAvailability.js');

[
  "setupDoneAt_",
  "returnDoneAt_",
  "formatDashboardDoneAt_(new Date())",
  "setupDoneAt: setupDoneAt",
  "returnDoneAt: returnDoneAt",
  "doneAt: doneAt"
].forEach((contract) => {
  assert(
    logic.includes(contract),
    `checkAvailability.js must persist and return task completion timestamps: ${contract}`
  );
});

['dashboard.html', 'docs/dashboard.html'].forEach((file) => {
  const html = read(file);
  [
    'taskToggleLabel(cardType, taskDone, item)',
    "return prefix + '완료'",
    "time ? prefix + ' ' + time",
    "prefix + ' 저장중'",
    'function dashboardDoneTime(value)',
    'syncTaskDoneInMemory(tid, action, nowDone, doneAt)'
  ].forEach((contract) => {
    assert(
      html.includes(contract),
      `${file} must label completion buttons with recorded times: ${contract}`
    );
  });
});

console.log('dashboard done timestamp static checks passed');
