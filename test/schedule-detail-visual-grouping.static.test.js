const assert = require('assert');
const fs = require('fs');
const path = require('path');

const checkAvailability = fs.readFileSync(path.resolve(__dirname, '..', 'checkAvailability.js'), 'utf8');
const code = fs.readFileSync(path.resolve(__dirname, '..', 'Code.js'), 'utf8');
const sheetAPI = fs.readFileSync(path.resolve(__dirname, '..', 'sheetAPI.js'), 'utf8');

assert.match(
  checkAvailability,
  /const SCHEDULE_SET_HEADER_COLOR = "#E6E0F8";/,
  '스케줄상세 세트 헤더는 시트 검색/경고 색과 겹치지 않는 라벤더색을 써야 한다'
);

assert.match(
  checkAvailability,
  /const SCHEDULE_SET_COMPONENT_COLOR = "#F4F0FB";/,
  '스케줄상세 세트 구성품은 헤더보다 약한 라벤더색으로 구분해야 한다'
);

assert.match(
  checkAvailability,
  /const SCHEDULE_SET_FONT_COLOR = "#4B3A7A";/,
  '스케줄상세 세트 텍스트는 라벤더 배경에서 충분히 읽히는 보라색이어야 한다'
);

assert.doesNotMatch(
  checkAvailability,
  /const SCHEDULE_SET_(?:HEADER|COMPONENT|FONT)_COLOR = "#(?:D9EAD3|EAF4E4|274E13|FFF2CC|FFEB9C)";/,
  '스케줄상세 세트 색은 검색/경고와 헷갈리는 초록·노랑 계열로 돌아가면 안 된다'
);

assert.match(
  checkAvailability,
  /const data = schedSheet\.getRange\(2,\s*2,\s*rowCount,\s*3\)\.getValues\(\);/,
  '스케줄상세 포맷은 거래ID/세트명/장비명(B:D)을 함께 읽어야 한다'
);

assert.match(
  checkAvailability,
  /sSetName !== sEquipName[\s\S]{0,120}setGroupKeys\[makeScheduleSetKey_\(sTradeId,\s*sSetName\)\] = true;/,
  '세트 구성품이 있는 경우에만 세트 헤더로 판정해야 단독 품목이 초록색으로 오인되지 않는다'
);

assert.match(
  checkAvailability,
  /var isSetComponent = !!\(curID && setName && equipName && setName !== equipName\);/,
  'C열 세트명과 D열 장비명이 다르면 세트 구성품으로 표시해야 한다'
);

assert.match(
  checkAvailability,
  /var isSetHeader = !!\(curID && equipName && \([\s\S]{0,220}!setName && setGroupKeys\[makeScheduleSetKey_\(curID,\s*equipName\)\]/,
  '세트 헤더는 C=D 신형 행과 C가 빈 구형 대표행을 모두 처리해야 한다'
);

assert.match(
  checkAvailability,
  /fullRange\.setBackgrounds\(rowBackgrounds\);[\s\S]{0,220}schedSheet\.getRange\(2,\s*3,\s*rowCount,\s*2\)\.setBackgrounds\(itemBackgrounds\);/,
  '거래건 전체 배경을 먼저 적용하고 C:D 세트/구성품 색상만 덮어야 한다'
);

assert.match(
  checkAvailability,
  /schedSheet\.getRange\(2,\s*3,\s*rowCount,\s*2\)\.setFontWeights\(itemFontWeights\);/,
  '세트 헤더 굵기와 일반 장비 행 굵기를 한 번에 정리해야 한다'
);

assert.match(
  code,
  /function autoExpandSetInSchedule[\s\S]*typeof formatScheduleSheet === "function"[\s\S]*formatScheduleSheet\(sheet\);/,
  '스케줄상세에서 직접 세트를 입력해 자동 펼침된 경우에도 즉시 새 색상 규칙을 적용해야 한다'
);

assert.match(
  checkAvailability,
  /function inspectScheduleDetailVisualState\(\)[\s\S]*formatScheduleSheet\(schedSheet\);[\s\S]*getBackgrounds\(\)[\s\S]*expectedHeaderBgRows[\s\S]*oldGreenRows/,
  '스케줄상세 실제 시트 배경색을 재포맷 후 진단할 수 있어야 한다'
);

assert.match(
  sheetAPI,
  /"inspectScheduleDetailVisualState"[\s\S]*inspectScheduleDetailVisualState: typeof inspectScheduleDetailVisualState !== "undefined" \? inspectScheduleDetailVisualState : null/,
  '스케줄상세 색상 진단 함수는 sheetAPI action=run으로 호출 가능해야 한다'
);

console.log('schedule detail visual grouping static checks passed');
