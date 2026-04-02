/**
 * ====================================================================
 * generateContract.gs — 빌리지 계약서 자동 생성 (드라이브 파일)
 * ====================================================================
 *
 * 계약마스터 + 스케줄상세 데이터를 읽어서
 * "계약서_템플릿" 스프레드시트를 복사 → 데이터 채움 → 지정 폴더에 저장
 *
 * ★ 사전 설정 (스크립트 속성 — 프로젝트 설정):
 *   CONTRACT_TEMPLATE_ID : 계약서 템플릿 스프레드시트 파일 ID
 *   CONTRACT_FOLDER_ID   : 계약서 저장할 구글 드라이브 폴더 ID
 *   개고생2_URL           : 개고생2.0 스프레드시트 URL (기존과 동일)
 *
 * ★ 이 파일을 Apps Script에 새 파일로 추가하세요 ★
 */


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 메뉴에서 호출
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function createContractFromMenu() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const ui = SpreadsheetApp.getUi();
  const sheet = ss.getActiveSheet();
  const sheetName = sheet.getName();
  const row = sheet.getActiveCell().getRow();

  let 거래ID;

  if (sheetName === "확인요청") {
    거래ID = sheet.getRange(row, 16).getValue(); // P열: 거래ID
    if (!거래ID) {
      ui.alert("❌ 선택한 행에 거래ID가 없습니다.\n먼저 예약 등록을 완료하세요.");
      return;
    }
  } else if (sheetName === "계약마스터") {
    거래ID = sheet.getRange(row, 1).getValue(); // A열: 거래ID
    if (!거래ID) {
      ui.alert("❌ 선택한 행에 거래ID가 없습니다.");
      return;
    }
  } else {
    const response = ui.prompt("📄 계약서 생성", "거래ID를 입력하세요:", ui.ButtonSet.OK_CANCEL);
    if (response.getSelectedButton() !== ui.Button.OK) return;
    거래ID = response.getResponseText().trim();
    if (!거래ID) return;
  }

  try {
    const result = generateContractFile(ss, 거래ID);
    ui.alert(
      `✅ 계약서 생성 완료!\n\n` +
      `파일명: ${result.fileName}\n` +
      `링크: ${result.url}\n\n` +
      `인쇄: 파일 열기 → Ctrl+P → A4 세로`
    );
  } catch (err) {
    ui.alert("❌ 계약서 생성 실패:\n" + err.message);
  }
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 핵심: 계약서 파일 생성
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * 계약서 파일 생성
 * @param {Spreadsheet} ss - 현재 스프레드시트
 * @param {string} 거래ID
 * @returns {Object} { fileName, url, fileId }
 */
function generateContractFile(ss, 거래ID, 추가요청) {
  const props = PropertiesService.getScriptProperties();

  // ── 설정값 가져오기 ──
  const templateId = props.getProperty("CONTRACT_TEMPLATE_ID");
  const folderId = props.getProperty("CONTRACT_FOLDER_ID");

  if (!templateId) {
    throw new Error(
      "계약서 템플릿 ID가 설정되지 않았습니다.\n" +
      "프로젝트 설정 → 스크립트 속성 → CONTRACT_TEMPLATE_ID에\n" +
      "계약서 템플릿 스프레드시트의 파일 ID를 입력하세요."
    );
  }

  // ── 계약마스터에서 데이터 조회 ──
  const contractSheet = ss.getSheetByName("계약마스터");
  if (!contractSheet) throw new Error("계약마스터 시트가 없습니다.");

  const contractLastRow = contractSheet.getLastRow();
  if (contractLastRow < 2) throw new Error("계약마스터에 데이터가 없습니다.");

  const contractData = contractSheet.getRange(2, 1, contractLastRow - 1, 11).getValues();
  // A:거래ID, B:예약자명, C:연락처, D:업체명, E:반출일, F:반출시간, G:반납일, H:반납시간, I:비고, J:상태, K:메모

  let contract = null;
  for (let i = 0; i < contractData.length; i++) {
    if (contractData[i][0] === 거래ID) {
      contract = {
        거래ID: contractData[i][0],
        예약자명: contractData[i][1] || "",
        연락처: contractData[i][2] || "",
        업체명: contractData[i][3] || "",
        반출일: contractData[i][4],
        반출시간: contractData[i][5],
        반납일: contractData[i][6],
        반납시간: contractData[i][7],
      };
      break;
    }
  }
  if (!contract) throw new Error(`거래ID "${거래ID}"를 계약마스터에서 찾을 수 없습니다.`);

  // ── 스케줄상세에서 품목 조회 (단가 포함) ──
  const schedSheet = ss.getSheetByName("스케줄상세");
  const items = [];
  if (schedSheet && schedSheet.getLastRow() >= 2) {
    const schedData = schedSheet.getRange(2, 1, schedSheet.getLastRow() - 1, 12).getValues();
    // A:스케줄ID, B:거래ID, C:세트명, D:장비명, E:수량, ..., L:단가(col12)
    schedData.forEach(row => {
      if (row[1] === 거래ID) {
        items.push({
          세트명: row[2] || "",
          장비명: row[3] || "",
          수량: row[4] || 1,
          단가: row[11] || 0
        });
      }
    });
  }

  // ── 템플릿 복사 ──
  const templateFile = DriveApp.getFileById(templateId);
  const fileName = `계약서_${거래ID}_${contract.예약자명}`;

  let newFile;
  if (folderId) {
    const folder = DriveApp.getFolderById(folderId);
    newFile = templateFile.makeCopy(fileName, folder);
  } else {
    // 폴더 미설정 시 템플릿과 같은 위치에 생성
    newFile = templateFile.makeCopy(fileName);
  }

  const newFileId = newFile.getId();
  const newUrl = newFile.getUrl();

  // ── 복사한 파일 열어서 데이터 채우기 ──
  const newSS = SpreadsheetApp.openById(newFileId);
  const ws = newSS.getSheets()[0]; // 첫 번째 시트

  // ★ 템플릿 행 위치 (계약서_템플릿.xlsx 구조 기준)
  // 이 값들은 템플릿 구조에 맞게 조정해야 합니다
  // findRow() 로 자동 탐색
  const rows = findTemplateRows(ws);

  // ── 임차인 정보 (기존 템플릿 구조) ──
  // Row 8: 임차인 | 예약자(상호) → C열 | 연락처 → I열 부근
  // Row 9: 계약자(상호) → C열
  ws.getRange(rows.lessee1, 3).setValue(contract.예약자명);       // C: 예약자(상호)
  if (rows.contactCol) {
    ws.getRange(rows.lessee1, rows.contactCol).setValue(contract.연락처);  // 연락처
  }
  ws.getRange(rows.lessee2, 3).setValue(contract.업체명 || contract.예약자명);  // C: 계약자(상호)

  // ── 대여기간 ──
  const 반출일시 = formatContractDT(contract.반출일, contract.반출시간);
  const 반납일시 = formatContractDT(contract.반납일, contract.반납시간);
  ws.getRange(rows.rentalStart, 3).setValue(반출일시);            // C: 대여일자

  // 대여일수 계산 (24시간=1일, 6시간 이내 초과는 같은 일수, 초과 시 +1일)
  const 일수 = calcRentalDays(contract.반출일, contract.반출시간, contract.반납일, contract.반납시간);

  // 반납일자(예정) — rentalStart+1
  ws.getRange(rows.rentalStart + 1, 3).setValue(반납일시);        // C: 반납일자(예정)

  // ── 품목 채우기 (좌우 분할 테이블) ──
  // 템플릿에서 B+C, H+I 이미 병합됨 (SET열 제거)
  //   좌측: B(품목, 병합), D(수량), E(일수), F(단가) — G(금액)은 수식 자동계산
  //   우측: H(품목, 병합), J(수량), K(일수), L(단가) — M(금액)은 수식 자동계산
  const ITEMS_PER_SIDE = rows.itemRows || 22;  // 한 쪽 행 수

  for (let i = 0; i < items.length && i < ITEMS_PER_SIDE * 2; i++) {
    const item = items[i];
    let row, nameCol, qtyCol, dayCol, priceCol;

    if (i < ITEMS_PER_SIDE) {
      // 좌측: B(병합된 품목), D(수량), E(일수), F(단가)
      row = rows.itemStart + i;
      nameCol = 2; qtyCol = 4; dayCol = 5; priceCol = 6;
    } else {
      // 우측: H(병합된 품목), J(수량), K(일수), L(단가)
      row = rows.itemStart + (i - ITEMS_PER_SIDE);
      nameCol = 8; qtyCol = 10; dayCol = 11; priceCol = 12;
    }

    ws.getRange(row, nameCol).setValue(item.장비명);
    ws.getRange(row, qtyCol).setValue(item.수량);
    ws.getRange(row, dayCol).setValue(일수);
    ws.getRange(row, priceCol).setValue(item.단가);
    // 서식 통일 (굵은 글씨 해제)
    ws.getRange(row, nameCol, 1, priceCol - nameCol + 1).setFontWeight("normal");

    // 세트 헤더 행이면 연한 초록 배경 + 굵은 글씨
    if (item.세트명 && item.장비명 === item.세트명) {
      ws.getRange(row, nameCol).setBackground("#D9EAD3").setFontWeight("bold");
    }
    // ※ 금액(G열/M열)은 템플릿 수식이 자동 계산 → 건드리지 않음
  }

  // ── 추가요청(악세사리 등) 품목 뒤에 추가 ──
  if (추가요청) {
    var 추가items = 추가요청.split("\n").filter(function(s) { return s.trim(); });
    var nextIdx = items.length;
    for (var ai = 0; ai < 추가items.length && nextIdx < ITEMS_PER_SIDE * 2; ai++) {
      var row, nameCol, qtyCol;
      if (nextIdx < ITEMS_PER_SIDE) {
        row = rows.itemStart + nextIdx;
        nameCol = 2; qtyCol = 4;  // B(병합), D
      } else {
        row = rows.itemStart + (nextIdx - ITEMS_PER_SIDE);
        nameCol = 8; qtyCol = 10;  // H(병합), J
      }
      ws.getRange(row, nameCol).setValue(추가items[ai].trim());
      ws.getRange(row, qtyCol).setValue(1);
      nextIdx++;
    }
  }

  // ── 장기할인 ──
  if (일수 >= 2) {
    const 할인율 = getLongTermDiscountRate(일수);
    if (할인율 > 0) {
      // 템플릿에서 "장기할인" 또는 "할인" 텍스트가 있는 셀 찾기
      const lastRow = ws.getLastRow();
      const allData = ws.getRange(1, 1, lastRow, 14).getValues();
      for (let i = 0; i < allData.length; i++) {
        const rowText = allData[i].join("|");
        if (rowText.includes("장기할인") || rowText.includes("장기 할인")) {
          // 같은 행에서 빈 셀 또는 숫자 셀 찾아서 할인율 입력
          for (let c = 0; c < allData[i].length; c++) {
            if (String(allData[i][c]).includes("장기할인") || String(allData[i][c]).includes("장기 할인")) {
              // 할인율 텍스트 옆 셀 또는 같은 행 숫자 영역에 입력
              ws.getRange(i + 1, c + 2).setValue(할인율 + "%");
              break;
            }
          }
          break;
        }
      }
    }
  }

  // ── 계약일자 ──
  const today = new Date();
  const dateStr = `${today.getFullYear()}년 ${today.getMonth() + 1}월 ${today.getDate()}일`;
  if (rows.signDate) {
    ws.getRange(rows.signDate, 5).setValue(dateStr);
  }

  // ── 임차인 서명란 ──
  if (rows.signLessee) {
    ws.getRange(rows.signLessee, 5).setValue(contract.예약자명 + "  (서명 또는 인)");
  }

  // 저장
  SpreadsheetApp.flush();

  // ── 개고생2.0 거래내역 M열에 계약서 링크 입력 ──
  updateContractLink(거래ID, newUrl);

  return { fileName: fileName, url: newUrl, fileId: newFileId };
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 템플릿 행 위치 자동 탐색
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function findTemplateRows(ws) {
  const lastRow = ws.getLastRow();
  const data = ws.getRange(1, 1, lastRow, 14).getValues();

  const result = {
    lessee1: null,      // 예약자(상호) 행
    lessee2: null,      // 계약자(상호) 행
    contactCol: null,    // 연락처 열 번호
    rentalStart: null,   // 대여기간 첫 행 (대여일자)
    itemStart: null,     // 품목 데이터 시작 행
    itemRows: null,      // 한 쪽 품목 행 수
    signDate: null,      // 계약일자 행
    signLessee: null,    // 임차인 서명 행
  };

  let itemHeaderRow = null;   // 품목 헤더 행 (SET|품목 등)
  let cableRow = null;        // 라인/기타 행 (품목 끝 판별용)

  for (let i = 0; i < data.length; i++) {
    const rowText = data[i].join("|");

    if (rowText.includes("예약자") && rowText.includes("상호") && !result.lessee1) {
      result.lessee1 = i + 1;
      // 연락처 열 찾기 — 라벨 이후 첫 번째 빈 셀에 값 입력
      for (let c = 0; c < data[i].length; c++) {
        if (String(data[i][c]).includes("연락처")) {
          // 연락처 라벨 뒤에서 빈 셀 찾기
          for (let v = c + 1; v < data[i].length; v++) {
            if (!data[i][v] || String(data[i][v]).trim() === "") {
              result.contactCol = v + 1;  // 1-based
              break;
            }
          }
          if (!result.contactCol) result.contactCol = c + 2;  // fallback
          break;
        }
      }
    }
    if (rowText.includes("계약자") && rowText.includes("상호") && !result.lessee2) {
      result.lessee2 = i + 1;
    }
    if (rowText.includes("대여일자") && !result.rentalStart) {
      result.rentalStart = i + 1;
    }
    if (rowText.includes("품목") && (rowText.includes("SET") || rowText.includes("수량")) && !itemHeaderRow) {
      itemHeaderRow = i + 1;
      result.itemStart = i + 2;  // 헤더 다음 행
    }
    if ((rowText.includes("라인") || rowText.includes("HDMI") || rowText.includes("기타") || rowText.includes("합계") || rowText.includes("특이사항") || rowText.includes("W/O")) && itemHeaderRow && !cableRow) {
      cableRow = i + 1;
    }
    if (rowText.includes("계약일자") && !result.signDate) {
      result.signDate = i + 1;
    }
    if (rowText.includes("임차인") && rowText.includes("서명") && !result.signLessee) {
      result.signLessee = i + 1;
    }
  }

  // 품목 행 수 계산: 헤더 다음 ~ 라인/기타 행 직전
  if (result.itemStart && cableRow) {
    result.itemRows = cableRow - result.itemStart;
  }

  // 못 찾은 경우 기본값 (기존 빌리지 계약서 템플릿 기준)
  if (!result.lessee1) result.lessee1 = 8;
  if (!result.lessee2) result.lessee2 = 9;
  if (!result.contactCol) result.contactCol = 6;  // F열

  Logger.log("findTemplateRows 결과: " + JSON.stringify(result));
  if (!result.rentalStart) result.rentalStart = 10;
  if (!result.itemStart) result.itemStart = 14;
  if (!result.itemRows) result.itemRows = 22;
  if (!result.signDate) result.signDate = 54;
  if (!result.signLessee) result.signLessee = 55;

  return result;
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 개고생2.0 거래내역 M열 계약서 링크 입력
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function updateContractLink(거래ID, contractUrl) {
  try {
    const props = PropertiesService.getScriptProperties();
    const 개고생URL = props.getProperty("개고생2_URL");
    if (!개고생URL) return;

    const 개고생SS = SpreadsheetApp.openByUrl(개고생URL);
    const 거래시트 = 개고생SS.getSheetByName("거래내역");
    if (!거래시트) return;

    const lastRow = 거래시트.getLastRow();
    if (lastRow < 2) return;

    // 거래ID가 있는 행 찾기 (D열=4번째 열)
    const ids = 거래시트.getRange(2, 4, lastRow - 1, 1).getValues();
    for (let i = 0; i < ids.length; i++) {
      if (ids[i][0] === 거래ID) {
        // M열(13)에 계약서 링크 입력
        거래시트.getRange(i + 2, 13).setValue(contractUrl);
        Logger.log("개고생2.0 거래내역 M열 계약서 링크 입력 완료: " + 거래ID);
        return;
      }
    }

    Logger.log("개고생2.0에서 거래ID를 찾을 수 없음: " + 거래ID);
  } catch (err) {
    Logger.log("개고생2.0 계약서 링크 입력 실패: " + err.message);
  }
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 기존 계약서 삭제 후 재생성
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * 기존 계약서 파일 삭제 후 새로 생성
 * @param {Spreadsheet} ss
 * @param {string} 거래ID
 * @returns {Object} { fileName, url, fileId }
 */
function deleteAndRegenerateContract(ss, 거래ID) {
  const props = PropertiesService.getScriptProperties();
  const folderId = props.getProperty("CONTRACT_FOLDER_ID");
  const fileName = `계약서_${거래ID}_`;

  // 기존 파일 휴지통으로 이동
  try {
    if (folderId) {
      const folder = DriveApp.getFolderById(folderId);
      const files = folder.getFilesByName(
        folder.getFiles() // 파일명이 정확히 일치하지 않으므로 전체 탐색
      );
      // 파일명 prefix로 검색
      const iter = folder.getFiles();
      while (iter.hasNext()) {
        const f = iter.next();
        if (f.getName().indexOf(fileName) === 0) {
          f.setTrashed(true);
          Logger.log("기존 계약서 삭제: " + f.getName());
        }
      }
    } else {
      // 폴더 미설정 시 Drive 전체에서 검색
      const iter = DriveApp.getFilesByName(fileName);
      // prefix 검색은 DriveApp에서 안 되므로 패턴으로 시도
      const searchIter = DriveApp.searchFiles(`title contains '${fileName}'`);
      while (searchIter.hasNext()) {
        const f = searchIter.next();
        if (f.getName().indexOf(fileName) === 0) {
          f.setTrashed(true);
          Logger.log("기존 계약서 삭제: " + f.getName());
        }
      }
    }
  } catch (err) {
    Logger.log("기존 계약서 삭제 실패 (계속 진행): " + err.message);
  }

  // 개고생2.0 M열 링크 초기화
  try {
    const 개고생URL = props.getProperty("개고생2_URL");
    if (개고생URL) {
      const 거래시트 = SpreadsheetApp.openByUrl(개고생URL).getSheetByName("거래내역");
      if (거래시트) {
        const ids = 거래시트.getRange(2, 4, Math.max(1, 거래시트.getLastRow() - 1), 1).getValues();
        for (let i = 0; i < ids.length; i++) {
          if (ids[i][0] === 거래ID) {
            거래시트.getRange(i + 2, 13).clearContent();
            break;
          }
        }
      }
    }
  } catch (err) { Logger.log("M열 초기화 실패: " + err.message); }

  return generateContractFile(ss, 거래ID);
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 유틸리티
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * 대여일수 계산
 * 24시간 = 1일, 6시간 이내 초과 = 같은 일수, 6시간 초과 = +1일
 * 예: 30시간=1일, 31시간=2일, 54시간=2일, 55시간=3일
 */
/**
 * 장기할인율 계산 (대여 일수 기준)
 * 1일: 0% / 2일: 10% / 3~5일: 20% / 6~9일: 35%
 * 10~14일: 40% / 15~19일: 45% / 20일~: 50%
 */
function getLongTermDiscountRate(days) {
  if (days >= 20) return 50;
  if (days >= 15) return 45;
  if (days >= 10) return 40;
  if (days >= 6)  return 35;
  if (days >= 3)  return 20;
  if (days >= 2)  return 10;
  return 0;
}

function calcRentalDays(반출일, 반출시간, 반납일, 반납시간) {
  const startDT = combineDT_contract(반출일, 반출시간);
  const endDT = combineDT_contract(반납일, 반납시간);
  if (!startDT || !endDT || endDT <= startDT) return 1;

  const totalHours = (endDT - startDT) / (1000 * 60 * 60);
  return Math.max(1, Math.ceil((totalHours - 6) / 24));
}

/**
 * 날짜+시간 합치기 (generateContract 전용)
 */
function combineDT_contract(date, time) {
  if (!date) return null;
  try {
    const d = new Date(date);
    if (isNaN(d.getTime())) return null;
    if (time) {
      const t = new Date(time);
      if (!isNaN(t.getTime())) {
        d.setHours(t.getHours(), t.getMinutes(), 0, 0);
      } else if (typeof time === "string") {
        const parts = time.split(":");
        if (parts.length >= 2) {
          d.setHours(parseInt(parts[0]), parseInt(parts[1]), 0, 0);
        }
      }
    }
    return d;
  } catch (e) {
    return null;
  }
}


function formatContractDT(date, time) {
  if (!date) return "";
  const d = new Date(date);
  if (isNaN(d.getTime())) return date.toString();

  let result = `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
  if (time) {
    if (typeof time === "string") {
      result += ` ${time}`;
    } else {
      const t = new Date(time);
      if (!isNaN(t.getTime())) {
        result += ` ${t.getHours()}:${String(t.getMinutes()).padStart(2, "0")}`;
      }
    }
  }
  return result;
}


/**
 * 등록 완료 후 자동 계약서 생성 (registerByReqID에서 호출)
 * 팝업 없이 조용히 생성
 */
function autoGenerateContract(ss, 거래ID) {
  try {
    const props = PropertiesService.getScriptProperties();
    const templateId = props.getProperty("CONTRACT_TEMPLATE_ID");
    if (!templateId) return; // 템플릿 설정 안 돼있으면 스킵

    generateContractFile(ss, 거래ID);
    Logger.log("계약서 자동 생성 완료: " + 거래ID);
  } catch (err) {
    Logger.log("계약서 자동 생성 실패: " + err.message);
  }
}


/**
 * ★ 초기 설정 도우미 ★
 * 이 함수를 실행하면 필요한 스크립트 속성을 대화형으로 설정합니다.
 */
function setupContractSettings() {
  const ui = SpreadsheetApp.getUi();
  const props = PropertiesService.getScriptProperties();

  // 1) 템플릿 ID
  const current1 = props.getProperty("CONTRACT_TEMPLATE_ID") || "(미설정)";
  const r1 = ui.prompt(
    "📄 계약서 템플릿 설정 (1/2)",
    `계약서 템플릿 스프레드시트의 파일 ID를 입력하세요.\n\n` +
    `(URL에서 /d/ 와 /edit 사이의 긴 문자열)\n` +
    `예: 1ABC...xyz\n\n` +
    `현재: ${current1}`,
    ui.ButtonSet.OK_CANCEL
  );
  if (r1.getSelectedButton() === ui.Button.OK && r1.getResponseText().trim()) {
    props.setProperty("CONTRACT_TEMPLATE_ID", r1.getResponseText().trim());
  }

  // 2) 저장 폴더 ID
  const current2 = props.getProperty("CONTRACT_FOLDER_ID") || "(미설정 — 기본 위치에 저장)";
  const r2 = ui.prompt(
    "📁 계약서 저장 폴더 설정 (2/2)",
    `계약서를 저장할 구글 드라이브 폴더 ID를 입력하세요.\n\n` +
    `(폴더 URL에서 /folders/ 뒤의 문자열)\n` +
    `비워두면 기본 위치(내 드라이브)에 저장됩니다.\n\n` +
    `현재: ${current2}`,
    ui.ButtonSet.OK_CANCEL
  );
  if (r2.getSelectedButton() === ui.Button.OK && r2.getResponseText().trim()) {
    props.setProperty("CONTRACT_FOLDER_ID", r2.getResponseText().trim());
  }

  ui.alert(
    "✅ 계약서 설정 완료!\n\n" +
    `템플릿 ID: ${props.getProperty("CONTRACT_TEMPLATE_ID") || "(미설정)"}\n` +
    `저장 폴더: ${props.getProperty("CONTRACT_FOLDER_ID") || "(기본 위치)"}\n\n` +
    "이제 메뉴 → 📄 계약서 생성으로 사용하실 수 있습니다."
  );
}