// 회귀 방지 (부분 성공 원장):
// 1) 확인요청 N열 '날짜변경'의 개고생2.0 A열(반출일) 갱신이 빈 catch의 best-effort여서
//    실패가 조용히 사라지고 원장 반출일이 영구히 어긋나던 문제.
// 2) 계약서 재생성 워커가 옛 링크(C열)를 비운 뒤 링크 재기록 실패를 성공으로 처리해
//    거래내역 링크가 빈 채 남던 문제.
// 3) updateContractLink가 C열만 readback하고 I열(금액)은 검증하지 않던 문제.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const backend = fs.readFileSync(path.resolve(__dirname, '..', 'checkAvailability.js'), 'utf8');
const codeJs = fs.readFileSync(path.resolve(__dirname, '..', 'Code.js'), 'utf8');
const contract = fs.readFileSync(path.resolve(__dirname, '..', 'generatecontract.js'), 'utf8');

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`${name} incomplete`);
}

// 1) 날짜변경 → 검증된 원장 갱신 + 실패 시 가시적 경고와 내구 재시도
const dateChange = extractFunction(backend, 'changeDatesForContract');
assert(/ensureRegisteredTradeLedgerRow_\(거래ID,\s*\{\s*dryRun:\s*false\s*\}\)/.test(dateChange),
  '날짜변경은 readback이 있는 ensureRegisteredTradeLedgerRow_로 원장을 갱신해야 한다');
assert(!/catch\s*\(err\)\s*\{\s*\}/.test(dateChange),
  '날짜변경의 원장 갱신 실패를 빈 catch로 삼키면 안 된다');
assert(/거래내역\s*반출일\s*미반영/.test(dateChange),
  '원장 갱신 실패는 O열 상태 메시지로 보여야 한다');
assert(/tradeLedgerSyncPending_v1_/.test(backend) && /function drainPendingTradeLedgerSyncs_\(/.test(backend),
  '원장 갱신 실패는 pending 속성으로 남겨 자동 재시도해야 한다');

// 2) 재생성 워커의 링크 기록 검증
const regenWorker = extractFunction(codeJs, 'regenPendingContracts');
assert(/linkUpdate/.test(regenWorker) && /success !== true/.test(regenWorker),
  '재생성 워커는 linkUpdate.success를 검증해 실패 시 재시도 큐에 남겨야 한다');
// '거래ID를 찾을 수 없음'은 영구 조건 — 단순 재시도는 30분마다 계약서 파일을 만들고
// 버리는 무한 루프가 된다. 행 복구 1회 → 취소/완전삭제 거래는 큐 종료로 분류해야 한다.
assert(/거래ID를 찾을 수 없음/.test(regenWorker) && /ensureRegisteredTradeLedgerRow_/.test(regenWorker),
  '원장 행 부재는 복구 프리미티브로 1회 복구 후 재기록해야 한다');
assert(/skippedCancelled|manualRepairNeeded/.test(regenWorker),
  '취소·완전삭제 거래는 무한 재시도 대신 큐를 비워야 한다');

// 3) 금액(I열) readback
const linkFn = extractFunction(contract, 'updateContractLink');
assert(/금액\s*readback|amountMismatch|amountReadback/.test(linkFn),
  'updateContractLink는 I열 금액도 readback 검증해야 한다');

console.log('# date-change ledger sync & contract link verification checks passed');
