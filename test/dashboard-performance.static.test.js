const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const backend = read('checkAvailability.js');

const gasContext = {
  console,
  Logger: { log() {} },
  SpreadsheetApp: {
    DataValidationCriteria: {
      VALUE_IN_LIST: 'VALUE_IN_LIST',
      VALUE_IN_RANGE: 'VALUE_IN_RANGE'
    }
  }
};
vm.createContext(gasContext);
vm.runInContext(backend, gasContext);

function makeContractSheet(rows) {
  const calls = [];
  return {
    calls,
    getLastRow() {
      return rows.length + 1;
    },
    getRange(row, col, numRows, numCols) {
      calls.push({ row, col, numRows, numCols });
      const start = row - 2;
      const values = rows.slice(start, start + numRows).map((source) => {
        return source.slice(col - 1, col - 1 + numCols);
      });
      return {
        getDisplayValues() {
          return values;
        }
      };
    }
  };
}

const contractSheet = makeContractSheet([
  ['260521-001', '김가영', '010-1111-1111', '빌리지', '', '', '', '', '', '예약'],
  ['260521-002', '이도현', '010-2222-2222', '외부팀', '', '', '', '', '', '반출'],
  ['260521-003', '박서준', '010-3333-3333', '제작사', '', '', '', '', '', '반납완료']
]);

const contractMap = gasContext.getDashboardContractMapForIds_(contractSheet, ['260521-001', '260521-003']);

assert.deepStrictEqual(
  JSON.parse(JSON.stringify(contractMap)),
  {
    '260521-001': {
      name: '김가영',
      tel: '010-1111-1111',
      company: '빌리지',
      contractStatus: '예약'
    },
    '260521-003': {
      name: '박서준',
      tel: '010-3333-3333',
      company: '제작사',
      contractStatus: '반납완료'
    }
  },
  'contract map must still return the selected trade metadata'
);

assert.strictEqual(
  contractSheet.calls.length,
  1,
  'getDashboardContractMapForIds_ must read 계약마스터 A:J once instead of one getRange per matching trade'
);
assert.deepStrictEqual(
  contractSheet.calls[0],
  { row: 2, col: 1, numRows: 3, numCols: 10 },
  'contract map should read the exact dashboard contract columns in one batch'
);

assert.strictEqual(
  typeof gasContext.buildDashboardSetComponentLookup_,
  'function',
  'dashboard risk candidates must support a prebuilt set component lookup'
);

const candidates = gasContext.buildDashboardEquipmentRiskCandidates_(
  [{
    scheduleId: 'SCH-001',
    name: 'FX3 풀세트',
    qty: 1,
    setName: '',
    isHeader: true,
    isSet: true,
    isComponent: false
  }],
  {
    getLastRow() {
      throw new Error('setSheet should not be read when lookup is provided');
    }
  },
  {
    'FX3 풀세트': [
      { name: '미라지 매트박스', qty: 1, alt: '' },
      { name: 'FX3 바디', qty: 1, alt: '' }
    ]
  }
);

assert.ok(
  candidates.some((eq) => eq.name === '미라지 매트박스' && eq.setName === 'FX3 풀세트'),
  'risk candidate building must reuse the prebuilt set component lookup'
);

assert.match(
  backend,
  /var riskCandidateLookup\s*=\s*buildDashboardSetComponentLookup_\(setSheet\)/,
  'getDashboardData must build the set component lookup once per payload'
);

assert.match(
  backend,
  /buildDashboardEquipmentRiskCandidates_\(displayEquip,\s*setSheet,\s*riskCandidateLookup\)/,
  'date dashboard payload must pass the shared set component lookup into risk candidate building'
);

['dashboard.html', 'docs/dashboard.html'].forEach((file) => {
  const html = read(file);

  assert.match(
    html,
    /var API_URL[\s\S]{0,180}var INITIAL_DATA\s*=\s*null;/,
    `${file} must declare INITIAL_DATA so GAS and Pages share the same startup path`
  );

  assert.match(
    html,
    /if \(INITIAL_DATA && isDashboardDateMatch\(INITIAL_DATA,\s*formatDate\(currentDate\)\)\)/,
    `${file} must render embedded initial data before making a dashboard fetch`
  );

  assert.match(
    html,
    /var DASHBOARD_PREFETCH_ADJACENT_DATES\s*=\s*false;/,
    `${file} must keep adjacent-date prefetch disabled by default to avoid extra first-load GAS calls`
  );

  assert.match(
    html,
    /function prefetchAdjacentDashboardDates\(dateStr\)[\s\S]{0,160}if \(!DASHBOARD_PREFETCH_ADJACENT_DATES\) return;/,
    `${file} must gate adjacent-date prefetch behind the explicit flag`
  );

  assert.doesNotMatch(
    html,
    /window\.addEventListener\('load',\s*function\(\)\s*\{\s*loadEquipList\(\);\s*\}\);/,
    `${file} must not load the full equipment list until an add-equipment modal is opened`
  );

  assert.match(
    html,
    /var dashboardCurrentView\s*=\s*null;/,
    `${file} must keep the prepared dashboard view separate from rendered tab DOM`
  );

  assert.match(
    html,
    /function renderActiveDashboardSection\(/,
    `${file} must render only the active dashboard tab immediately`
  );

  assert.match(
    html,
    /function getDashboardActiveSectionItems\(/,
    `${file} must derive photo loading from the active tab instead of all cards`
  );
});

console.log('dashboard performance static checks passed');
