const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

// 실제 사고(2026-08-10): 등록 직후 매분 flush가 반출일 dashboard의 stale 캐시를 읽어
// detail이 누락되면 trades 골격만 올라가고 items가 0건이 됐다. 그 push가 "성공"이라
// dirty 키가 소진돼 재시도도 없었다. 당일 신규 등록 8건 중 4건(조용준 260810-003 등)이
// 앱 스케줄·검색에서 통째로 사라졌다.
// 근본 수정: 품목은 dashboard 캐시가 아니라 스케줄상세 정본에서 직접 읽는다.

const TRADE = '260810-003';
const OTHER = '260810-002';

function harness({ dashboardHasTrade, sheetRows, dashboardThrows = false }) {
  const source = read('supabaseSync.js');
  const from = source.indexOf('function buildSupabaseTrades_');
  const to = source.indexOf('\n/** payload 키 구성이 같은 행끼리 묶어 upsert');
  assert.ok(from >= 0 && to > from, 'buildSupabaseTrades_ 본문을 찾을 수 있어야 한다');
  const body = source.slice(from, to);

  const DAY = 86400000;
  const start = Date.UTC(2026, 7, 12) - 9 * 3600000; // 8/12 KST
  const end = Date.UTC(2026, 7, 15) - 9 * 3600000;

  const context = {
    Date,
    JSON,
    Math,
    Object,
    String,
    Number,
    Array,
    Utilities: {
      formatDate: (d) => {
        const t = new Date(d.getTime() + 9 * 3600000);
        return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
      },
    },
    parseDT: () => null,
    getTimelineData: () => ({
      groups: [],
      items: [
        { tid: TRADE, s: start, e: end },
        { tid: OTHER, s: start - DAY, e: end },
      ],
    }),
    getDashboardData: () => {
      if (dashboardThrows) throw new Error('simulated dashboard failure');
      const rows = [];
      // stale 캐시 재현: 조용준(TRADE)은 대시보드에 없음, OTHER만 있음
      if (dashboardHasTrade) {
        rows.push({
          tradeId: TRADE, name: '조용준', tel: '010-7111-3997',
          equipments: [{ scheduleId: `${TRADE}-01`, name: '17인치 모니터(구형)', qty: 1, setName: '', isHeader: true, isComponent: false, category: '모니터' }],
        });
      }
      rows.push({
        tradeId: OTHER, name: '김성윤', tel: '010-0000-0000',
        equipments: [{ scheduleId: `${OTHER}-01`, name: '삼각대', qty: 1, setName: '', isHeader: true, isComponent: false, category: '' }],
      });
      return { checkout: rows, checkin: [] };
    },
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ({
        getSheetByName: (name) => {
          if (name === '계약마스터') {
            return {
              getLastRow: () => 2,
              getRange: () => ({
                getValues: () => [[TRADE, '조용준', '', '', new Date(start), '', new Date(end), '', 3, '예약', '학생']],
                getDisplayValues: () => [[TRADE, '조용준', '', '', '2026-08-12', '16:00', '2026-08-15', '16:00', '3', '예약', '학생']],
              }),
            };
          }
          if (name === '스케줄상세') {
            if (!sheetRows) return null;
            return {
              getLastRow: () => sheetRows.length + 1,
              getRange: () => ({ getValues: () => sheetRows.map((r) => r.slice()) }),
            };
          }
          return null;
        },
      }),
    },
  };
  vm.createContext(context);
  vm.runInContext(`${body}\nthis.build = buildSupabaseTrades_;`, context);
  return context;
}

const SHEET_ROWS = [
  [`${TRADE}-01`, TRADE, '17인치 모니터(구형)', '17인치 모니터(구형)', 1],
  [`${TRADE}-02`, TRADE, '파이로 7', '파이로 7', 1],
  [`${TRADE}-03`, TRADE, '파이로 7', 'D탭*1 / SDI or HDMI*1 / 안테나*2', 1],
  [`${OTHER}-01`, OTHER, '', '삼각대', 1],
  ['260701-001-01', '260701-001', '', '무관한 거래', 1],
];

test('detail(dashboard 캐시)이 누락돼도 품목은 정본에서 올라간다 — 사고 재현', () => {
  const ctx = harness({ dashboardHasTrade: false, sheetRows: SHEET_ROWS });
  const out = ctx.build([TRADE, OTHER]);

  const mine = out.items.filter((it) => it.trade_id === TRADE);
  assert.equal(mine.length, 3,
    'stale 캐시로 detail이 빠져도 스케줄상세에 있는 품목 3건이 전부 올라가야 한다');
  assert.ok(out.trades.some((t) => t.trade_id === TRADE), '골격 upsert도 유지');

  // 세트 규칙: 대표행/구성품 판정이 dashboard와 같아야 앱 표시가 안 깨진다
  const header = mine.find((it) => it.schedule_id === `${TRADE}-02`);
  const comp = mine.find((it) => it.schedule_id === `${TRADE}-03`);
  assert.equal(header.is_set_header, true);
  assert.equal(comp.is_component, true);
  assert.equal(comp.set_name, '파이로 7');
});

test('detail이 있어도 품목 목록은 정본이 이긴다 — stale 캐시가 품목을 누락시키지 못한다', () => {
  const ctx = harness({ dashboardHasTrade: true, sheetRows: SHEET_ROWS });
  const out = ctx.build([TRADE]);
  const mine = out.items.filter((it) => it.trade_id === TRADE);
  // stale detail에는 1건뿐이지만 정본에는 3건 — 정본이 이겨야 한다
  assert.equal(mine.length, 3);
  // category는 detail에서 이름으로 보강된다
  assert.equal(mine.find((it) => it.schedule_id === `${TRADE}-01`).category, '모니터');
});

test('dashboard 조회가 통째로 실패해도 품목은 올라간다', () => {
  const ctx = harness({ dashboardHasTrade: false, sheetRows: SHEET_ROWS, dashboardThrows: true });
  const out = ctx.build([TRADE]);
  assert.equal(out.items.filter((it) => it.trade_id === TRADE).length, 3);
});

test('스케줄상세 읽기가 실패하면 detail 폴백으로 최소한을 지킨다', () => {
  const ctx = harness({ dashboardHasTrade: true, sheetRows: null });
  const out = ctx.build([TRADE]);
  assert.equal(out.items.filter((it) => it.trade_id === TRADE).length, 1,
    '정본을 못 읽으면 dashboard 품목이라도 올라가야 한다');
});

test('요청한 거래의 품목만 올라간다', () => {
  const ctx = harness({ dashboardHasTrade: false, sheetRows: SHEET_ROWS });
  const out = ctx.build([TRADE]);
  assert.ok(!out.items.some((it) => it.trade_id === '260701-001'), '무관한 거래 품목이 섞이면 안 된다');
});

test('checkout_state는 여전히 flush가 건드리지 않는다', () => {
  const ctx = harness({ dashboardHasTrade: false, sheetRows: SHEET_ROWS });
  const out = ctx.build([TRADE]);
  for (const it of out.items) {
    assert.ok(!('checkout_state' in it),
      '1분 dirty worker의 오래된 snapshot이 최신 체크를 되돌리면 안 된다');
  }
});
