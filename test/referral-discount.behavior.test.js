const {readFileSync} = require('node:fs');
const {runInNewContext} = require('node:vm');
const assert = require('node:assert/strict');
const {test} = require('node:test');

const referralCode = readFileSync('ReferralDiscount.js', 'utf8');
const adminCode = readFileSync('referralDiscountAdmin.js', 'utf8');
const referred = '01011112222', referrer = '01033334444', second = '01055556666';
const trades = {
  '261118-001': [referred, '예약'], '261118-002': [referred, '예약'],
  '261118-003': [referrer, '예약'], '261118-004': [referrer, '예약'],
  '261118-005': [second, '예약'],
};

function fixture() {
  const queued = [];
  const data = {
    계약마스터: [[], ...Object.entries(trades).map(([id, [phone, status]]) => [id, '', phone, '', '2026-11-' + String(17+Number(id.slice(-3))), '09:00', '', '', '', status])],
    확인요청: [[], ['RQ-261118-001', '2026-11-18', '09:00', '', '', '', '', '', '', '', '', referred, '', '', '대기', '']],
  };
  const API = {getSheetByName(name) {
    const rows = data[name];
    if (!rows) return null;
    return {
      getLastRow: () => rows.length,
      setFrozenRows() {},
      getRange(start, col, count, width) {
        return {
          getDisplayValues: () => rows.slice(start-1, start-1+count).map(row => row.slice(col-1,col-1+width)),
          setNumberFormat() { return this; },
          setValues(values) { rows[start-1] = values[0].slice(); },
          setValue(value) { rows[start-1][col-1] = value; },
          createTextFinder(id) {
            return {
              matchEntireCell() { return this; },
              matchCase() { return this; },
              findAll() { return rows.flatMap((row, i) => row[0] === id ? [{getRow:()=>i+1}] : []); },
            };
          },
        };
      },
    };
  }, insertSheet(name) { data[name]=[]; return API.getSheetByName(name); }};
  const code = runInNewContext(referralCode + adminCode + '\n({applyVerifiedReferralDiscount_,verifiedReferralDiscountRate_,promoteRegisteredReferralDiscount_})', {
    SpreadsheetApp:{getActiveSpreadsheet:()=>API,flush(){}},
    parseDT:(date,time)=>new Date(date+'T'+time+':00+09:00'),
    scheduleContractRegenUnderLock_:id=>queued.push(id),
    ensureContractRegenTrigger_(){},
    LockService:{getScriptLock:()=>({waitLock(){},releaseLock(){}})},
  });
  const approve = (customer, first, use) => code.applyVerifiedReferralDiscount_({
    verified:true,referredPhone:customer,referrerPhone:referrer,firstBookingId:first,referrerBookingId:use,
  });
  const approveName = (customer, first, name, phone, use) => code.applyVerifiedReferralDiscount_({
    verified:true,referredPhone:customer,referrerName:name,referrerPhone:phone,firstBookingId:first,referrerBookingId:use,
  });
  return {approve,approveName,rate:(id,phone)=>code.verifiedReferralDiscountRate_(API,id,phone),
    promote:()=>code.promoteRegisteredReferralDiscount_(API,"RQ-261118-001","261118-001"),data,queued};
}

test('an introduction applies only to its approved first booking and follows request registration', () => {
  const {approve,rate,promote,data} = fixture();
  data.계약마스터.splice(1,1);
  approve(referred, 'RQ-261118-001');
  assert.equal(rate('RQ-261118-001',referred),5);
  data.계약마스터.push(['261118-001','','01011112222','','2026-11-18','09:00','','','','예약']);
  data.확인요청[1][14]='등록완료';
  data.확인요청[1][15]='261118-001';
  promote();
  data.확인요청.splice(1,1);
  assert.equal(rate('261118-001',Number(referred)),5);
  assert.equal(rate('261118-002',referred),0);
  assert.equal(rate('261118-001',referrer),0);
  assert.throws(()=>approve(referred,'261118-002'),/이미 다른 대여/);
});

test('a referrer can redeem a fresh five percent for each distinct new customer', () => {
  const {approve,rate,data,queued} = fixture();
  approve(referred,'261118-001');
  assert.equal(rate('261118-003',referrer),0);
  approve(referred,'261118-001','261118-003');
  approve(referred,'261118-001','261118-003');
  assert.throws(()=>approve(second,'261118-005','261118-003'),/이미 소개할인/);
  approve(second,'261118-005','261118-004');
  assert.equal(rate('261118-003',referrer),5);
  assert.equal(rate('261118-004',referrer),5);
  assert.equal(data.소개할인.length,3);
  assert.deepEqual(queued,['261118-001','261118-003','261118-005','261118-004']);
});

test('an active earlier rental prevents enrolling a repeat customer as a first rental', () => {
  const {approve,rate} = fixture();
  assert.throws(()=>approve(referred,'261118-002'),/이전 대여 이력/);
  assert.equal(rate('261118-002',referred),0);
});

test('a verified introduction can apply to the first renter while the referrer identity is pending', () => {
  const {approveName,rate,data}=fixture();
  approveName(referred,'261118-001','소개자');
  assert.equal(rate('261118-001',referred),5);
  assert.equal(rate('261118-003',referrer),0);
  approveName(referred,'261118-001','소개자',referrer,'261118-003');
  assert.equal(rate('261118-003',referrer),5);
  assert.equal(data.소개할인.length,2);
});

test('the referrer can use a credit only after the first rental is registered', () => {
  const {approve,rate,promote,data} = fixture();
  const firstTrade = data.계약마스터.splice(1,1)[0];
  approve(referred,'RQ-261118-001');
  assert.equal(rate('RQ-261118-001',referred),5);
  assert.throws(()=>approve(referred,'RQ-261118-001','261118-003'),/첫 대여가 확정된 뒤/);
  assert.equal(rate('261118-003',referrer),0);

  data.계약마스터.push(firstTrade);
  data.확인요청[1][14]='등록완료';
  data.확인요청[1][15]='261118-001';
  promote();
  approve(referred,'261118-001','261118-003');
  assert.equal(rate('261118-003',referrer),5);
});
