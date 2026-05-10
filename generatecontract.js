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
  // ── 할인 셀 4개 모두 텍스트 포맷 강제 (중요!) ──
  // setValue("10%") 처럼 % 포함 문자열을 percent 셀에 쓰면 Sheets가 0.1 숫자로 자동 변환.
  // 그러면 H46의 REGEXEXTRACT(C45, "\d+")가 0.1에서 "0"만 추출해 할인 0% 처리됨.
  // 텍스트 포맷(@)으로 강제해 "10%" 문자열 그대로 저장 → REGEXEXTRACT가 "10" 정확히 추출.
  ws.getRange("C44:C45").setNumberFormat("@");
  ws.getRange("I44:I45").setNumberFormat("@");

  ws.getRange("C44:C45").setValues([[사전할인], ["해당없음"]]);
  ws.getRange("I44:I45").setValues([[추가할인], ["해당없음"]]);

  // ── 장기할인 (C45) — 일수 기반 직접 setValue + 드롭다운 적용 ──
  var ltRate = getLongTermDiscountRate(일수 || 1);
  var ltText = ltRate === 0 ? "해당없음" : (ltRate + "%");
  var ltRule = SpreadsheetApp.newDataValidation()
    .requireValueInList(["해당없음", "10%", "20%", "35%", "40%", "45%", "50%"], true)
    .setAllowInvalid(true)
    .setHelpText("1일=해당없음 / 2일=10% / 3~5일=20% / 6~9일=35% / 10~14일=40% / 15~19일=45% / 20일+=50%")
    .build();
  ws.getRange("C45").setDataValidation(ltRule).setValue(ltText);

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
/**
 * 진단: 계약서 템플릿의 C44/C45/I44/I45 셀에 설정된 데이터 유효성 옵션 목록 + 현재 값 반환.
 * 장기할인 드롭다운 옵션이 정확히 무엇인지 알아야 setValue로 매칭 가능.
 */
/**
 * 계약서 템플릿 자체에 안전한 할인 셋업 적용 (1회 실행).
 * - C44/C45/I44/I45 → 텍스트 포맷(@) 강제 (% 자동변환 방지)
 * - C45 드롭다운: 해당없음 / 10% / 20% / 35% / 40% / 45% / 50%
 * - C45 수식: 일수(E14) 기반 자동 적용
 *     =IF(E14>=20,"50%",IF(E14>=15,"45%",IF(E14>=10,"40%",
 *      IF(E14>=6,"35%",IF(E14>=3,"20%",IF(E14>=2,"10%","해당없음"))))))
 *   → 템플릿 단독으로 열어 일수 입력해도 자동 계산됨
 *   → 계약서 생성 코드도 setValue로 덮어쓰지만, 코드가 실패하더라도 템플릿이 안전망
 */
function setupContractTemplate() {
  var props = PropertiesService.getScriptProperties();
  var templateId = props.getProperty("CONTRACT_TEMPLATE_ID");
  if (!templateId) return "❌ CONTRACT_TEMPLATE_ID 미설정";

  var ss = SpreadsheetApp.openById(templateId);
  var ws = ss.getSheets()[0];
  var out = [];

  // 1) 4개 할인 셀 모두 텍스트 포맷
  ws.getRange("C44:C45").setNumberFormat("@");
  ws.getRange("I44:I45").setNumberFormat("@");
  out.push("C44/C45/I44/I45 텍스트 포맷 적용");

  // 2) C45 드롭다운
  var ltRule = SpreadsheetApp.newDataValidation()
    .requireValueInList(["해당없음", "10%", "20%", "35%", "40%", "45%", "50%"], true)
    .setAllowInvalid(true)
    .setHelpText("1일=해당없음 / 2일=10% / 3~5일=20% / 6~9일=35% / 10~14일=40% / 15~19일=45% / 20일+=50%")
    .build();
  ws.getRange("C45").setDataValidation(ltRule);
  out.push("C45 드롭다운 적용");

  // 3) C45 수식 — 일수(E14) 기반 자동 계산
  ws.getRange("C45").setFormula(
    '=IF(E14>=20,"50%",IF(E14>=15,"45%",IF(E14>=10,"40%",IF(E14>=6,"35%",IF(E14>=3,"20%",IF(E14>=2,"10%","해당없음"))))))'
  );
  out.push("C45 수식 적용 (E14 일수 기반)");

  // 4) 다른 할인 셀은 초기값을 '해당없음'으로 (드롭다운 옵션 일치)
  ws.getRange("C44").setValue("해당없음");
  ws.getRange("I44").setValue("해당없음");
  ws.getRange("I45").setValue("해당없음");
  out.push("C44/I44/I45 초기값 '해당없음'");

  return "✅ 템플릿 셋업 완료: " + out.join(" | ");
}

function inspectContractTemplateDiscounts() {
  var props = PropertiesService.getScriptProperties();
  var templateId = props.getProperty("CONTRACT_TEMPLATE_ID");
  if (!templateId) return { error: "CONTRACT_TEMPLATE_ID 미설정" };

  var ss = SpreadsheetApp.openById(templateId);
  var ws = ss.getSheets()[0];
  // 할인 영역 + 합계/결제 영역 모두 스캔 (43~48행)
  var rng = ws.getRange("A43:M48");
  var values = rng.getValues();
  var formulas = rng.getFormulas();
  var out = { discountCells: {}, scanArea: [] };

  ["C44", "I44", "C45", "I45"].forEach(function(addr) {
    var c = ws.getRange(addr);
    var dv = c.getDataValidation();
    var opts = null;
    if (dv) {
      try {
        var crit = dv.getCriteriaValues();
        if (crit && crit[0]) opts = crit[0];
      } catch (e) {}
    }
    out.discountCells[addr] = {
      value: c.getValue(),
      formula: c.getFormula(),
      validationOptions: opts,
      validationType: dv ? String(dv.getCriteriaType()) : null
    };
  });

  for (var r = 0; r < values.length; r++) {
    var rowOut = [];
    for (var col = 0; col < values[r].length; col++) {
      var letter = String.fromCharCode(65 + col);
      var v = values[r][col];
      var f = formulas[r][col];
      if (v === "" && !f) continue;
      rowOut.push(letter + (43 + r) + ": " + (f ? "=" + f : JSON.stringify(v)));
    }
    if (rowOut.length) out.scanArea.push(rowOut.join(" | "));
  }
  return out;
}

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


// ====================================================================
// 계약서 템플릿 마스터 시트 — 세트마스터 동기화
// ====================================================================

/**
 * 세트마스터 → 계약서 템플릿 마스터 시트 동기화.
 *
 * 세트마스터(A:세트명, B:구성장비명, G:단가)에서
 *   - 세트 상품: A열에 이름이 있고, B열이 비어있지 않은 첫 행 → G열 단가
 *   - 개별 장비: A열에 이름, B열이 빈 행 → G열 단가
 * 를 읽어서, 계약서 템플릿 내부 마스터 시트를 통째로 덮어쓴다.
 *
 * 사용법:
 *   1) GAS 편집기에서 수동 실행
 *   2) 또는 onOpen 메뉴에 연결해서 필요할 때 클릭
 *   3) 또는 시간 기반 트리거로 매일 자동 실행
 */
function syncTemplateMasterFromSetMaster() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var setSheet = ss.getSheetByName("세트마스터");
  if (!setSheet) {
    Logger.log("❌ 세트마스터 시트 없음");
    return "❌ 세트마스터 시트 없음";
  }

  var props = PropertiesService.getScriptProperties();
  var templateId = props.getProperty("CONTRACT_TEMPLATE_ID");
  if (!templateId) {
    Logger.log("❌ CONTRACT_TEMPLATE_ID 미설정");
    return "❌ CONTRACT_TEMPLATE_ID 미설정";
  }

  // ── 세트마스터에서 장비명 → 단가 맵 구축 ──
  var lastRow = setSheet.getLastRow();
  if (lastRow < 2) {
    Logger.log("❌ 세트마스터에 데이터 없음");
    return "❌ 세트마스터에 데이터 없음";
  }

  var data = setSheet.getRange(2, 1, lastRow - 1, 7).getValues();
  // A(0):세트명/장비명, B(1):구성장비명, C(2):수량, D(3):비고, E(4):대체가능장비, F(5):가용체크, G(6):단가
  //
  // 단가가 있는 행만 수집:
  //   세트 헤더: A열=세트명, B열 비어있지않음 → 세트 단가 (첫 행만)
  //   개별 장비: A열=장비명, B열 빈칸 → 개별 단가
  var priceMap = {};  // { 장비명: 단가 }
  var seenSets = {};  // 세트 중복 방지

  for (var i = 0; i < data.length; i++) {
    var name = String(data[i][0] || "").trim();
    var sub = String(data[i][1] || "").trim();
    var price = data[i][6];

    if (!name) continue;

    if (!sub) {
      // 개별 장비 (B열 빈칸)
      if (price && Number(price) > 0) {
        priceMap[name] = Number(price);
      }
    } else {
      // 세트 상품 (B열에 구성장비 있음) — 첫 행의 단가만 사용
      if (!seenSets[name] && price && Number(price) > 0) {
        priceMap[name] = Number(price);
        seenSets[name] = true;
      }
    }
  }

  var entries = Object.keys(priceMap);
  if (entries.length === 0) {
    Logger.log("❌ 세트마스터에서 단가 있는 항목을 찾지 못함");
    return "❌ 단가 있는 항목 0건";
  }

  // ── 계약서 템플릿 마스터 시트 열기 ──
  var templateSS = SpreadsheetApp.openById(templateId);
  var sheets = templateSS.getSheets();

  var masterSheet = null;
  for (var s = 0; s < sheets.length; s++) {
    if (sheets[s].getName().indexOf("마스터") >= 0) {
      masterSheet = sheets[s];
      break;
    }
  }

  if (!masterSheet) {
    // 마스터 시트가 없으면 새로 생성
    masterSheet = templateSS.insertSheet("마스터");
    Logger.log("마스터 시트 새로 생성됨");
  }

  // ── 기존 데이터 클리어 후 덮어쓰기 ──
  masterSheet.clearContents();

  // 헤더
  masterSheet.getRange(1, 1).setValue("장비명");
  masterSheet.getRange(1, 2).setValue("단가");

  // 데이터 (배치 쓰기)
  var writeData = [];
  entries.sort(); // 가나다순 정렬
  for (var e = 0; e < entries.length; e++) {
    writeData.push([entries[e], priceMap[entries[e]]]);
  }

  if (writeData.length > 0) {
    masterSheet.getRange(2, 1, writeData.length, 2).setValues(writeData);
  }

  // 단가 열 숫자 포맷
  masterSheet.getRange(2, 2, writeData.length, 1).setNumberFormat("#,##0");

  // ── 계약서 메인 시트에 단가 VLOOKUP 수식 세팅 ──
  var mainSheet = templateSS.getSheets()[0];
  var rows = findTemplateRows(mainSheet);
  var itemStart = rows.itemStart;
  var itemRows = rows.itemRows || 22;
  var sheetName = masterSheet.getName();

  // 좌측 F열(6열): B열 품목명 → 마스터 시트 VLOOKUP
  // 우측 L열(12열): H열 품목명 → 마스터 시트 VLOOKUP
  var leftFormulas = [];
  var rightFormulas = [];
  for (var r = 0; r < itemRows; r++) {
    var rowNum = itemStart + r;
    leftFormulas.push(['=IFERROR(VLOOKUP(B' + rowNum + ',' + sheetName + '!A:B,2,FALSE),"")']);
    rightFormulas.push(['=IFERROR(VLOOKUP(H' + rowNum + ',' + sheetName + '!A:B,2,FALSE),"")']);
  }

  // 좌측 G열(7열): 금액 = 수량(D) * 일수(E) * 단가(F)
  // 우측 M열(13열): 금액 = 수량(J) * 일수(K) * 단가(L)
  var leftAmountFormulas = [];
  var rightAmountFormulas = [];
  for (var r2 = 0; r2 < itemRows; r2++) {
    var rn = itemStart + r2;
    leftAmountFormulas.push(['=IFERROR(D' + rn + '*E' + rn + '*F' + rn + ',"")']);
    rightAmountFormulas.push(['=IFERROR(J' + rn + '*K' + rn + '*L' + rn + ',"")']);
  }

  mainSheet.getRange(itemStart, 6, itemRows, 1).setFormulas(leftFormulas);    // F열 단가
  mainSheet.getRange(itemStart, 7, itemRows, 1).setFormulas(leftAmountFormulas);  // G열 금액
  mainSheet.getRange(itemStart, 12, itemRows, 1).setFormulas(rightFormulas);   // L열 단가
  mainSheet.getRange(itemStart, 13, itemRows, 1).setFormulas(rightAmountFormulas); // M열 금액

  // ── 수식 셀(F, G, L, M) 보호 — 실수로 지우는 거 방지 ──
  // 기존 수식 보호 제거 후 재설정 (중복 방지)
  var existingProtections = mainSheet.getProtections(SpreadsheetApp.ProtectionType.RANGE);
  for (var p = 0; p < existingProtections.length; p++) {
    if (existingProtections[p].getDescription().indexOf("수식 보호") >= 0) {
      existingProtections[p].remove();
    }
  }

  var formulaRanges = [
    mainSheet.getRange(itemStart, 6, itemRows, 2),   // F~G열 (단가+금액)
    mainSheet.getRange(itemStart, 12, itemRows, 2)    // L~M열 (단가+금액)
  ];

  for (var fr = 0; fr < formulaRanges.length; fr++) {
    var prot = formulaRanges[fr].protect().setDescription("수식 보호 — 단가/금액 자동 계산");
    prot.removeEditors(prot.getEditors());
    if (prot.canDomainEdit()) prot.setDomainEdit(false);
  }

  Logger.log("수식 보호 적용: F~G, L~M (warning only)");
  Logger.log("수식 세팅: F(단가VLOOKUP) + G(금액=D*E*F) + L(단가VLOOKUP) + M(금액=J*K*L), 각 " + itemRows + "행");

  var summary = "✅ 템플릿 마스터 동기화 완료: " + writeData.length + "건 + 수식 " + (itemRows * 4) + "셀 + 보호 적용";
  Logger.log(summary);
  return summary;
}

/**
 * 진단용: 템플릿 마스터 시트 구조와 현재 데이터를 로그로 출력.
 * GAS 편집기 → 실행 → 로그 확인.
 */
function readTemplateMasterSheet() {
  var props = PropertiesService.getScriptProperties();
  var templateId = props.getProperty("CONTRACT_TEMPLATE_ID");
  if (!templateId) {
    Logger.log("❌ CONTRACT_TEMPLATE_ID 미설정");
    return "❌ CONTRACT_TEMPLATE_ID 미설정";
  }

  var ss = SpreadsheetApp.openById(templateId);
  var sheets = ss.getSheets();
  var out = [];

  out.push("=== 템플릿 시트 목록 ===");
  sheets.forEach(function(s, i) {
    out.push(i + ": " + s.getName() + " (" + s.getLastRow() + "행 x " + s.getLastColumn() + "열)");
  });

  // 마스터 시트 찾기 (이름에 '마스터' 포함)
  var masterSheet = null;
  sheets.forEach(function(s) {
    if (s.getName().indexOf("마스터") >= 0) masterSheet = s;
  });

  if (!masterSheet) {
    out.push("\n❌ '마스터' 시트를 찾을 수 없음");
    Logger.log(out.join("\n"));
    return out.join("\n");
  }

  out.push("\n=== 마스터 시트: " + masterSheet.getName() + " ===");

  var lastRow = masterSheet.getLastRow();
  var lastCol = masterSheet.getLastColumn();
  if (lastRow < 1 || lastCol < 1) {
    out.push("비어있음");
    Logger.log(out.join("\n"));
    return out.join("\n");
  }

  // 헤더 + 전체 데이터
  var data = masterSheet.getRange(1, 1, lastRow, lastCol).getDisplayValues();
  out.push("헤더: " + JSON.stringify(data[0]));
  out.push("---");
  for (var i = 1; i < data.length; i++) {
    out.push("행" + (i + 1) + ": " + JSON.stringify(data[i]));
  }

  Logger.log(out.join("\n"));
  return out.join("\n");
}

// ── 아래 함수는 deprecated — syncTemplateMasterFromSetMaster() 사용 ──
// 홈페이지 하드코딩 가격 대신 세트마스터에서 실시간 동기화하므로 더 이상 불필요.
// 혹시 모를 참고용으로 남겨둠. 삭제해도 무방.
function updateTemplateMasterPrices_DEPRECATED() {
  var props = PropertiesService.getScriptProperties();
  var templateId = props.getProperty("CONTRACT_TEMPLATE_ID");
  if (!templateId) {
    Logger.log("❌ CONTRACT_TEMPLATE_ID 미설정");
    return "❌ CONTRACT_TEMPLATE_ID 미설정";
  }

  var ss = SpreadsheetApp.openById(templateId);
  var sheets = ss.getSheets();

  // 마스터 시트 찾기
  var masterSheet = null;
  sheets.forEach(function(s) {
    if (s.getName().indexOf("마스터") >= 0) masterSheet = s;
  });

  if (!masterSheet) {
    Logger.log("❌ '마스터' 시트를 찾을 수 없음");
    return "❌ '마스터' 시트를 찾을 수 없음";
  }

  var lastRow = masterSheet.getLastRow();
  var lastCol = masterSheet.getLastColumn();

  if (lastRow < 1 || lastCol < 1) {
    Logger.log("❌ 마스터 시트가 비어있음");
    return "❌ 마스터 시트가 비어있음";
  }

  // 헤더 읽기 → 장비명/단가 열 자동 감지
  var headers = masterSheet.getRange(1, 1, 1, lastCol).getValues()[0];

  var nameCol = -1;
  var priceCol = -1;

  for (var c = 0; c < headers.length; c++) {
    var h = String(headers[c]).trim();
    if (h === "장비명" || h === "품목" || h === "이름" || h === "품명" || h === "장비") nameCol = c;
    if (h === "단가" || h === "가격" || h === "정가" || h === "1일" || h === "대여료" || h === "렌탈료") priceCol = c;
  }

  // 헤더 매칭 실패 시 — 2열(A=장비명, B=단가) 기본 구조로 폴백
  if (nameCol < 0) nameCol = 0;
  if (priceCol < 0) priceCol = (lastCol >= 2) ? 1 : 0;

  Logger.log("마스터 시트: " + masterSheet.getName());
  Logger.log("헤더: " + JSON.stringify(headers));
  Logger.log("장비명 열: " + (nameCol + 1) + " (0-idx " + nameCol + ")");
  Logger.log("단가 열: " + (priceCol + 1) + " (0-idx " + priceCol + ")");

  // 2026-05-10 홈페이지(village6k.co.kr) 기준 가격표 (정가, 원/24h)
  var latestPrices = {
    // ── 카메라 풀세트 ──
    "픽시스 6K 풀세트 (PL 마운트) - 입고 예정": 150000,
    "소니 BURANO 베이직 세트(뉴클, 무선 제외)": 200000,
    "소니 BURANO 풀세트": 250000,
    "소니 FX6 바디 세트 (CF-A 메모리, 배터리 포함)": 60000,
    "소니 FX6 바디 세트": 60000,
    "소니 A7S3 풀세트": 80000,
    "소니 FX3 풀세트": 90000,
    "소니 FX6 바디 세트 + FE 28-135 렌즈": 90000,
    "소니 FX9 바디 세트 + FE 28-135 렌즈": 90000,
    "소니 FX9 바디 세트 (XQD 메모리, 배터리 포함)": 60000,
    "소니 FX9 바디 세트": 60000,
    "RED 코모도 풀세트(EF/PL마운트 중 선택)": 100000,
    "RED 코모도 풀세트": 100000,
    "소니 FX6 풀세트": 130000,
    "소니 FX9 풀세트": 130000,
    "BMPCC 6K Pro 풀세트": 60000,
    "BMPCC 6K 풀세트": 50000,
    // ── 카메라 ──
    "인스타360 X5 (+인비져블 셀피스틱)": 30000,
    "인스타360 X5": 30000,
    "소니 Z-90 캠코더(4K)": 50000,
    "소니 Z-90 캠코더": 50000,
    "소니 AX43A 캠코더(4K)": 30000,
    "소니 AX43A 캠코더": 30000,
    "캐논 R6 MARK II + RF 100-500 (또는 100-400)": 60000,
    "캐논 R6 MARK II + RF 100-500": 60000,
    "소니 AX-700 캠코더(4K)": 30000,
    "소니 AX-700 캠코더": 30000,
    "소니 A7S3 바디 세트 (CF-A 메모리, 배터리 포함)": 40000,
    "소니 A7S3 바디 세트": 40000,
    "소니 A7S3 바디": 40000,
    "소니 FX3 바디 세트 (CF-A 메모리, 배터리 포함)": 50000,
    "소니 FX3 바디 세트": 50000,
    "소니 FX3 바디": 50000,
    "소니 A7S3 바디 세트 + FE 28-135 렌즈": 70000,
    "소니 A7S3 바디 세트 + 24-70 GM 렌즈": 65000,
    "소니 FX3 바디 세트 + FE 28-135 렌즈": 80000,
    "소니 FX3 바디 세트 + 24-70 GM 렌즈": 75000,
    "고프로 히어로11 블랙 패키지": 20000,
    "고프로 히어로10 블랙 패키지": 20000,
    "오막포+백사투": 50000,
    "오즈모 포켓3": 20000,
    "캐논 R6 MARK II": 40000,
    "캐논 5D MARK IV(오막포)": 30000,
    "캐논 5D MARK IV": 30000,
    "맨프로토 143A (카메라 거치 가능 대형 매직암)": 5000,
    "맨프로토 143A": 5000,
    // ── 삼각대 ──
    "울란지 Video Fast (75볼- 셔틀러 플로우텍 스타일)": 15000,
    "울란지 Video Fast": 15000,
    "셔틀러 플로우텍 aktiv8 GS": 30000,
    "셔틀러 비디오 20": 35000,
    "맨프로토 MVMX PRO 500(모노포드)": 10000,
    "맨프로토 MVMX PRO 500": 10000,
    "서튼 ST-V15(100볼)": 15000,
    "서튼 ST-V15": 15000,
    "캠기어 엘리트 15(100볼)": 20000,
    "캠기어 엘리트 15": 20000,
    "캠기어 마크4(75볼)": 10000,
    "캠기어 마크4": 10000,
    "셔틀러 에이스 CF XL(75볼)": 20000,
    "셔틀러 에이스 CF XL": 20000,
    "셔틀러 에이스 CF M(75볼)": 10000,
    "셔틀러 에이스 CF M": 10000,
    "미니 삼각대": 5000,
    // ── 렌즈 ──
    "삼양 XEEN 렌즈 세트": 50000,
    "DZOFILM CATTA ACE 3 Lens 세트": 100000,
    "DZOFILM CATTA ACE": 100000,
    "캐논 RF 100-500": 30000,
    "쿠크 COOKE SP3 렌즈 세트": 200000,
    "COOKE SP3 렌즈 세트": 200000,
    "니시 아테나 프라임 단렌즈 세트": 100000,
    "라오와 24mm f/14 Probe (PL/E/EF)": 30000,
    "라오와 24mm f/14 Probe": 30000,
    "소니 90mm 매크로 렌즈": 20000,
    "캐논 100-400mm II(백사투)": 30000,
    "캐논 100-400mm II": 30000,
    "소니 100-400 GM": 30000,
    "시그마 FF High Speed Prime 렌즈 세트": 100000,
    "소니 GM 단렌즈 세트": 90000,
    "삼양 XEEN CF 렌즈 세트": 80000,
    "소니 GM 렌즈 세트(단품 대여 가능)": 70000,
    "소니 GM 렌즈 세트": 70000,
    "소니 24-70 GM II": 25000,
    "소니 70-200 GM II": 30000,
    "소니 FE 28-135 렌즈 (E 마운트)": 30000,
    "소니 FE 28-135 렌즈": 30000,
    "소니 FE 28-135": 30000,
    "소니 FE 24-105mm 렌즈 (E 마운트)": 20000,
    "소니 FE 24-105mm 렌즈": 20000,
    "소니 FE 24-105mm": 20000,
    "시그마 아트 줌렌즈 세트": 40000,
    "삼양 VDSLR MK2 세트": 50000,
    "삼양 100mm 매크로 렌즈": 10000,
    "라오와 12mm T2.9 Zero-D Cine": 35000,
    "아이릭스 150mm CINE 매크로 렌즈": 20000,
    "틸타 MB-T12 매트박스 (4x5.65, 3stages)": 20000,
    "틸타 MB-T12 매트박스": 20000,
    "틸타 MB-T16 미라지 매트박스 (4x5.65, 경량형)": 15000,
    "틸타 MB-T16 미라지 매트박스": 15000,
    "매트박스 미니(틸타 or 스몰리그)": 7000,
    "매트박스 미니": 7000,
    "NiSi PL 필터 (4x5.65)": 10000,
    "NiSi PL 필터": 10000,
    "NiSi True-Color PL 필터 (4x5.65)": 10000,
    "NiSi True-Color PL 필터": 10000,
    "티펜 Black Pro-Mist 필터 (4x5.65 or 67-82mm)": 10000,
    "티펜 Black Pro-Mist 필터": 10000,
    "슈나이더 Hollywood Black Magic 필터 (4x5.65 or 67-82mm)": 10000,
    "슈나이더 Hollywood Black Magic 필터": 10000,
    "H&Y REVORING (3-1000 ND + CPL 필터)": 10000,
    "H&Y REVORING": 10000,
    "메타본즈(PL to E)": 10000,
    "메타본즈": 10000,
    "IR ND 필터": 10000,
    "H&Y 가변 어댑터링 (필터 어댑터, 67-82mm)": 5000,
    "H&Y 가변 어댑터링": 5000,
    "시그마 MC-11 (렌즈 어댑터, EF to E)": 5000,
    "시그마 MC-11": 5000,
    // ── 조명 ──
    "어퓨쳐 스톰 80C": 20000,
    "아마란 F21C": 20000,
    "난룩스 Evoke 1200B": 50000,
    "파보튜브II 30XR 2KIT": 35000,
    "어퓨쳐 600D(최대 광량 600X의 약 1.6배)": 30000,
    "어퓨쳐 600D": 30000,
    "아마란 PT4C 4KIT": 60000,
    "아마란 PT4C 2KIT": 30000,
    "어퓨쳐 LS 60X": 20000,
    "어퓨쳐 300X 세트 (2세트 5만원)": 25000,
    "어퓨쳐 300X 세트": 25000,
    "어퓨쳐 아마란 300C 세트(RGBWW)": 20000,
    "어퓨쳐 아마란 300C 세트": 20000,
    "아마란 300C 세트": 20000,
    "어퓨쳐 노바 P300C 세트(2세트 6만원)": 30000,
    "어퓨쳐 노바 P300C 세트": 30000,
    "어퓨쳐 600X 프로 세트": 35000,
    "어퓨쳐 600C 프로 세트 (RGBWW)": 40000,
    "어퓨쳐 600C 프로 세트": 40000,
    "시네로이드 CFL-800 세트": 20000,
    "아마란 F22C": 35000,
    "캐논 스피드라이트 430EX III-RT (스트로보)": 15000,
    "캐논 스피드라이트 430EX III-RT": 15000,
    "파보튜브II 30X 2KIT": 30000,
    "파보튜브II 30X 4KIT": 60000,
    "파보튜브II 6C": 5000,
    "어퓨쳐 B7C 2KIT": 20000,
    "어퓨쳐 B7C 8KIT": 40000,
    "어퓨쳐 MC4 트래블 KIT": 20000,
    "어퓨쳐 Spotlight 마운트(아이리스 제공)": 10000,
    "어퓨쳐 Spotlight 마운트": 10000,
    "어퓨쳐 F10 프레넬 렌즈+반도어(600용)": 10000,
    "어퓨쳐 F10 프레넬 렌즈": 10000,
    "어퓨쳐 2X 프레넬 렌즈(300용)": 5000,
    "어퓨쳐 2X 프레넬 렌즈": 5000,
    "어퓨쳐 파워스테이션": 10000,
    "스크림 세트(고보)": 10000,
    "스크림 세트": 10000,
    "C-BOOM (AVENGER D600)": 5000,
    "C-BOOM": 5000,
    "C스탠드(그립암, 그립헤드 포함)": 5000,
    "C스탠드": 5000,
    "콤보 스탠드": 5000,
    "석자/넉자 플로피": 5000,
    "석자/넉자 디퓨젼, 그리드": 5000,
    "반사판": 5000,
    "탑 클램프": 5000,
    "매슬리니": 3000,
    // ── 모니터/무선 ──
    "17인치 모니터(구형)": 25000,
    "17인치 모니터": 25000,
    "TVLogic LVM-180A": 35000,
    "DJI SDR Transmission (무선송수신기)": 20000,
    "DJI SDR Transmission": 20000,
    "홀리랜드 파이로 7": 20000,
    "홀리랜드 파이로 S": 30000,
    "PDMOVIE LIVE AIR 3 Smart LiDAR": 20000,
    "PDMOVIE LIVE AIR 3": 20000,
    "틸타 뉴클리어스 Nano II": 20000,
    "홀리랜드 솔리드컴 C1 PRO - 6S": 70000,
    "홀리랜드 솔리드컴 C1 PRO - 4S": 50000,
    "TVLogic VFM-055A": 20000,
    "TVLogic F-7HS (신형 7인치 모니터)": 30000,
    "TVLogic F-7HS": 30000,
    "홀리랜드 마스 4K (1:2 가능, 앱 모니터링 가능)": 25000,
    "홀리랜드 마스 4K": 25000,
    "홀리랜드 마스 M1": 20000,
    "홀리랜드 마스 400S 프로 (1:2 가능, 앱 모니터링 가능)": 20000,
    "홀리랜드 마스 400S 프로": 20000,
    "홀리랜드 마스 400S (앱 모니터링 가능)": 20000,
    "홀리랜드 마스 400S": 20000,
    "테라덱 볼트 1000XT (1:2 가능)": 30000,
    "테라덱 볼트 1000XT": 30000,
    "테라덱 볼트 500LT": 25000,
    "바식스 아톰 500 (앱 모니터링 가능)": 20000,
    "바식스 아톰 500": 20000,
    "5인치 프리뷰 모니터(포트키, TVlogic)": 20000,
    "5인치 프리뷰 모니터": 20000,
    "7인치 프리뷰 모니터(포트키)": 20000,
    "7인치 프리뷰 모니터": 20000,
    "스몰HD INDIE7 (케이지 세팅)": 25000,
    "스몰HD INDIE7": 25000,
    "TVLogic LVM-170A": 30000,
    "블랙매직 멀티뷰 4HD (4채널 모니터링 어댑터)": 15000,
    "블랙매직 멀티뷰 4HD": 15000,
    "틸타 뉴클리어스-M": 20000,
    "틸타 뉴클리어스-N": 10000,
    "무선세트(17인치)": 50000,
    "무선세트(7인치)": 50000,
    "애플 아이패드(무선 모니터링 가능)": 10000,
    "애플 아이패드": 10000,
    // ── 짐벌/그립/달리 ──
    "MOVMAX RAZOR ARM": 50000,
    "로닌 RS4 프로": 30000,
    "핫도그 슬라이더(앱 컨트롤 가능, 최대 길이 120cm)": 30000,
    "핫도그 슬라이더": 30000,
    "시네 카트": 20000,
    "틸타 시네 슬라이더": 50000,
    "로닌 RS3 프로": 30000,
    "로닌 RS2 프로": 30000,
    "모션나인 카트 M1": 20000,
    "숄더리그": 10000,
    // ── 오디오 ──
    "JBL 파티박스 스테이지 320 + 마이크 2대": 30000,
    "JBL 파티박스 스테이지 320": 30000,
    "DJI 무선마이크 (1TX + 2RX 구성)": 10000,
    "DJI 무선마이크": 10000,
    "젠하이져 MKH-416P(붐마이크 세팅) - 렌탈 일시 중지": 15000,
    "젠하이져 MKH-416P(붐마이크 세팅)": 15000,
    "젠하이져 MKH-416P": 15000,
    "모토로라 T82EX 4세트(고성능 무전기)": 20000,
    "모토로라 T82EX 4세트": 20000,
    "소니 UWP-D21": 10000,
    "로데 비디오 마이크 프로 +": 10000,
    "로데 비디오 마이크 프로+": 10000,
    "소니 ECM - 673(붐마이크 세팅)": 10000,
    "소니 ECM-673(붐마이크 세팅)": 10000,
    "소니 ECM - 673": 10000,
    "소니 ECM-673": 10000,
    "줌 F6": 20000,
    "줌 H8(핸디 레코더)": 20000,
    "줌 H8": 20000,
    "붐마이크 거치대 홀더": 5000,
    "소니 XLR-K3M 외장마이크": 10000,
    "소니 XLR-K3M": 10000,
    "오디오 테크니카 ATH-M50X": 10000,
    "TAKSTAR CM-63 (콘덴서 마이크)": 10000,
    "TAKSTAR CM-63": 10000,
    // ── 기타 ──
    "강풍기": 5000,
    "슬레이트": 5000,
    "고릴라포드": 5000,
    "모션나인 C-BED": 5000,
    "KSH17 프롬프터 (100볼 트라이 포함)": 60000,
    "KSH17 프롬프터": 60000,
    "에코플로우 델타2 맥스(파워뱅크, 2048Wh, 최대 출력 6kW)": 60000,
    "에코플로우 델타2 맥스": 60000,
    "에코플로우 델타2 (파워뱅크, 1024Wh, 2시간 내 완충)": 50000,
    "에코플로우 델타2": 50000,
    "지윤 크레인 3S": 30000,
    "하만카돈 Go+Play (100W 출력, 블루투스 스피커, 2대 페어링 가능)": 10000,
    "하만카돈 Go+Play": 10000,
    "Bowers&Wilkins Formation Flex(2조)": 50000,
    "Bowers&Wilkins Formation Flex": 50000,
    "더블 헤더": 5000,
    "CINE SADDLE": 5000,
    "L 플레이트": 5000,
    "오토폴": 5000,
    "V마운트 배터리 세트(3개)": 10000,
    "V마운트 배터리 세트": 10000,
    "슈퍼클램프": 3000,
    "툴콘 TG-1800K (1.8kW, 16kg)": 30000,
    "툴콘 TG-1800K": 30000,
    "인터컴 (5세트, 이어셋 포함)": 30000,
    "인터컴": 30000,
    "아템 미니 익스트림 ISO": 30000,
    "애플박스 세트 (풀/하프/쿼터/팬케잌)": 5000,
    "애플박스 세트": 5000,
    "사다리": 5000,
    "포그 머신 (용액 포함)": 20000,
    "포그 머신": 20000,
    "헤이저 머신 (용액 포함, 지속 분사)": 30000,
    "헤이저 머신": 30000,
    "촬영용 턴테이블 (직경 60cm, 하중 80kg)": 20000,
    "촬영용 턴테이블": 20000,
    "클라우드 백업 서비스 (1캠 기준)": 10000,
    "클라우드 백업 서비스": 10000
  };

  // 현재 데이터 읽기
  var data = masterSheet.getRange(1, 1, lastRow, lastCol).getValues();

  var updated = 0;
  var notFound = [];
  var log = [];

  for (var i = 1; i < data.length; i++) {
    var name = String(data[i][nameCol]).trim();
    if (!name) continue;

    // 1차: 정확히 일치
    var newPrice = latestPrices[name];

    // 2차: 괄호 등 부가설명 제거 후 매칭
    if (newPrice === undefined) {
      var stripped = name.replace(/\s*[\(（].*$/, "").trim();
      newPrice = latestPrices[stripped];
    }

    // 3차: 공백/하이픈 정규화
    if (newPrice === undefined) {
      var normalized = name.replace(/[\s\-·]/g, "");
      var keys = Object.keys(latestPrices);
      for (var k = 0; k < keys.length; k++) {
        if (keys[k].replace(/[\s\-·]/g, "") === normalized) {
          newPrice = latestPrices[keys[k]];
          break;
        }
      }
    }

    if (newPrice !== undefined) {
      var oldPrice = data[i][priceCol];
      if (Number(oldPrice) !== newPrice) {
        log.push("행" + (i + 1) + " [" + name + "] " + oldPrice + " → " + newPrice);
        masterSheet.getRange(i + 1, priceCol + 1).setValue(newPrice);
        updated++;
      }
    } else {
      notFound.push(name);
    }
  }

  var summary = "✅ 마스터 시트 가격 업데이트 완료\n";
  summary += "업데이트: " + updated + "건\n";
  if (log.length > 0) summary += "\n변경 내역:\n" + log.join("\n");
  if (notFound.length > 0) summary += "\n\n⚠️ 홈페이지에서 매칭 안 된 항목:\n" + notFound.join(", ");

  Logger.log(summary);
  return summary;
}