const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'checkAvailability.js'), 'utf8');

function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);
  let depth = 0;
  let opened = false;
  for (let i = start; i < source.length; i += 1) {
    if (source[i] === '{') { depth += 1; opened = true; }
    else if (source[i] === '}') {
      depth -= 1;
      if (opened && depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated function: ${name}`);
}

const registerBody = source.slice(
  source.indexOf('function registerByReqID('),
  source.indexOf('function processRegistrationQueue_('),
);
const reserveAt = registerBody.indexOf('reserveExternalTradeId_(');
const contractWriteAt = registerBody.indexOf('contractSheet.getRange(newContractRow');
const scheduleWriteAt = registerBody.indexOf('schedSheet.getRange(setRow');
assert.ok(reserveAt >= 0, 'new registration must reserve an external trade ID');
assert.ok(reserveAt < contractWriteAt && reserveAt < scheduleWriteAt,
  'external ledger reservation and readback must finish before any local contract or schedule write');
assert.doesNotMatch(
  registerBody,
  /개고생2\.0 접근 실패 시 무시|catch \(err\) \{\s*\/\/ 개고생2\.0 접근 실패 시 무시/,
  'external ledger read/allocation failure must never fall back to a local-only ID'
);

const failureMarker = extractFunction('markRequestLedgerReservationFailed_');
assert.doesNotMatch(failureMarker, /getRange\([^\n]+,\s*14\)/,
  'ledger reservation failure must preserve N-column owner approval for retry');

const fetchCalls = [];
const properties = new Map([
  ['POPBILL_SECRET_KEY', 'popbill-secret-for-test'],
  ['VILLAGE_OPS_API_URL', 'https://script.google.com/macros/s/example/exec']
]);
const context = vm.createContext({
  Buffer,
  JSON,
  String,
  Error,
  Utilities: {
    computeHmacSha256Signature: (value) => Array.from(Buffer.from(String(value), 'utf8')),
    base64EncodeWebSafe: (bytes) => Buffer.from(bytes).toString('base64url')
  },
  PropertiesService: {
    getScriptProperties: () => ({ getProperty: (key) => properties.get(key) || null })
  },
  UrlFetchApp: {
    fetch(url, options) {
      fetchCalls.push({ url, options });
      return {
        getResponseCode: () => 200,
        getContentText: () => JSON.stringify({
          success: true, status: 'OK', tradeId: '260818-007', row: 9, deduped: false
        })
      };
    }
  }
});
vm.runInContext(extractFunction('getVillageOpsApiUrl_'), context);
vm.runInContext(extractFunction('getTradeIdReservationApiKey_'), context);
vm.runInContext(extractFunction('getTradeIdReservationOperationId_'), context);
vm.runInContext(extractFunction('reserveExternalTradeId_'), context);

const result = context.reserveExternalTradeId_({
  reqID: 'RQ-260818-001', customerName: '테스트고객', phone: '010-1234-5678', startDate: '2026-08-20'
});
assert.equal(result.tradeId, '260818-007');
assert.equal(fetchCalls.length, 1);
const posted = JSON.parse(fetchCalls[0].options.payload);
assert.equal(posted.action, 'reserveTradeId');
assert.match(posted.operationId, /^confirm-register:RQ-260818-001:[A-Za-z0-9_-]{16}$/);
assert.doesNotMatch(posted.operationId, /테스트고객|010-1234-5678/,
  'the idempotency key must not expose customer PII');
assert.ok(posted.key, 'the server-only reservation key must be included');

context.reserveExternalTradeId_({
  reqID: 'RQ-260818-001', customerName: '다른고객', phone: '010-9999-9999', startDate: '2026-08-21'
});
const reusedReqIdPayload = JSON.parse(fetchCalls[1].options.payload);
assert.notEqual(reusedReqIdPayload.operationId, posted.operationId,
  'a historically reused request ID must not reuse another customer reservation receipt');

context.reserveExternalTradeId_({
  reqID: 'RQ-260818-001', customerName: '테스트고객', phone: '010-1234-5678', startDate: '2026-08-20'
});
const repeatedPayload = JSON.parse(fetchCalls[2].options.payload);
assert.equal(repeatedPayload.operationId, posted.operationId,
  'the same request identity must keep a stable idempotency key across retries');

properties.set('POPBILL_SECRET_KEY', '');
assert.throws(
  () => context.reserveExternalTradeId_({
    reqID: 'RQ-260818-002', customerName: '테스트고객', phone: '010-1234-5678', startDate: '2026-08-20'
  }),
  /전용 인증키 미설정/,
  'the browser-visible default key must never authorize trade ID reservation'
);
assert.equal(fetchCalls.length, 3, 'missing secure key must fail before any network call');

console.log('register-ledger-reservation-boundary.test.js OK');
