const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const contractSource = fs.readFileSync(path.join(root, 'generatecontract.js'), 'utf8');
const availabilitySource = fs.readFileSync(path.join(root, 'checkAvailability.js'), 'utf8');

const context = { console };
vm.runInNewContext(contractSource, context);

function rentalDays(startDate, startTime, endDate, endTime) {
  return context.calcRentalDays(startDate, startTime, endDate, endTime);
}

assert.strictEqual(
  rentalDays('2026-06-01', '09:00', '2026-06-02', '12:00'),
  1,
  '24시간에 3시간을 더한 정확히 27시간까지는 1회차여야 한다'
);

assert.strictEqual(
  rentalDays('2026-06-01', '09:00', '2026-06-02', '12:01'),
  2,
  '3시간을 1분이라도 초과하면 다음 회차가 추가되어야 한다'
);

assert.strictEqual(
  rentalDays('2026-06-01', '09:00', '2026-06-03', '15:00'),
  3,
  '48시간보다 6시간 긴 대여는 3회차여야 한다'
);

assert.match(
  availabilitySource,
  /Math\.ceil\(\(totalHours - 3\) \/ 24\)/,
  '신규 예약 등록도 3시간 유예 기준으로 계약마스터 회차를 계산해야 한다'
);

assert.doesNotMatch(
  contractSource + '\n' + availabilitySource,
  /Math\.ceil\(\(totalHours - 6\) \/ 24\)/,
  '운영 회차 계산 경로에 기존 6시간 유예 기준이 남아 있으면 안 된다'
);

console.log('rental round 3-hour grace-period checks passed');
