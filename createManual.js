/**
 * ====================================================================
 * createManual.gs — 빌리지 운영 매뉴얼 시트 자동 생성
 * ====================================================================
 * 메뉴 → 빌리지 스케줄 → 매뉴얼 생성  또는  직접 실행
 */

function createManualSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // 기존 매뉴얼 시트 삭제 후 재생성
  const existing = ss.getSheetByName('📋 매뉴얼');
  if (existing) ss.deleteSheet(existing);
  const sh = ss.insertSheet('📋 매뉴얼');
  ss.setActiveSheet(sh);

  // 열 너비 설정
  sh.setColumnWidth(1, 28);
  sh.setColumnWidth(2, 160);
  sh.setColumnWidth(3, 220);
  sh.setColumnWidth(4, 220);
  sh.setColumnWidth(5, 220);
  sh.setColumnWidth(6, 28);


  let r = 1; // 현재 행

  // ══════════════════════════════════════════════
  // 헬퍼 함수
  // ══════════════════════════════════════════════

  function setVal(row, col, val) {
    sh.getRange(row, col).setValue(val);
  }

  function sectionHeader(row, text, bgColor) {
    sh.getRange(row, 1, 1, 6).merge()
      .setValue(text)
      .setBackground(bgColor || '#1A1A2E')
      .setFontColor('#FFFFFF')
      .setFontSize(13)
      .setFontWeight('bold')
      .setVerticalAlignment('middle')
      .setHorizontalAlignment('center');
    sh.setRowHeight(row, 36);
  }

  function subHeader(row, text, bgColor) {
    sh.getRange(row, 2, 1, 4).merge()
      .setValue(text)
      .setBackground(bgColor || '#2D3748')
      .setFontColor('#FFFFFF')
      .setFontSize(11)
      .setFontWeight('bold')
      .setVerticalAlignment('middle');
    sh.setRowHeight(row, 28);
  }

  function tableHeader(row, cols, bgColor) {
    cols.forEach(function(c, i) {
      sh.getRange(row, i + 2)
        .setValue(c)
        .setBackground(bgColor || '#4A5568')
        .setFontColor('#FFFFFF')
        .setFontSize(10)
        .setFontWeight('bold')
        .setHorizontalAlignment('center')
        .setVerticalAlignment('middle');
    });
    sh.setRowHeight(row, 26);
  }

  function tableRow(row, cols, bgColor, bold) {
    cols.forEach(function(c, i) {
      const cell = sh.getRange(row, i + 2)
        .setValue(c)
        .setBackground(bgColor || '#FFFFFF')
        .setFontSize(10)
        .setVerticalAlignment('middle')
        .setWrap(true);
      if (bold) cell.setFontWeight('bold');
    });
    sh.setRowHeight(row, 24);
  }

  function stepRow(row, num, action, detail, result, color) {
    sh.getRange(row, 2).setValue('  ' + num)
      .setBackground(color || '#EBF8FF')
      .setFontWeight('bold').setFontSize(11).setVerticalAlignment('middle');
    sh.getRange(row, 3).setValue(action)
      .setBackground(color || '#EBF8FF')
      .setFontWeight('bold').setFontSize(10).setVerticalAlignment('middle').setWrap(true);
    sh.getRange(row, 4).setValue(detail)
      .setBackground('#F7FAFC')
      .setFontSize(10).setVerticalAlignment('middle').setWrap(true);
    sh.getRange(row, 5).setValue(result)
      .setBackground('#F0FFF4')
      .setFontSize(10).setVerticalAlignment('middle').setWrap(true)
      .setFontColor('#276749');
    sh.setRowHeight(row, 40);
  }

  function blank(row, height) {
    sh.getRange(row, 1, 1, 6).setBackground('#F7F8FA');
    sh.setRowHeight(row, height || 12);
  }

  function noteRow(row, text, color) {
    sh.getRange(row, 2, 1, 4).merge()
      .setValue(text)
      .setBackground(color || '#FFFBEB')
      .setFontSize(10)
      .setFontColor('#92400E')
      .setVerticalAlignment('middle')
      .setWrap(true);
    sh.setRowHeight(row, 30);
  }


  // ══════════════════════════════════════════════
  // TITLE
  // ══════════════════════════════════════════════
  sh.getRange(r, 1, 1, 6).merge()
    .setValue('빌리지 장비 예약 관리 시스템 — 운영 매뉴얼')
    .setBackground('#0F172A')
    .setFontColor('#F8FAFC')
    .setFontSize(16)
    .setFontWeight('bold')
    .setHorizontalAlignment('center')
    .setVerticalAlignment('middle');
  sh.setRowHeight(r, 50);
  r++;

  sh.getRange(r, 1, 1, 6).merge()
    .setValue('확인요청 → 계약마스터 + 스케줄상세 → 개고생2.0 거래내역  |  자동화 버전')
    .setBackground('#1E293B')
    .setFontColor('#94A3B8')
    .setFontSize(10)
    .setHorizontalAlignment('center')
    .setVerticalAlignment('middle');
  sh.setRowHeight(r, 26);
  r++;
  blank(r++, 10);


  // ══════════════════════════════════════════════
  // 1. 전체 흐름
  // ══════════════════════════════════════════════
  sectionHeader(r++, '① 전체 프로세스 흐름');
  blank(r++, 8);

  sh.getRange(r, 2, 1, 4).merge()
    .setValue(
      '고객 문의  →  확인요청 입력  →  [H열] 가용 확인  →  [N열] 등록\n' +
      '                                                                    ↓\n' +
      '                              계약마스터 + 스케줄상세 + 개고생2.0 거래내역  →  계약서 자동생성  →  알림톡 발송'
    )
    .setBackground('#EFF6FF')
    .setFontSize(10)
    .setFontColor('#1E3A5F')
    .setFontWeight('bold')
    .setVerticalAlignment('middle')
    .setWrap(true);
  sh.setRowHeight(r, 56);
  r++;
  blank(r++, 10);


  // ══════════════════════════════════════════════
  // 2. 확인요청 시트 열 설명
  // ══════════════════════════════════════════════
  sectionHeader(r++, '② 확인요청 시트 — 열 구성');
  blank(r++, 8);
  tableHeader(r++, ['열', '내용', '입력 방법', '비고'], '#374151');

  const cols = [
    ['A열', '요청ID',   'B열 입력 시 자동생성 (RQ-YYMMDD-NNN)',  '수정 시: 기존 거래ID 직접 입력'],
    ['B열', '반출일',   '직접 입력',                              '날짜변경 시 새 날짜 입력'],
    ['C열', '반출시간', '직접 입력 (HH:MM)',                      ''],
    ['D열', '반납일',   '직접 입력',                              ''],
    ['E열', '반납시간', '직접 입력 (HH:MM)',                      ''],
    ['F열', '장비/세트명', '목록 드롭다운 선택',                  '세트 선택 시 구성품 자동 펼침'],
    ['G열', '수량',     '직접 입력 (기본 1)',                     '2개면 2 입력'],
    ['H열', '확인',     '드롭다운 → "확인" 선택',                 '→ 가용 여부 자동 체크 + I열에 결과'],
    ['I열', '결과',     '자동 입력',                              '✅ 가용N / ⚠️ 부족 / ❌ 불가'],
    ['J열', '상세',     '자동 입력',                              '겹치는 예약 정보'],
    ['K열', '예약자명', '직접 입력',                              ''],
    ['L열', '연락처',   '직접 입력',                              '알림톡 발송에 사용'],
    ['M열', '업체명',   '직접 입력 (선택)',                       ''],
    ['N열', '등록',     '드롭다운 선택',                          '등록 / 추가 / 삭제 / 날짜변경 / 거절 / 보류'],
    ['O열', '등록상태', '자동 입력',                              '등록완료 / ❌ 오류메시지'],
    ['P열', '거래ID',   '자동 입력',                              'YYMMDD-NNN 형식'],
    ['Q열', '비고',     '자동 입력',                              '세트 구성품 표시 등'],
  ];

  cols.forEach(function(c, i) {
    const bg = i % 2 === 0 ? '#FFFFFF' : '#F8FAFC';
    tableRow(r++, c, bg);
  });
  blank(r++, 10);


  // ══════════════════════════════════════════════
  // 3. 신규 예약 단계별
  // ══════════════════════════════════════════════
  sectionHeader(r++, '③ 신규 예약 — 단계별 가이드');
  blank(r++, 8);

  sh.getRange(r, 2).setValue('단계').setBackground('#4A5568').setFontColor('#fff').setFontWeight('bold').setHorizontalAlignment('center').setFontSize(10);
  sh.getRange(r, 3).setValue('할 일').setBackground('#4A5568').setFontColor('#fff').setFontWeight('bold').setFontSize(10);
  sh.getRange(r, 4).setValue('입력 내용').setBackground('#4A5568').setFontColor('#fff').setFontWeight('bold').setFontSize(10);
  sh.getRange(r, 5).setValue('자동 처리').setBackground('#4A5568').setFontColor('#fff').setFontWeight('bold').setFontSize(10);
  sh.setRowHeight(r++, 26);

  stepRow(r++, 'STEP 1', 'B~G열 + K~M열 입력',
    'B: 반출일 / C: 반출시간\nD: 반납일 / E: 반납시간\nF: 장비명 (드롭다운)\nG: 수량 / K: 예약자명\nL: 연락처 / M: 업체명',
    '→ A열 요청ID 자동생성\n→ 세트 선택 시 구성품 행 자동 추가', '#EBF8FF');

  stepRow(r++, 'STEP 2', 'H열 → "확인" 선택',
    '드롭다운에서 "확인" 선택',
    '→ I열에 가용 결과 자동 표시\n→ 알림톡 발송 (가용확인 결과)', '#EBF8FF');

  stepRow(r++, 'STEP 3', '[결과 확인] I열 체크',
    '✅ 가용 → 등록 진행\n⚠️ 부족/겹침 → 협의 후 결정\n❌ 불가 → 거절 또는 일정 변경',
    '', '#FFF5F5');

  stepRow(r++, 'STEP 4', 'N열 → "등록" 선택',
    '드롭다운에서 "등록" 선택',
    '→ 계약마스터 행 추가\n→ 스케줄상세 장비별 행 추가\n→ 개고생2.0 거래내역 행 추가\n→ 계약서 자동 생성\n→ 알림톡 발송 (예약확정)', '#EBF8FF');

  noteRow(r++, '⚠️  N열 "등록"은 installable 트리거 필요 — GAS 에디터에서 setupInstallableTrigger() 최초 1회 실행 필수');
  blank(r++, 10);


  // ══════════════════════════════════════════════
  // 4. 수정 프로세스
  // ══════════════════════════════════════════════
  sectionHeader(r++, '④ 예약 수정 — 장비 추가 / 삭제 / 날짜변경');
  blank(r++, 8);
  noteRow(r++, '📌  수정 시에는 A열에 기존 요청ID(RQ-...) 대신 거래ID(YYMMDD-NNN)를 직접 입력합니다', '#EFF6FF');
  blank(r++, 6);

  // 추가
  subHeader(r++, '  장비 추가', '#2B6CB0');
  sh.getRange(r, 2).setValue('할 일').setBackground('#BEE3F8').setFontWeight('bold').setFontSize(10).setVerticalAlignment('middle');
  sh.getRange(r, 3).setValue('입력 내용').setBackground('#BEE3F8').setFontWeight('bold').setFontSize(10).setVerticalAlignment('middle');
  sh.getRange(r, 4, 1, 2).merge().setValue('자동 처리').setBackground('#BEE3F8').setFontWeight('bold').setFontSize(10).setVerticalAlignment('middle');
  sh.setRowHeight(r++, 24);

  tableRow(r++, ['A열에 거래ID 입력', 'A: 기존 거래ID (예: 260329-001)\nF: 추가할 장비명 / G: 수량', ''], '#F0F9FF');
  tableRow(r++, ['H열 → "확인" 선택', '기존 날짜 자동 참조하여 가용 확인', '→ I열에 가용 결과 표시'], '#F0F9FF');
  tableRow(r++, ['N열 → "추가" 선택', 'I열이 ✅ 인 경우에만 진행',
    '→ 스케줄상세에 장비 1행 추가\n→ 기존 계약서 삭제 + 재생성'], '#F0F9FF');
  blank(r++, 8);

  // 삭제
  subHeader(r++, '  장비 삭제', '#C05621');
  sh.getRange(r, 2).setValue('할 일').setBackground('#FEEBC8').setFontWeight('bold').setFontSize(10).setVerticalAlignment('middle');
  sh.getRange(r, 3).setValue('입력 내용').setBackground('#FEEBC8').setFontWeight('bold').setFontSize(10).setVerticalAlignment('middle');
  sh.getRange(r, 4, 1, 2).merge().setValue('자동 처리').setBackground('#FEEBC8').setFontWeight('bold').setFontSize(10).setVerticalAlignment('middle');
  sh.setRowHeight(r++, 24);

  tableRow(r++, ['A열에 거래ID 입력', 'A: 기존 거래ID\nF: 삭제할 장비명', ''], '#FFFAF0');
  tableRow(r++, ['N열 → "삭제" 선택', '가용 확인 불필요, 바로 선택',
    '→ 스케줄상세에서 해당 장비 행 제거\n→ 기존 계약서 삭제 + 재생성'], '#FFFAF0');
  blank(r++, 8);

  // 날짜변경
  subHeader(r++, '  날짜 변경', '#276749');
  sh.getRange(r, 2).setValue('할 일').setBackground('#C6F6D5').setFontWeight('bold').setFontSize(10).setVerticalAlignment('middle');
  sh.getRange(r, 3).setValue('입력 내용').setBackground('#C6F6D5').setFontWeight('bold').setFontSize(10).setVerticalAlignment('middle');
  sh.getRange(r, 4, 1, 2).merge().setValue('자동 처리').setBackground('#C6F6D5').setFontWeight('bold').setFontSize(10).setVerticalAlignment('middle');
  sh.setRowHeight(r++, 24);

  tableRow(r++, ['A열에 거래ID 입력\nB~E열에 새 날짜 입력',
    'A: 기존 거래ID\nB: 새 반출일 / C: 새 반출시간\nD: 새 반납일 / E: 새 반납시간', ''], '#F0FFF4');
  tableRow(r++, ['N열 → "날짜변경" 선택', '가용 확인 불필요, 바로 선택',
    '→ 계약마스터 날짜 수정\n→ 스케줄상세 전체 행 날짜 수정\n→ 개고생2.0 반출일 수정\n→ 새 날짜 기준 전체 장비 가용 자동 체크\n→ 기존 계약서 삭제 + 재생성\n→ O열에 결과 표시 (불가 장비 있으면 노랑)'], '#F0FFF4');
  noteRow(r++, '💡  날짜변경 후 불가 장비가 O열에 표시되면 → 해당 장비를 N열 "삭제"로 제거하세요', '#F0FFF4');
  blank(r++, 10);


  // ══════════════════════════════════════════════
  // 5. N열 드롭다운 값 설명
  // ══════════════════════════════════════════════
  sectionHeader(r++, '⑤ N열 드롭다운 값 — 상세 설명');
  blank(r++, 8);
  tableHeader(r++, ['값', '동작', '조건', '비고'], '#374151');

  const nVals = [
    ['등록',     '신규 예약 확정',              'I열 ✅ 확인 후',        '계약마스터 + 스케줄상세 + 거래내역 + 계약서 + 알림톡'],
    ['추가',     '기존 예약에 장비 1개 추가',   'H열 확인 + I열 ✅ 후',  '스케줄상세 행 추가 + 계약서 재생성'],
    ['삭제',     '기존 예약에서 장비 1개 제거', '조건 없음',             '스케줄상세 행 삭제 + 계약서 재생성'],
    ['날짜변경', '반출/반납 일시 전체 수정',    'B~E열 새 날짜 입력 후', '전체 시트 날짜 수정 + 가용 재확인 + 계약서 재생성'],
    ['거절',     '예약 거절 처리',              '조건 없음',             'O열 "거절" 빨간색 표시'],
    ['보류',     '예약 보류 처리',              '조건 없음',             'O열 "보류" 노란색 표시'],
  ];

  nVals.forEach(function(v, i) {
    const bg = i % 2 === 0 ? '#FFFFFF' : '#F8FAFC';
    tableRow(r++, v, bg);
  });
  blank(r++, 10);


  // ══════════════════════════════════════════════
  // 6. 타임라인
  // ══════════════════════════════════════════════
  sectionHeader(r++, '⑥ 타임라인 보기');
  blank(r++, 8);

  tableHeader(r++, ['기능', '방법', '설명', ''], '#374151');
  const tlItems = [
    ['타임라인 열기',  '메뉴 → 📋 빌리지 스케줄 → 📊 타임라인 보기', '스케줄상세 전체 시각화', ''],
    ['장비 검색',     '검색창에 장비명 입력',                         '해당 장비 타임라인만 표시', ''],
    ['진행중만 보기', '"진행중" 버튼 클릭',                            '대기/반출중 상태만 필터', ''],
    ['날짜 이동',     '"오늘" 버튼',                                  '현재 날짜 기준으로 이동', ''],
    ['확대/축소',     '"확대 +" / "축소 −" 버튼 또는 마우스 휠',       '시간 범위 조절', ''],
    ['상세 보기',     '타임라인 바에 마우스 올리기',                   '거래ID / 예약자 / 날짜 / 상태 툴팁 표시', ''],
  ];
  tlItems.forEach(function(v, i) {
    const bg = i % 2 === 0 ? '#FFFFFF' : '#F8FAFC';
    tableRow(r++, v, bg);
  });
  blank(r++, 10);


  // ══════════════════════════════════════════════
  // 7. 색상 범례 (타임라인)
  // ══════════════════════════════════════════════
  sectionHeader(r++, '⑦ 타임라인 색상 범례');
  blank(r++, 8);

  const colors = [
    ['대기',     '#3B82F6', '#DBEAFE'],
    ['반출중',   '#F59E0B', '#FEF3C7'],
    ['반납완료', '#10B981', '#D1FAE5'],
    ['취소',     '#9CA3AF', '#F3F4F6'],
    ['기타',     '#8B5CF6', '#EDE9FE'],
  ];

  colors.forEach(function(c) {
    sh.getRange(r, 2).setValue('').setBackground(c[1]).setFontColor('#fff');
    sh.getRange(r, 3).setValue(c[0]).setBackground(c[2]).setFontSize(11).setFontWeight('bold').setVerticalAlignment('middle');
    sh.getRange(r, 4, 1, 2).merge().setBackground('#FFFFFF');
    sh.setRowHeight(r++, 28);
  });
  blank(r++, 10);


  // ══════════════════════════════════════════════
  // 8. 초기 설정 체크리스트
  // ══════════════════════════════════════════════
  sectionHeader(r++, '⑧ 초기 설정 체크리스트 (최초 1회)');
  blank(r++, 8);

  tableHeader(r++, ['#', '항목', '방법', ''], '#374151');
  const setup = [
    ['□', 'installable 트리거 등록',  'GAS 에디터 → setupInstallableTrigger() 실행',  '이거 안 하면 N열 등록/추가/삭제/날짜변경 작동 안 함'],
    ['□', 'N열 드롭다운 항목 추가',   '구글 시트 → 데이터 유효성 → 등록,추가,삭제,날짜변경,거절,보류 추가', ''],
    ['□', 'CONTRACT_TEMPLATE_ID 설정', 'GAS 에디터 → 프로젝트 설정 → 스크립트 속성',  '계약서 템플릿 파일 ID'],
    ['□', 'CONTRACT_FOLDER_ID 설정',  'GAS 에디터 → 프로젝트 설정 → 스크립트 속성',  '계약서 저장 폴더 ID'],
    ['□', '개고생2_URL 설정',         'GAS 에디터 → 프로젝트 설정 → 스크립트 속성',  '개고생2.0 스프레드시트 URL'],
  ];
  setup.forEach(function(v, i) {
    const bg = i % 2 === 0 ? '#FFFFFF' : '#F8FAFC';
    tableRow(r++, v, bg);
  });
  blank(r++, 10);


  // ══════════════════════════════════════════════
  // 9. 자주 묻는 질문
  // ══════════════════════════════════════════════
  sectionHeader(r++, '⑨ 주요 주의사항');
  blank(r++, 8);

  const notes = [
    ['세트 선택 시',        'F열에서 세트명 선택 후 H열 "확인" → 구성품 행 자동 추가됨. 구성품 행은 직접 수정 금지'],
    ['N열 "추가" 차단',     'H열 확인을 먼저 하지 않으면 I열 ✅ 없어서 추가 차단됨. 반드시 H열 → N열 순서로'],
    ['날짜변경 후 불가 장비', 'O열에 노랑으로 불가 장비 표시 → N열 "삭제"로 제거 후 고객에게 안내'],
    ['계약서 재생성',        '추가/삭제/날짜변경 모두 기존 계약서 자동 삭제 후 새로 생성됨'],
    ['개고생2.0 거래내역',   '장비 추가/삭제 시 거래내역은 변경 없음 (날짜변경 시 반출일만 수정됨)'],
    ['알림톡 발송',          '"등록" 시 예약확정 알림톡 자동 발송. 수정 시에는 알림톡 없음 — 필요 시 수동 발송'],
  ];
  notes.forEach(function(v, i) {
    const bg = i % 2 === 0 ? '#FFFBEB' : '#FFF8E1';
    sh.getRange(r, 2).setValue('⚠️  ' + v[0])
      .setBackground(bg).setFontWeight('bold').setFontSize(10).setVerticalAlignment('middle').setWrap(true);
    sh.getRange(r, 3, 1, 3).merge().setValue(v[1])
      .setBackground(bg).setFontSize(10).setVerticalAlignment('middle').setWrap(true)
      .setFontColor('#78350F');
    sh.setRowHeight(r++, 36);
  });

  blank(r++, 16);

  // Footer
  sh.getRange(r, 1, 1, 6).merge()
    .setValue('자동 생성됨  |  빌리지 GAS 시스템  |  메뉴 → 빌리지 스케줄 → 매뉴얼 생성으로 언제든 재생성 가능')
    .setBackground('#1E293B')
    .setFontColor('#64748B')
    .setFontSize(9)
    .setHorizontalAlignment('center')
    .setVerticalAlignment('middle');
  sh.setRowHeight(r, 24);

  // 전체 테두리
  sh.getRange(1, 1, r, 6).setBorder(false, false, false, false, false, false);

  // 완료 알림
  SpreadsheetApp.getUi().alert('✅ 매뉴얼 시트가 생성됐습니다!\n"📋 매뉴얼" 탭을 확인하세요.');
}
