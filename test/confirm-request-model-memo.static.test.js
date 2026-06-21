const assert = require('assert');
const fs = require('fs');
const path = require('path');

const checkAvailability = fs.readFileSync(path.resolve(__dirname, '..', 'checkAvailability.js'), 'utf8');
const generateContract = fs.readFileSync(path.resolve(__dirname, '..', 'generatecontract.js'), 'utf8');
const sheetApi = fs.readFileSync(path.resolve(__dirname, '..', 'sheetAPI.js'), 'utf8');

assert.match(
  checkAvailability,
  /F열에서 모델을 새로 선택했는데 I\/J가 예전 "모델 선택 필요"로 남아 있으면[\s\S]*existResult\.indexOf\("모델 선택 필요"\) < 0/,
  '모델 선택 후 I/J가 예전 경고로 남아도 등록 직전에는 다시 가용확인을 돌려야 한다'
);

assert.match(
  checkAvailability,
  /_setModelSelectionPrompt_\(sheet, issueRow, 장비명, catItems, ownerSet\)/,
  '등록 차단 시 어떤 행/세트/후보 모델 때문인지 해당 행 I/J와 F note에 표시해야 한다'
);

assert.match(
  checkAvailability,
  /❌ 모델 미선택: " \+ 미선택목록\.join\("; "\) \+ " → 해당 F열에서 구체 모델 선택 후 다시 등록"/,
  '등록상태 O열에는 막힌 행과 장비명이 구체적으로 보여야 한다'
);

assert.match(
  checkAvailability,
  /_sanitizeConfirmRequestFreeText_\(req\.비고 \|\| "", 180\)/,
  '확인요청 Q열 비고에는 AI 판단/원문 같은 내부 설명을 저장하지 않아야 한다'
);

assert.match(
  checkAvailability,
  /_sanitizeConfirmRequestFreeText_\(req\.추가요청 \|\| "", 180\)/,
  '확인요청 R열 추가요청에도 AI 내부 설명을 저장하지 않아야 한다'
);

assert.match(
  generateContract,
  /sanitizeContractAdditionalRequestText_\(추가요청\)\.split\("\\n"\)/,
  '계약서 생성 시 확인요청 R열을 그대로 품목 셀로 넣지 말고 먼저 정화해야 한다'
);

assert.match(
  generateContract,
  /if \(!hadPrefix && !quantityPattern\.test\(line\)\) return;/,
  '계약서 추가요청은 수량이 있는 품목 또는 명시적 품목 접두어만 계약서 품목으로 넣어야 한다'
);

assert.match(
  sheetApi,
  /"refreshModelSelectionPrompts"/,
  '기존 모델 선택 필요 행도 API로 후보 상세를 즉시 보강할 수 있어야 한다'
);

console.log('confirm request model/memo static checks passed');
