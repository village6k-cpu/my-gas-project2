import test from 'node:test';
import assert from 'node:assert/strict';

import {
  equipmentActualName,
  equipmentActualTakenQty,
  hasEquipmentActualCorrection,
} from '../apps/today-dashboard/lib/domain/equipmentActual.ts';

const base = { scheduleId: '260721-001-01', name: '미라지 T16', qty: 2, takenQty: 2, checkoutState: 'taken' };

test('actual overlay leaves the immutable checkout baseline intact', () => {
  const corrected = { ...base, actualName: '미라지 T12', actualTakenQty: 1 };
  assert.equal(equipmentActualName(corrected), '미라지 T12');
  assert.equal(equipmentActualTakenQty(corrected), 1);
  assert.equal(corrected.name, '미라지 T16');
  assert.equal(corrected.takenQty, 2);
  assert.equal(hasEquipmentActualCorrection(corrected), true);
});

test('zero is a valid actual-taken quantity, not a missing value', () => {
  assert.equal(equipmentActualTakenQty({ ...base, actualTakenQty: 0 }), 0);
  assert.equal(equipmentActualTakenQty(base), 2);
});
