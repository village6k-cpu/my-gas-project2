const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'checkAvailability.js'), 'utf8');
const sheetApi = fs.readFileSync(path.resolve(__dirname, '..', 'sheetAPI.js'), 'utf8');

assert.doesNotMatch(
  source,
  /순수 장비마스터 장비만 C를 비운다|세트마스터품목명|setNameForSingle/,
  '스케줄상세 C열 세트명을 비우는 레거시 분기와 변수명이 남아있으면 안 된다'
);

assert.match(
  source,
  /tid,\s*equipName,\s*equipName,\s*qty,\s*반출일,\s*반출시간,\s*반납일,\s*반납시간/,
  '오늘일정 장비추가 단독 품목도 스케줄상세 C=장비명, D=장비명으로 저장해야 한다'
);

assert.match(
  source,
  /schedID,\s*거래ID,\s*장비명,\s*장비명,\s*수량,\s*[\r\n]+\s*반출일str,\s*반출시간str,\s*반납일str,\s*반납시간str/,
  '확인요청 등록/추가 단독 품목도 스케줄상세 C=장비명, D=장비명으로 저장해야 한다'
);

assert.doesNotMatch(
  source,
  /isSetMasterName\([^)]*\)\s*\?\s*[^:]+:\s*""/,
  '세트마스터에 없다는 이유로 스케줄상세 C열을 빈 값으로 만드는 분기는 금지한다'
);

assert.match(
  source,
  /function normalizeScheduleDetailSetNames\(schedSheet\)[\s\S]*schedSheet\.getRange\(2,\s*2,\s*rowCount,\s*3\)\.getValues\(\)[\s\S]*tradeId && !setName && equipName[\s\S]*nextSetName = equipName[\s\S]*schedSheet\.getRange\(2,\s*3,\s*rowCount,\s*1\)\.setValues\(setNameValues\)/,
  '기존 스케줄상세의 C열 빈 행도 C=표시그룹명으로 일괄 정규화할 수 있어야 한다'
);

assert.match(
  source,
  /function normalizeScheduleDetailSetNames\(schedSheet\)[\s\S]*invalidateDashboardCache\(\)[\s\S]*invalidateTimelineCache\(\)[\s\S]*formatScheduleSheet\(schedSheet\)/,
  '스케줄상세 C열 정규화 후 대시보드/타임라인 캐시 무효화와 포맷 재적용이 필요하다'
);

assert.match(
  sheetApi,
  /"normalizeScheduleDetailSetNames"[\s\S]*normalizeScheduleDetailSetNames: typeof normalizeScheduleDetailSetNames !== "undefined" \? normalizeScheduleDetailSetNames : null/,
  '스케줄상세 C열 정규화 함수는 운영 API runFunction에서 실행 가능해야 한다'
);

console.log('schedule detail set-name static checks passed');
