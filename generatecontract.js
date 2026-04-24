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
    거래ID = String(sheet.getRange(row, 16).getValue()).trim(); // P열: 거래ID
    if (!거래ID) {
      ui.alert("❌ 선택한 행에 거래ID가 없습니다.\n먼저 예약 등록을 완료하세요.");
      return;
    }
  } else if (sheetName === "계약마스터") {
    거래ID = String(sheet.getRange(row, 1).getValue()).trim(); // A열: 거래ID
    if (!거래ID) {
      ui.alert("❌ 선택한 행에 거래ID가 없습니다.");
      return;
    }
  } else if (sheetName === "스케줄상세") {
    거래ID = String(sheet.getRange(row, 2).getValue()).trim(); // B열: 거래ID
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

  // 즉시 토스트로 진행 안내 (최종 결과는 alert로)
  ss.toast("계약서 생성/재생성 중... (30초 정도)", "⏳ " + 거래ID, 40);

  try {
    // 기존 파일 있으면 삭제 후 새로 생성 → 신규든 재생성이든 동일하게 처리
    const result = deleteAndRegenerateContract(ss, 거래ID);
    // 디바운스 대기 큐에 쌓여있었다면 정리
    try { PropertiesService.getScriptProperties().deleteProperty('contractEditTS_' + 거래ID); } catch (e) {}
    ss.toast("✅ 완료", "계약서 " + 거래ID, 5);
    ui.alert(
      `✅ 계약서 생성 완료!\n\n` +
      `파일명: ${result.fileName}\n` +
      `링크: ${result.url}\n\n` +
      `인쇄: 파일 열기 → Ctrl+P → A4 세로`
    );
  } catch (err) {
    ss.toast("❌ 실패", "계약서 " + 거래ID, 5);
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

  const contractData = contractSheet.getRange(2, 1, contractLastRow - 1, 12).getValues();
  const contractDisplay = contractSheet.getRange(2, 1, contractLastRow - 1, 12).getDisplayValues();
  // A:거래ID, B:예약자명, C:연락처, D:업체명, E:반출일, F:반출시간, G:반납일, H:반납시간, I:회차, J:계약상태, K:할인유형, L:비고

  let contract = null;
  for (let i = 0; i < contractData.length; i++) {
    if (contractData[i][0] === 거래ID) {
      contract = {
        거래ID: contractData[i][0],
        예약자명: contractData[i][1] || "",
        연락처: contractData[i][2] || "",
        업체명: contractData[i][3] || "",
        반출일: contractData[i][4],
        반출시간: contractDisplay[i][5],   // 문자열로 읽어서 1899 타임존 버그 방지
        반납일: contractData[i][6],
        반납시간: contractDisplay[i][7],   // 문자열로 읽어서 1899 타임존 버그 방지
        할인유형: String(contractData[i][10] || "").trim()  // K열
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

  // ── 전체 시트 데이터 유효성 검사 해제 (드롭다운 등으로 인한 입력 오류 방지) ──
  var lastRowAll = ws.getLastRow();
  var lastColAll = ws.getLastColumn();
  if (lastRowAll > 0 && lastColAll > 0) {
    var fullRange = ws.getRange(1, 1, lastRowAll, lastColAll);
    var allValidations = fullRange.getDataValidations();
    for (var ri = 0; ri < allValidations.length; ri++) {
      for (var ci = 0; ci < allValidations[ri].length; ci++) {
        if (allValidations[ri][ci]) {
          allValidations[ri][ci] = allValidations[ri][ci].copy().setAllowInvalid(true).build();
        }
      }
    }
    fullRange.setDataValidations(allValidations);
  }

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

  // ── 품목 채우기 (좌우 분할 테이블) — 배치 IO로 최적화 ──
  // 템플릿에서 B+C, H+I 이미 병합됨. 좌측: B(품목), D,E,F(수량,일수,단가), G(금액수식).
  //                                 우측: H(품목), J,K,L(수량,일수,단가), M(금액수식).
  // 성능: 기존 400+ 셀 API 호출 → 배치 10여 회로 축소 (~15x 빠름).
  const ITEMS_PER_SIDE = rows.itemRows || 22;
  const itemStart = rows.itemStart;

  // 추가요청을 items 뒤에 이어붙이기 (같은 배열로 통합 처리)
  const combinedItems = items.slice();
  if (추가요청) {
    const 추가items = 추가요청.split("\n").filter(function(s) { return s.trim(); });
    for (let ai = 0; ai < 추가items.length && combinedItems.length < ITEMS_PER_SIDE * 2; ai++) {
      combinedItems.push({ 세트명: "", 장비명: 추가items[ai].trim(), 수량: 1, 단가: 0 });
    }
  }

  // 좌/우 분할
  const leftItems = [];
  const rightItems = [];
  for (let i = 0; i < ITEMS_PER_SIDE; i++) {
    leftItems.push(combinedItems[i] || null);
    rightItems.push(combinedItems[i + ITEMS_PER_SIDE] || null);
  }

  // 2D 배열 빌드 (빈 슬롯은 ""로 채움)
  const leftNames = [], leftNums = [], leftFormulas = [], leftBgs = [], leftWeights = [];
  const rightNames = [], rightNums = [], rightFormulas = [], rightBgs = [], rightWeights = [];

  function buildRow(item, rowIdx, nameArr, numArr, fmlArr, bgArr, wtArr, qCol, dCol, pCol, aCol) {
    if (!item) {
      nameArr.push([""]);
      numArr.push(["", "", ""]);
      fmlArr.push([""]);
      bgArr.push([null]);
      wtArr.push(["normal"]);
      return;
    }
    nameArr.push([item.장비명 || ""]);
    numArr.push([item.수량 || "", item.수량 ? 일수 : "", item.단가 || ""]);
    // 금액 수식 — 좌측이면 D*E*F, 우측이면 J*K*L
    const qA = _colLetter(qCol) + rowIdx, dA = _colLetter(dCol) + rowIdx, pA = _colLetter(pCol) + rowIdx;
    fmlArr.push(["=" + qA + "*" + dA + "*" + pA]);  // 원본과 동일하게 항상 수식 세팅
    const isSetHeader = item.세트명 && item.장비명 === item.세트명;
    const isPriced = !item.세트명 && item.단가 > 0;
    if (isSetHeader || isPriced) {
      bgArr.push(["#D9EAD3"]);
      wtArr.push(["bold"]);
    } else {
      bgArr.push([null]);
      wtArr.push(["normal"]);
    }
  }

  for (let i = 0; i < ITEMS_PER_SIDE; i++) {
    const rowIdx = itemStart + i;
    buildRow(leftItems[i], rowIdx, leftNames, leftNums, leftFormulas, leftBgs, leftWeights, 4, 5, 6, 7);
    buildRow(rightItems[i], rowIdx, rightNames, rightNums, rightFormulas, rightBgs, rightWeights, 10, 11, 12, 13);
  }

  // 배치 쓰기: 좌측 B(품목), D:F(수량·일수·단가), G(금액수식), 서식
  // 기존 G/M 금액 셀의 수식 보존 위해 clearContent는 B, D:F, H, J:L 만
  ws.getRange(itemStart, 2, ITEMS_PER_SIDE, 1).clearContent();       // B
  ws.getRange(itemStart, 4, ITEMS_PER_SIDE, 3).clearContent();       // D:F
  ws.getRange(itemStart, 8, ITEMS_PER_SIDE, 1).clearContent();       // H
  ws.getRange(itemStart, 10, ITEMS_PER_SIDE, 3).clearContent();      // J:L

  ws.getRange(itemStart, 2, ITEMS_PER_SIDE, 1).setValues(leftNames);
  ws.getRange(itemStart, 4, ITEMS_PER_SIDE, 3).setValues(leftNums);
  ws.getRange(itemStart, 7, ITEMS_PER_SIDE, 1).setFormulas(leftFormulas);
  ws.getRange(itemStart, 2, ITEMS_PER_SIDE, 1).setBackgrounds(leftBgs);
  ws.getRange(itemStart, 2, ITEMS_PER_SIDE, 5).setFontWeights(leftWeights.map(function(w) { return [w[0], w[0], w[0], w[0], w[0]]; }));

  ws.getRange(itemStart, 8, ITEMS_PER_SIDE, 1).setValues(rightNames);
  ws.getRange(itemStart, 10, ITEMS_PER_SIDE, 3).setValues(rightNums);
  ws.getRange(itemStart, 13, ITEMS_PER_SIDE, 1).setFormulas(rightFormulas);
  ws.getRange(itemStart, 8, ITEMS_PER_SIDE, 1).setBackgrounds(rightBgs);
  ws.getRange(itemStart, 8, ITEMS_PER_SIDE, 5).setFontWeights(rightWeights.map(function(w) { return [w[0], w[0], w[0], w[0], w[0]]; }));

  // ── 할인 드롭다운 초기화 — 사전(C44), 추가(I44), 장기(C45), 쿠폰(I45) ──
  // 계약마스터 K(할인유형)에 따라 사전/추가 할인을 자동 주입
  // 계약서 템플릿 실제 드롭다운 옵션명:
  //   사전할인: 해당없음 / 학생30% / 개인사업자/프리랜서20%
  //   추가할인: 해당없음 / 단골10% / 제휴업체20%
  // 매핑:
  //   일반 → 사전 해당없음, 추가 해당없음
  //   학생 → 사전 '학생30%'
  //   개인사업자/프리랜서 → 사전 '개인사업자/프리랜서20%'
  //   단골 → 사전 '개인사업자/프리랜서20%', 추가 '단골10%'
  //   제휴 → 사전 '개인사업자/프리랜서20%', 추가 '제휴업체20%'
  var 사전할인 = "해당없음";
  var 추가할인 = "해당없음";
  switch (String(contract.할인유형 || "").trim()) {
    case "학생":
      사전할인 = "학생30%"; break;
    case "개인사업자/프리랜서":
      사전할인 = "개인사업자/프리랜서20%"; break;
    case "단골":
      사전할인 = "개인사업자/프리랜서20%"; 추가할인 = "단골10%"; break;
    case "제휴":
      사전할인 = "개인사업자/프리랜서20%"; 추가할인 = "제휴업체20%"; break;
    default: break;  // 일반 또는 미지정
  }
  ws.getRange("C44:C45").setValues([[사전할인], ["해당없음"]]);
  ws.getRange("I44:I45").setValues([[추가할인], ["해당없음"]]);

  // ── 장기할인 (C45) — E열 일수를 참조하는 수식 (수동 수정 시 자동 반영) ──
  var dayCell = "E" + rows.itemStart;
  ws.getRange("C45").setFormula(
    '=IF(' + dayCell + '>=20,"50%",IF(' + dayCell + '>=15,"45%",IF(' + dayCell + '>=10,"40%",IF(' + dayCell + '>=6,"35%",IF(' + dayCell + '>=3,"20%",IF(' + dayCell + '>=2,"10%","해당없음"))))))'
  );

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

  // ── 개고생2.0 거래내역 C열(이동 후)에 계약서 링크 입력 ──
  updateContractLink(거래ID, newUrl);

  return { fileName: fileName, url: newUrl, fileId: newFileId };
}

// 컬럼 번호 → 문자 (1→A, 2→B ...). 배치 IO 수식 생성용.
function _colLetter(n) {
  var s = "";
  while (n > 0) { var r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
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

    // 2026-04-23 컬럼 재배치 반영: 거래ID D(4) → E(5), 계약서링크 M(13) → C(3)
    const ids = 거래시트.getRange(2, 5, lastRow - 1, 1).getValues();
    for (let i = 0; i < ids.length; i++) {
      if (ids[i][0] === 거래ID) {
        // C열(3)에 계약서 링크 입력
        거래시트.getRange(i + 2, 3).setValue(contractUrl);
        Logger.log("개고생2.0 거래내역 C열 계약서 링크 입력 완료: " + 거래ID);
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
        // 2026-04-23 컬럼 재배치: 거래ID D→E(5), 계약서링크 M→C(3)
        const ids = 거래시트.getRange(2, 5, Math.max(1, 거래시트.getLastRow() - 1), 1).getValues();
        for (let i = 0; i < ids.length; i++) {
          if (ids[i][0] === 거래ID) {
            거래시트.getRange(i + 2, 3).clearContent();
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

/**
 * 대여일수 계산
 * 24시간 = 1일, 6시간 이내 초과 = 같은 일수, 6시간 초과 = +1일
 * 예: 30시간=1일, 31시간=2일, 54시간=2일, 55시간=3일
 */
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
      if (typeof time === "string") {
        const parts = time.split(":");
        if (parts.length >= 2) {
          d.setHours(parseInt(parts[0]), parseInt(parts[1]), 0, 0);
        }
      } else if (time instanceof Date) {
        const timeStr = Utilities.formatDate(time, 'Asia/Seoul', 'HH:mm');
        const parts = timeStr.split(":");
        d.setHours(parseInt(parts[0]), parseInt(parts[1]), 0, 0);
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
    } else if (time instanceof Date) {
      result += ` ${Utilities.formatDate(time, 'Asia/Seoul', 'HH:mm')}`;
    }
  }
  return result;
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// [삭제됨] 기존 계약서 일괄 수정/복원 함수 — 사용 금지
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** @deprecated 사용 금지 — 기존 계약서 건드리지 않음 */
function fixAllContractTimezone() { Logger.log("⛔ 이 함수는 비활성화되었습니다."); return; }
/** @deprecated 사용 금지 */
function revertAllContracts() { Logger.log("⛔ 이 함수는 비활성화되었습니다."); return; }
/** @deprecated 사용 금지 */
function resetRevertProgress() { Logger.log("⛔ 이 함수는 비활성화되었습니다."); return; }
function extractSpreadsheetId(url) { return null; }

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
/**
 * 계약서 템플릿 원본에 시트 보호 적용
 * GAS 편집기에서 한 번만 실행하면 됨
 */
function protectContractTemplate() {
  var props = PropertiesService.getScriptProperties();
  var templateId = props.getProperty("CONTRACT_TEMPLATE_ID");
  if (!templateId) {
    Logger.log("❌ CONTRACT_TEMPLATE_ID 미설정");
    SpreadsheetApp.getUi().alert("❌ CONTRACT_TEMPLATE_ID가 설정되지 않았습니다.");
    return;
  }

  var templateSS = SpreadsheetApp.openById(templateId);
  var sheets = templateSS.getSheets();

  sheets.forEach(function(sheet) {
    // 기존 보호 제거 (중복 방지)
    var existing = sheet.getProtections(SpreadsheetApp.ProtectionType.SHEET);
    existing.forEach(function(p) { p.remove(); });

    // 새 보호 적용
    var protection = sheet.protect().setDescription("계약서 템플릿 원본 — 수정 금지");
    protection.removeEditors(protection.getEditors());
    if (protection.canDomainEdit()) {
      protection.setDomainEdit(false);
    }
    protection.setWarningOnly(true);
  });

  Logger.log("✅ 템플릿 보호 완료: " + templateSS.getName());
  SpreadsheetApp.getUi().alert("✅ 계약서 템플릿 보호 완료\n\n" + templateSS.getName() + "\n\n수정 시도 시 경고 팝업이 표시됩니다.\n(소유자는 차단 불가 — 경고만 표시)");
}


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