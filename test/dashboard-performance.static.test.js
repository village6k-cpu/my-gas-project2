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
  3,
  'getDashboardContractMapForIds_ must scan IDs once and read only matched 계약마스터 rows'
);
assert.deepStrictEqual(
  contractSheet.calls[0],
  { row: 2, col: 1, numRows: 3, numCols: 1 },
  'contract map should scan only the 거래ID column first'
);
assert.deepStrictEqual(
  contractSheet.calls.slice(1),
  [
    { row: 2, col: 1, numRows: 1, numCols: 10 },
    { row: 4, col: 1, numRows: 1, numCols: 10 }
  ],
  'contract map should read only the matched dashboard contract rows'
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

const singleCandidates = gasContext.buildDashboardEquipmentRiskCandidates_(
  [{
    scheduleId: 'SCH-002',
    name: 'FX3 바디',
    qty: 1,
    setName: '',
    isHeader: true,
    isSet: false,
    isComponent: false
  }],
  {
    getLastRow() {
      throw new Error('single equipment must not trigger setSheet fallback reads');
    }
  },
  {}
);

assert.deepStrictEqual(
  JSON.parse(JSON.stringify(singleCandidates)),
  [{
    scheduleId: 'SCH-002',
    name: 'FX3 바디',
    qty: 1,
    setName: '',
    isHeader: true,
    isSet: false,
    isComponent: false
  }],
  'single equipment risk candidates must not scan 세트마스터 as a fallback'
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

assert.match(
  backend,
  /var evaluateRisk\s*=[\s\S]*options\.evaluateRisk/,
  'getDashboardData must keep external equipment-risk evaluation behind an explicit option'
);

assert.match(
  backend,
  /if \(evaluateRisk\) \{[\s\S]*evaluateEquipmentRiskGuidanceStates_\(result\);[\s\S]*\} else \{[\s\S]*markEquipmentRiskSearchEvaluationSkipped_\(result\);/,
  'default dashboard payload must not wait for external equipment-risk evaluation'
);

const dashboardDataBody = backend.match(/function getDashboardData\([\s\S]*?\n}\n\nfunction getDashboardSearchData/);
assert.ok(dashboardDataBody, 'getDashboardData must exist before getDashboardSearchData');
assert.match(
  dashboardDataBody[0],
  /findDashboardRowsByValue_\(schedSheet,\s*6,\s*schedLastRow,\s*today\)[\s\S]*findDashboardRowsByValue_\(schedSheet,\s*8,\s*schedLastRow,\s*today\)/,
  'getDashboardData must find today checkout/checkin rows by date columns instead of reading the whole schedule payload'
);
assert.match(
  dashboardDataBody[0],
  /readDashboardScheduleRowsDisplay_\(schedSheet,\s*todayRows,\s*12\)/,
  'getDashboardData must read only matched today rows'
);
assert.doesNotMatch(
  dashboardDataBody[0],
  /getRange\(2,\s*1,\s*schedSheet\.getLastRow\(\) - 1,\s*12\)\.getDisplayValues\(\)/,
  'getDashboardData must not read all schedule rows A:L for every first load'
);
assert.match(
  backend,
  /function readDashboardScheduleRowsDisplay_\([\s\S]*getDisplayValues\(\)/,
  'dashboard fast path must have a batched display-row reader for matched rows'
);

assert.match(
  backend,
  /function getEquipmentCheckMapForIds_\(tradeIds\)[\s\S]*getRange\(2,\s*keyCol,\s*rowCount,\s*1\)\.getDisplayValues\(\)[\s\S]*readDashboardScheduleRowsDisplay_\(sheet,\s*rowsToRead,\s*lastCol\)/,
  'equipment check map must scan only 거래ID keys before reading matched 장비체크 rows'
);

assert.match(
  backend,
  /function getEquipmentCheckRowIndexForTradeIds_\(sheet,\s*schema,\s*rowCount,\s*keyCol\)[\s\S]*getDashboardCacheJson_\(cache,\s*cacheKey\)[\s\S]*putDashboardCacheJson_\(cache,\s*cacheKey,\s*index,\s*300\)/,
  'equipment check row index must be cached so repeated search/detail loads avoid rescanning 장비체크 keys'
);

assert.match(
  backend,
  /var rowIndex\s*=\s*getEquipmentCheckRowIndexForTradeIds_\(sheet,\s*schema,\s*rowCount,\s*keyCol\)/,
  'equipment check map must use the cached row index before reading matched rows'
);

assert.match(
  read('sheetAPI.js'),
  /evaluateRisk:\s*params\.riskEval\s*\|\|\s*postBody\.riskEval/,
  'sheetAPI dashboard action must expose explicit riskEval opt-in without slowing the default path'
);

assert.match(
  backend,
  /removeDashboardCacheJson_\(cache,\s*'dashboard_v4_' \+ d\)[\s\S]*removeDashboardCacheJson_\(cache,\s*'dashboard_v4_' \+ d \+ '_risk'\)/,
  'invalidateDashboardCache must clear the current dashboard v4 cache keys'
);

assert.match(
  backend,
  /function getDashboardCacheJson_\(cache,\s*cacheKey\)[\s\S]*cache\.getAll\(keys\)[\s\S]*JSON\.parse\(parts\.join\(''\)\)/,
  'dashboard cache reads must support chunked payloads over the single CacheService item limit'
);

assert.match(
  backend,
  /function putDashboardCacheJson_\(cache,\s*cacheKey,\s*value,\s*seconds\)[\s\S]*cache\.putAll\(payload,\s*seconds \|\| 900\)/,
  'dashboard cache writes must chunk large payloads instead of slow single-item cache.put attempts'
);

assert.match(
  backend,
  /var DASHBOARD_CACHE_MAX_CHUNKS_\s*=\s*30;/,
  'dashboard chunked cache must allow large availability maps to fit after warmup'
);

assert.match(
  backend,
  /putDashboardCacheJson_\(cache,\s*cacheKey,\s*result,\s*900\)/,
  'getDashboardData must write dashboard payloads through the chunked cache helper'
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
    /var INITIAL_EQUIP_NAMES\s*=\s*null;/,
    `${file} must declare INITIAL_EQUIP_NAMES so the add-equipment dropdown can hydrate without blocking first render`
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
    `${file} must not block page load with a full equipment-list fetch`
  );
  assert.match(
    html,
    /function queueEquipListPrefetch\([\s\S]*loadEquipList\(\)[\s\S]*requestIdleCallback/,
    `${file} must prefetch equipment names only after dashboard render is underway`
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
