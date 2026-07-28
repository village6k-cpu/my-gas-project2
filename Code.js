/**
 * ====================================================================
 * Code.gs — v3 (기존 코드 + 확인요청 트리거 통합)
 * ====================================================================
 *
 * 변경사항:
 * - 확인요청 H열(확인) / N열(등록) 드롭다운 트리거 추가
 * - handleScheduleEdit() 호출 (checkAvailability_v3.gs에 정의)
 *
 * ★ 이 파일 전체를 기존 Code.gs에 덮어쓰세요. ★
 */

function onEdit(e) {
  if (!e || !e.source) return;

  const sheet = e.source.getActiveSheet();
  const col = e.range.getColumn();
  const row = e.range.getRow();
  const editRowCount = e.range.getNumRows ? e.range.getNumRows() : 1;
  const editColCount = e.range.getNumColumns ? e.range.getNumColumns() : 1;
  if (row === 1 && editRowCount === 1) return;

  // ─── 기존: 실사 기록 자동입력 ───
  if (sheet.getName() === "실사 기록") {
    if (col === 6 || col === 7) {
      const 현재실사 = sheet.getRange(row, 6).getValue();
      if (현재실사 !== "") {
        const email = Session.getActiveUser().getEmail().split("@")[0];
        sheet.getRange(row, 9).setValue(email);
        sheet.getRange(row, 10).setValue(new Date());
      } else {
        sheet.getRange(row, 9).setValue("");
        sheet.getRange(row, 10).setValue("");
      }
    }
  }

  // ─── 기존: 신규장비 추가 - 카테고리 입력 시 장비ID 자동생성 ───
  if (sheet.getName() === "신규장비 추가") {
    if (col === 2) {
      const 카테고리 = e.range.getValue();
      const 기존ID = sheet.getRange(row, 3).getValue();
      if (!카테고리 || 기존ID) return;

      const 카테고리PREFIX = {
        '카메라': 'CAM', '렌즈': 'LNS', '어댑터': 'ADP',
        '매트박스': 'MTB', '필터': 'FLT', '배터리': 'BAT',
        '리더기': 'RDR', '메모리': 'MEM', '삼각대': 'TRP',
        '카트': 'CRT', '모니터': 'MON', '무선': 'WRL',
        '로닌/짐벌': 'GBL', '오디오': 'AUD', '조명': 'LGT',
        '기타': 'ETC', '케이블': 'CBL'
      };

      const prefix = 카테고리PREFIX[카테고리] || 'ETC';
      const ss = e.source;
      const 마스터시트 = ss.getSheetByName("장비마스터");
      const 마스터lastRow = 마스터시트.getLastRow();
      const IDs = 마스터시트.getRange(2, 2, 마스터lastRow-1, 1).getValues()
        .flat()
        .filter(id => id && id.toString().startsWith(prefix));

      let maxNum = 0;
      IDs.forEach(id => {
        const num = parseInt(id.toString().split('-')[1]);
        if (num > maxNum) maxNum = num;
      });

      const newID = `${prefix}-${String(maxNum + 1).padStart(3, '0')}`;
      sheet.getRange(row, 3).setValue(newID);
    }
  }

  // ─── 신규: 확인요청 - 요청ID / 가용확인 ───
  // N열(14) 등록은 installable trigger(onEditInstallable)에서만 처리
  // → 다른 스프레드시트(개고생2.0) 접근에 OAuth 필요하기 때문
  if (sheet.getName() === "확인요청") {
    if (col === 2 || col === 8) {
      handleScheduleEdit(e);
    }
    // K열(11) 예약자명 입력 시 L열(12) 연락처 자동조회 수식 복원 + 동명이인 경고
    if (col === 11 && row >= 2) {
      var kCell = sheet.getRange(row, 11);
      var lCell = sheet.getRange(row, 12);
      var kVal = String(kCell.getValue() || "").trim();
      // 동명이인 체크: 고객DB에서 같은 이름이 몇 개 있는지 확인
      var dupCount = 0;
      try {
        var dbSheet = e.source.getSheetByName("고객DB");
        if (dbSheet && dbSheet.getLastRow() >= 2 && kVal) {
          var dbNames = dbSheet.getRange(2, 2, dbSheet.getLastRow() - 1, 1).getValues();
          for (var dni = 0; dni < dbNames.length; dni++) {
            if (String(dbNames[dni][0]).trim() === kVal) dupCount++;
          }
        }
      } catch(e1) {}

      if (dupCount > 1) {
        // 동명이인 존재 → L열 비우고 K열에 경고 메모
        lCell.clearContent();
        kCell.setNote("⚠️ 고객DB에 동명이인 " + dupCount + "명 존재\n연락처를 직접 입력하세요");
        kCell.setBackground("#FFEB9C");
      } else {
        // 단일 또는 미등록 → 자동조회 수식 설정 + 경고 제거
        kCell.clearNote();
        kCell.setBackground(null);
        if (!lCell.getFormula() && !lCell.getValue()) {
          lCell.setFormula(
            '=IF(K' + row + '="","",IFERROR(INDEX(\'고객DB\'!A:A,MATCH(K' + row + ',\'고객DB\'!B:B,0)),""))'
          );
        }
      }
    }
    // F열(6) 장비명 입력 시 위 계약/요청 행의 문맥 자동 상속
    if (col === 6 && row >= 3 && e.range.getValue()) {
      inheritConfirmRequestContextOnEquipmentEdit_(sheet, row);
    }
  }
}

/**
 * 확인요청 시트에서 기존 계약/요청의 마지막 장비 아래에 장비명만 추가했을 때
 * 위쪽 행의 요청ID/거래ID와 예약 문맥을 빈 칸에만 채운다.
 */
function inheritConfirmRequestContextOnEquipmentEdit_(sheet, row) {
  if (!sheet || row < 3) return;

  var equipmentName = String(sheet.getRange(row, 6).getValue() || "").trim();
  if (!equipmentName) return;

  var sourceRow = findPreviousConfirmRequestContextRow_(sheet, row);
  if (!sourceRow) return;

  copyBlankCellsFromRow_(sheet, sourceRow, row, 1, 5);   // A:E 요청ID/일시
  copyBlankCellsFromRow_(sheet, sourceRow, row, 11, 3);  // K:M 예약자명/연락처/할인유형
  copyBlankCellsFromRow_(sheet, sourceRow, row, 16, 1);  // P 거래ID
}

function findPreviousConfirmRequestContextRow_(sheet, row) {
  var startRow = Math.max(2, row - 50);
  var rowCount = row - startRow;
  if (rowCount <= 0) return null;

  var values = sheet.getRange(startRow, 1, rowCount, 16).getValues();
  for (var i = values.length - 1; i >= 0; i--) {
    var source = values[i];
    var hasRequestOrTradeId = String(source[0] || source[15] || "").trim();
    var hasReservationContext = source[1] || source[3] || source[10] || source[11] || source[12];
    if (hasRequestOrTradeId && hasReservationContext) {
      return startRow + i;
    }
  }
  return null;
}

function copyBlankCellsFromRow_(sheet, sourceRow, targetRow, col, width) {
  var sourceRange = sheet.getRange(sourceRow, col, 1, width);
  var targetRange = sheet.getRange(targetRow, col, 1, width);
  var sourceValues = sourceRange.getValues()[0];
  var targetValues = targetRange.getValues()[0];
  var changed = false;

  for (var i = 0; i < width; i++) {
    if ((targetValues[i] === "" || targetValues[i] === null) && sourceValues[i] !== "" && sourceValues[i] !== null) {
      targetValues[i] = sourceValues[i];
      changed = true;
    }
  }

  if (changed) {
    targetRange.setValues([targetValues]);
    targetRange.setNumberFormats(sourceRange.getNumberFormats());
  }
}

function scheduleDetailContractRegenColumnsTouched_(startCol, colCount) {
  var endCol = startCol + (Number(colCount) || 1) - 1;
  // B:I = 거래ID/품목/수량/일시, L = 단가. 계약서 생성 입력값만 대상으로 한다.
  return !(endCol < 2 || startCol > 12) && (
    !(endCol < 2 || startCol > 9) ||
    (startCol <= 12 && endCol >= 12)
  );
}

function queueScheduleDetailContractRegensForRows_(sheet, rows, extraTradeIds) {
  if (!sheet || sheet.getName() !== "스케줄상세") return [];

  var rowSeen = {};
  var cleanRows = [];
  (rows || []).forEach(function(r) {
    var rowNum = Number(r);
    if (rowNum < 2 || rowSeen[rowNum]) return;
    rowSeen[rowNum] = true;
    cleanRows.push(rowNum);
  });

  var tradeIds = {};
  function addTradeId(raw) {
    var tradeId = String(raw || "").trim();
    if (tradeId) tradeIds[tradeId] = true;
  }

  (extraTradeIds || []).forEach(addTradeId);

  if (cleanRows.length > 0) {
    var minRow = Math.min.apply(null, cleanRows);
    var maxRow = Math.max.apply(null, cleanRows);
    var bValues = sheet.getRange(minRow, 2, maxRow - minRow + 1, 1).getValues();
    cleanRows.forEach(function(rowNum) {
      addTradeId(bValues[rowNum - minRow][0]);
    });
  }

  var queued = [];
  Object.keys(tradeIds).forEach(function(tradeId) {
    scheduleContractRegen(tradeId);
    queued.push(tradeId);
  });
  return queued;
}

function queueScheduleDetailContractRegensForEdit_(sheet, range, oldValue) {
  if (!sheet || sheet.getName() !== "스케줄상세" || !range) return [];

  var row = range.getRow();
  var rowCount = range.getNumRows ? range.getNumRows() : 1;
  var col = range.getColumn();
  var colCount = range.getNumColumns ? range.getNumColumns() : 1;
  if (row + rowCount - 1 < 2) return [];
  if (!scheduleDetailContractRegenColumnsTouched_(col, colCount)) return [];

  var rows = [];
  var startRow = Math.max(row, 2);
  for (var r = startRow; r <= row + rowCount - 1; r++) rows.push(r);

  var extraTradeIds = [];
  if (col === 2 && colCount === 1 && rowCount === 1 && oldValue) {
    extraTradeIds.push(oldValue);
  }
  return queueScheduleDetailContractRegensForRows_(sheet, rows, extraTradeIds);
}

/**
 * Installable trigger 전용 함수
 * N열(14) "등록" 처리 → 개고생2.0 거래내역 쓰기 포함
 *
 * 설치 방법: setupInstallableTrigger() 를 한 번 실행하면 자동 등록됨
 */
function onEditInstallable(e) {
  if (!e || !e.source) return;

  const sheet = e.source.getActiveSheet();
  const col = e.range.getColumn();
  const row = e.range.getRow();
  const editRowCount = e.range.getNumRows ? e.range.getNumRows() : 1;
  const editColCount = e.range.getNumColumns ? e.range.getNumColumns() : 1;
  if (row === 1 && editRowCount === 1) return;

  // 확인요청 시트를 사람이 직접 편집하면 헤이빌리 확인요청 목록 캐시를 비운다
  if (sheet.getName() === "확인요청" && typeof invalidateConfirmListCache_ === "function") {
    invalidateConfirmListCache_();
  }

  // 확인요청 A열: 거래ID만 입력하면 자동으로 RQ- 붙이기
  if (sheet.getName() === "확인요청" && col === 1 && row >= 2) {
    var aVal = String(e.range.getValue()).trim();
    if (aVal && !aVal.startsWith("RQ-") && /^\d{6}-\d{3}$/.test(aVal)) {
      e.range.setValue("RQ-" + aVal);
    }
  }

  if (sheet.getName() === "확인요청" && col === 14) {
    handleScheduleEdit(e);
  }

  // 계약마스터 J열(10) 계약상태 변경 → 상태별 후속 처리 + 대시보드 캐시 갱신
  // 여러 열 붙여넣기가 J를 가로질러도 반드시 같은 완료 검증을 거친다.
  var statusEditEndCol = col + editColCount - 1;
  if (sheet.getName() === "계약마스터" && col <= 10 && statusEditEndCol >= 10 && row + editRowCount - 1 >= 2) {
    var statusStartRow = Math.max(row, 2);
    var statusRowCount = row + editRowCount - statusStartRow;
    var statusValues = [];
    var statusLock = LockService.getScriptLock();
    var statusLockAcquired = false;
    try {
      statusValues = sheet.getRange(statusStartRow, 10, statusRowCount, 1).getDisplayValues();
      statusLock.waitLock(30000);
      statusLockAcquired = true;

      for (var statusIdx = 0; statusIdx < statusRowCount; statusIdx++) {
        handleContractMasterStatusEdit_(
          e.source,
          sheet,
          statusStartRow + statusIdx,
          statusValues[statusIdx][0],
          col === 10 && editColCount === 1 && statusRowCount === 1 ? e.oldValue : ""
        );
      }
    } catch (err) {
      Logger.log("계약마스터 계약상태 변경 처리 실패: " + err.message);
      // 검증 자체가 중간에 실패한 경우, 아직 검증됐다고 보장할 수 없는 완료값은 닫지 않는다.
      for (var restoreIdx = 0; restoreIdx < statusValues.length; restoreIdx++) {
        if (String(statusValues[restoreIdx][0] || "").trim() !== "반납완료") continue;
        var safeStatus = col === 10 && editColCount === 1 && statusRowCount === 1 && e.oldValue
          ? String(e.oldValue).trim()
          : "반출";
        sheet.getRange(statusStartRow + restoreIdx, 10).setValue(safeStatus || "반출");
        try { applyContractMasterStatusRowStyle_(sheet, statusStartRow + restoreIdx, safeStatus || "반출"); } catch (styleErr) {}
      }
    } finally {
      if (statusLockAcquired) try { statusLock.releaseLock(); } catch (statusReleaseErr) {}
    }
  }

  // 확인요청 K(예약자명) / L(연락처) 변경 시: 개고생2.0 고객DB 매칭 → M열(할인유형) 자동 채움
  if (sheet.getName() === "확인요청" && (col === 11 || col === 12) && row >= 2) {
    try {
      lookupDiscountFromCustomerDB(sheet, row);
    } catch (err) {
      Logger.log("고객DB 할인유형 조회 실패: " + err.message);
    }
  }

  // 스케줄상세 B열(거래ID) 입력 시: 반출일/시간 · 반납일/시간 · 예약자명 · 상태 · 스케줄ID 자동 채움
  if (sheet.getName() === "스케줄상세" && col === 2 && row >= 2) {
    try {
      var sd거래ID = String(e.range.getValue()).trim();
      if (sd거래ID) autoFillScheduleRow(e.source, sheet, row, sd거래ID);
    } catch (err) {
      Logger.log("스케줄상세 자동완성 실패: " + err.message);
    }
  }

  // 스케줄상세 C열(세트/장비명) 입력 시: 세트면 구성품 자동 펼침, 단품이면 D열·단가 자동 채움
  if (sheet.getName() === "스케줄상세" && col === 3 && row >= 2) {
    try {
      var cVal = String(e.range.getValue()).trim();
      if (cVal) autoExpandSetInSchedule(e.source, sheet, row, cVal);
    } catch (err) {
      Logger.log("스케줄상세 세트 펼침 실패: " + err.message);
    }
  }

  // 스케줄상세 수정 시 계약서 재생성 (디바운스) — 거래ID/품목/수량/일시/단가(B~I, L)
  // 일시·단가도 계약서에 찍히는 값이라 함께 재생성해야 함. 여러 행 붙여넣기도 모두 처리.
  if (sheet.getName() === "스케줄상세" && row + editRowCount - 1 >= 2) {
    try {
      var queuedTradeIds = queueScheduleDetailContractRegensForEdit_(sheet, e.range, e.oldValue);
      if (queuedTradeIds.length > 0) {
        Logger.log("스케줄상세 수정 → 계약서 재생성 예약: " + queuedTradeIds.join(", "));
      }
    } catch (err) {
      Logger.log("스케줄상세 수정 → 재생성 예약 실패: " + err.message);
    }

    // B~E(거래 귀속/세트/장비명/수량) 또는 J(행 상태)가 바뀌면
    // 예전 행 기준 반납 체크는 더 이상 증거가 아니다.
    var editEndCol = col + editColCount - 1;
    if ((col <= 5 && editEndCol >= 1) || (col <= 10 && editEndCol >= 10)) {
      var proofLock = LockService.getScriptLock();
      var proofLockAcquired = false;
      try {
        proofLock.waitLock(30000);
        proofLockAcquired = true;
        var proofStartRow = Math.max(row, 2);
        var proofRowCount = row + editRowCount - proofStartRow;
        var proofRows = sheet.getRange(proofStartRow, 1, proofRowCount, 2).getDisplayValues();
        var changedByTrade = {};
        var proofProps = PropertiesService.getScriptProperties();
        proofRows.forEach(function(values) {
          var scheduleId = String(values[0] || '').trim();
          var tradeId = String(values[1] || '').trim();
          if (!scheduleId) return;
          var oldProof = proofProps.getProperty('itemCheck_' + scheduleId + '_checkin');
          var oldProofTradeId = typeof dashboardReturnInspectionTradeId_ === 'function'
            ? dashboardReturnInspectionTradeId_(oldProof)
            : '';
          [tradeId, oldProofTradeId].forEach(function(affectedTradeId) {
            if (!affectedTradeId) return;
            if (!changedByTrade[affectedTradeId]) changedByTrade[affectedTradeId] = [];
            if (changedByTrade[affectedTradeId].indexOf(scheduleId) < 0) changedByTrade[affectedTradeId].push(scheduleId);
          });
        });
        if (col === 2 && editColCount === 1 && proofRowCount === 1 && e.oldValue) {
          var oldCellTradeId = String(e.oldValue).trim();
          var onlyScheduleId = String(proofRows[0] && proofRows[0][0] || '').trim();
          if (oldCellTradeId && onlyScheduleId) changedByTrade[oldCellTradeId] = [onlyScheduleId];
        }
        Object.keys(changedByTrade).forEach(function(tradeId) {
          var result = invalidateDashboardReturnInspectionForTrade_(tradeId, changedByTrade[tradeId], '스케줄상세 행 정체성 직접 변경');
          if (result && result.error) throw new Error(result.error);
        });
        var orphanResult = reconcileDashboardOrphanedReturnProofs_(sheet, proofProps, '스케줄상세 행 비우기/삭제');
        if (orphanResult && orphanResult.error) throw new Error(orphanResult.error);
      } catch (proofErr) {
        Logger.log("스케줄상세 행 변경 → 반납 재검수 전환 실패: " + proofErr.message);
        throw proofErr;
      } finally {
        if (proofLockAcquired) try { proofLock.releaseLock(); } catch (proofReleaseErr) {}
      }
    }
  }

  // 계약마스터 E-I열(반출일/시간 · 반납일/시간 · 회차) 수정 → 스케줄상세 + 거래내역 전파 + 계약서 재생성 예약
  if (sheet.getName() === "계약마스터" && col >= 5 && col <= 9 && row >= 2) {
    try {
      var cm거래ID = String(sheet.getRange(row, 1).getValue()).trim();
      if (cm거래ID) {
        // 5-8열(날짜/시간): 스케줄상세/거래내역 즉시 반영. 9열(회차)은 계약서 재생성만
        if (col >= 5 && col <= 8) {
          propagateContractDates(e.source, sheet, row, cm거래ID);
        }
        scheduleContractRegen(cm거래ID);
      }
    } catch (err) {
      Logger.log("계약마스터 일정 변경 처리 실패: " + err.message);
    }
  }

  // 계약마스터 B~D열(예약자명/연락처/업체명) 수정 → 계약서 임차인 정보 재생성 예약
  if (sheet.getName() === "계약마스터" && col >= 2 && col <= 4 && row >= 2) {
    try {
      var infoRowCount = e.range.getNumRows ? e.range.getNumRows() : 1;
      for (var infoIdx = 0; infoIdx < infoRowCount; infoIdx++) {
        var infoTradeId = String(sheet.getRange(row + infoIdx, 1).getValue()).trim();
        if (infoTradeId) scheduleContractRegen(infoTradeId);
      }
    } catch (err) {
      Logger.log("계약마스터 임차인정보 변경 처리 실패: " + err.message);
    }
  }

  // 계약마스터 K열(11) 할인유형 수정 → 계약서 재생성 예약
  if (sheet.getName() === "계약마스터" && col === 11 && row >= 2) {
    try {
      var discountRowCount = e.range.getNumRows ? e.range.getNumRows() : 1;
      for (var discountIdx = 0; discountIdx < discountRowCount; discountIdx++) {
        var discountTradeId = String(sheet.getRange(row + discountIdx, 1).getValue()).trim();
        if (discountTradeId) scheduleContractRegen(discountTradeId);
      }
    } catch (err) {
      Logger.log("계약마스터 할인유형 변경 처리 실패: " + err.message);
    }
  }

  // 세트마스터 수정(가격/장비) → 계약서 템플릿 마스터 동기화 (디바운스, 백그라운드)
  if (sheet.getName() === "세트마스터" && row >= 2) {
    try { scheduleTemplateMasterSync_(); }
    catch (err) { Logger.log("템플릿 마스터 동기화 예약 실패: " + err.message); }
  }
}

/**
 * 행 전체 clear/delete 뒤에는 A/B가 이미 비어 oldValue만으로 거래를 찾을 수 없다.
 * 남아 있는 반납 증거의 scheduleId를 현재 A열과 대조해 사라진 행의 계약을 재오픈한다.
 * 호출자는 반드시 ScriptLock을 보유해야 한다.
 */
function reconcileDashboardOrphanedReturnProofs_(sheet, props, reason) {
  try {
    if (!sheet || sheet.getName() !== '스케줄상세') return { success: true, reopened: 0 };
    props = props || PropertiesService.getScriptProperties();
    var currentIds = {};
    if (sheet.getLastRow() >= 2) {
      sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getDisplayValues().forEach(function(row) {
        var sid = String(row[0] || '').trim();
        if (sid) currentIds[sid] = true;
      });
    }
    var byTrade = {};
    var all = props.getProperties();
    Object.keys(all).forEach(function(key) {
      var match = key.match(/^itemCheck_(.+)_checkin$/);
      if (!match) return;
      var scheduleId = String(match[1] || '').trim();
      if (!scheduleId || currentIds[scheduleId]) return;
      var tradeId = typeof dashboardReturnInspectionTradeId_ === 'function'
        ? dashboardReturnInspectionTradeId_(all[key])
        : '';
      if (!tradeId) tradeId = scheduleId.replace(/-\d+$/, '');
      if (!tradeId || tradeId === scheduleId) return;
      if (!byTrade[tradeId]) byTrade[tradeId] = [];
      byTrade[tradeId].push(scheduleId);
    });
    Object.keys(byTrade).forEach(function(tradeId) {
      var result = invalidateDashboardReturnInspectionForTrade_(tradeId, byTrade[tradeId], reason || '스케줄 행 삭제');
      if (result && result.error) throw new Error(result.error);
    });
    return { success: true, reopened: Object.keys(byTrade).length };
  } catch (err) {
    return { error: '삭제 행 반납 재검수 실패: ' + (err && err.message ? err.message : String(err)) };
  }
}

/** 설치형 onChange: 행 구조 삭제는 onEdit가 발생하지 않으므로 별도 감시한다. */
function onChangeInstallable(e) {
  if (!e || !e.source || e.changeType !== 'REMOVE_ROW') return;
  var sheet = e.source.getActiveSheet();
  if (!sheet || sheet.getName() !== '스케줄상세') return;
  var lock = LockService.getScriptLock();
  var acquired = false;
  try {
    lock.waitLock(30000);
    acquired = true;
    var result = reconcileDashboardOrphanedReturnProofs_(
      sheet, PropertiesService.getScriptProperties(), '스케줄상세 행 구조 삭제'
    );
    if (result && result.error) throw new Error(result.error);
  } finally {
    if (acquired) try { lock.releaseLock(); } catch (releaseErr) {}
  }
}

function handleContractMasterStatusEdit_(ss, sheet, row, rawStatus, oldStatus) {
  var status = String(rawStatus || '').trim();
  var previousStatus = String(oldStatus || '').trim();
  var tradeId = String(sheet.getRange(row, 1).getValue()).trim();

  if (status === "취소") {
    if (tradeId) {
      var checkoutStarted = previousStatus === '반출' || previousStatus === '반출중' || previousStatus === '반납완료';
      if (!checkoutStarted && typeof isDashboardTradeCheckoutStarted_ === 'function') {
        checkoutStarted = isDashboardTradeCheckoutStarted_(ss, tradeId);
      }
      if (checkoutStarted) {
        sheet.getRange(row, 10).setValue(previousStatus || '반출');
        try { ss.toast('이미 반출된 거래는 취소할 수 없습니다. 반납 절차로 마감해주세요.', '취소 차단', 6); } catch (toastErr) {}
        return;
      }
      var cancelProps = PropertiesService.getScriptProperties();
      cancelProps.deleteProperty('returnDone_' + tradeId);
      cancelProps.deleteProperty('returnPrevContractStatus_' + tradeId);
      cancelContract(ss, tradeId, row);
      ensureCancelledTradeCleanupTrigger_(1000);
    }
    return;
  }

  if (status === "반납완료" && tradeId) {
    var hadCancelStyle = typeof isContractMasterCancelStyle_ === "function"
      ? isContractMasterCancelStyle_(sheet, row)
      : false;
    var hasScheduleRows = typeof hasScheduleRowsForTrade_ === "function"
      ? hasScheduleRowsForTrade_(ss, tradeId)
      : true;

    if (previousStatus === "취소" || hadCancelStyle || !hasScheduleRows) {
      var restoreProps = PropertiesService.getScriptProperties();
      restoreProps.deleteProperty('returnDone_' + tradeId);
      restoreProps.deleteProperty('returnPrevContractStatus_' + tradeId);
      sheet.getRange(row, 10).setValue("취소");
      cancelContract(ss, tradeId, row);
      ensureCancelledTradeCleanupTrigger_(1000);
      return;
    }

    var completionCheck;
    try {
      completionCheck = typeof assertDashboardReturnComplete_ === "function"
        ? assertDashboardReturnComplete_(tradeId, PropertiesService.getScriptProperties())
        : { error: "반납완료 차단: 품목 검증 함수를 찾을 수 없습니다" };
    } catch (validationErr) {
      completionCheck = {
        error: "반납완료 차단: 품목 검증 실패 — " +
          (validationErr && validationErr.message ? validationErr.message : String(validationErr))
      };
    }
    if (completionCheck && completionCheck.error) {
      var restoreStatus = previousStatus && previousStatus !== "반납완료" ? previousStatus : "반출";
      var incompleteProps = PropertiesService.getScriptProperties();
      incompleteProps.deleteProperty('returnDone_' + tradeId);
      incompleteProps.deleteProperty('returnPrevContractStatus_' + tradeId);
      sheet.getRange(row, 10).setValue(restoreStatus);
      if (typeof applyContractMasterStatusRowStyle_ === "function") {
        applyContractMasterStatusRowStyle_(sheet, row, restoreStatus);
      }
      try { ss.toast(completionCheck.error, "반납완료 차단", 8); } catch (toastErr) {}
      return;
    }
  }

  if (typeof applyContractMasterStatusRowStyle_ === "function") {
    applyContractMasterStatusRowStyle_(sheet, row, status);
  }

  if (tradeId) {
    var props = PropertiesService.getScriptProperties();
    if (status === "반납완료") {
      props.setProperty('returnDone_' + tradeId, '1');
    } else {
      props.deleteProperty('returnDone_' + tradeId);
      props.deleteProperty('returnPrevContractStatus_' + tradeId);
    }
  }

  try { invalidateDashboardCache(); } catch (cacheErr) {}
}

/**
 * 확인요청 K(예약자명) / L(연락처)을 입력하면 개고생2.0 고객DB에서 연락처로 매칭해
 * 할인유형(D열)이 '단골' 또는 '제휴'이면 확인요청 M열에 자동 채움.
 * 연락처 부재 시 이름으로 매칭 (동명이인은 이미 다른 로직이 경고 처리).
 * 이미 M열에 값이 있으면 덮어쓰지 않음(수동 입력 보존).
 */
/**
 * 연락처 정규화: 숫자만 남기고 맨 앞 0 제거 → 뒤 10자리로 통일.
 * 예: "010-4506-6615" → "1045066615", 1045066615 (숫자) → "1045066615",
 *     "82-10-4506-6615" → "82104506661510"? (국가코드 포함 시 주의 — 보통 010으로 저장됨)
 * 매칭 기준: 끝 10자리만 비교 (가장 안전)
 */
function _normPhone(v) {
  var s = String(v == null ? "" : v).replace(/[^0-9]/g, "");
  return s.length > 10 ? s.slice(-10) : s;
}

/**
 * 메뉴에서 호출: 현재 선택한 확인요청 행의 할인유형을 고객DB에서 재조회.
 * 성공/실패 토스트로 이유까지 표시 (진단 포함).
 */
function lookupDiscountForSelectedRow() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getActiveSheet();
  var ui = SpreadsheetApp.getUi();
  var row = sheet.getActiveCell().getRow();

  if (sheet.getName() !== "확인요청") {
    ss.toast("확인요청 시트에서 행을 선택하고 다시 눌러주세요", "⚠️ 위치 오류", 5);
    return;
  }
  if (row < 2) {
    ss.toast("헤더가 아닌 데이터 행을 선택해주세요", "⚠️ 행 오류", 5);
    return;
  }

  var 예약자명 = String(sheet.getRange(row, 11).getValue() || "").trim();
  var 연락처Raw = sheet.getRange(row, 12).getValue();
  var 연락처Norm = _normPhone(연락처Raw);

  var url = PropertiesService.getScriptProperties().getProperty("개고생2_URL");
  if (!url) { ui.alert("개고생2_URL 속성 없음"); return; }
  var dbSheet;
  try {
    dbSheet = SpreadsheetApp.openByUrl(url).getSheetByName("고객DB");
  } catch (e) { ui.alert("개고생2.0 열기 실패: " + e.message); return; }
  if (!dbSheet || dbSheet.getLastRow() < 2) { ui.alert("고객DB 시트/데이터 없음"); return; }

  var data = dbSheet.getRange(2, 1, dbSheet.getLastRow() - 1, 9).getValues();
  var matches = [];
  for (var i = 0; i < data.length; i++) {
    var dbTel = _normPhone(data[i][0]);
    var dbName = String(data[i][1] || "").trim();
    var telMatch = 연락처Norm && dbTel && dbTel === 연락처Norm;
    var nameMatch = 예약자명 && dbName === 예약자명;
    if (telMatch || nameMatch) {
      matches.push({
        이름: dbName,
        폰: String(data[i][0] || ""),
        할인유형: String(data[i][8] || ""),
        방식: telMatch ? "폰" : "이름"
      });
    }
  }

  if (matches.length === 0) {
    ui.alert(
      "❌ 매칭 실패\n\n" +
      "검색값:\n  이름 = " + (예약자명 || "(빈칸)") + "\n  폰(정규화) = " + (연락처Norm || "(빈칸)") + "\n\n" +
      "→ 개고생2.0 고객DB에 이 고객 없음 또는 이름/폰 상이."
    );
    return;
  }

  var best = matches.find(function(m) { return m.할인유형 === "단골" || m.할인유형 === "제휴"; });
  if (!best) {
    var listStr = matches.map(function(m) {
      return "· " + m.이름 + " / " + m.폰 + " / I열='" + (m.할인유형 || "(빈칸)") + "' (매칭:" + m.방식 + ")";
    }).join("\n");
    ui.alert(
      "⚠️ 후보는 찾았지만 I열이 '단골'/'제휴'가 아님\n\n" + listStr +
      "\n\n→ 개고생2.0 고객DB 해당 행 I열에 정확히 '단골' 또는 '제휴' 입력 필요."
    );
    return;
  }

  sheet.getRange(row, 13).setValue(best.할인유형);
  ss.toast("✅ " + best.이름 + " → " + best.할인유형 + " (" + best.방식 + " 매칭)", "성공", 8);
}

// 고객DB 할인유형 캐시 — K/L 편집마다 외부 시트 전체를 읽던 왕복(1~2초) 제거
var CUSTOMER_DISCOUNT_CACHE_KEY_ = "customerDiscountMap_v1";
var CUSTOMER_DISCOUNT_CACHE_TTL_SEC_ = 300;

/**
 * 개고생2.0 고객DB를 { tel: {폰정규화→할인유형}, name: {성함→할인유형} } 맵으로 반환.
 * ScriptCache 300초 캐시. 기존 매칭과 동일하게 중복 폰/성함은 먼저 나온 행 우선.
 * 고객DB 수백 행 기준 JSON 수십 KB 수준 — 캐시 한도(100KB) 근접 시 put 생략(매번 라이브 읽기로 동작).
 */
function _getCustomerDiscountMap_() {
  var cache = CacheService.getScriptCache();
  var cached = cache.get(CUSTOMER_DISCOUNT_CACHE_KEY_);
  if (cached) {
    try { return JSON.parse(cached); } catch (e) {}
  }

  var url = PropertiesService.getScriptProperties().getProperty("개고생2_URL");
  if (!url) return null;
  var dbSheet;
  try {
    dbSheet = SpreadsheetApp.openByUrl(url).getSheetByName("고객DB");
  } catch (e2) { return null; }
  if (!dbSheet || dbSheet.getLastRow() < 2) return null;

  // A=예약자ID(휴대폰), B=성함, C=누적이용횟수, D=소개건수, E=소개리워드발급,
  // F=소개리워드사용, G=5회쿠폰발송, H=10회쿠폰발송, I=할인유형
  var data = dbSheet.getRange(2, 1, dbSheet.getLastRow() - 1, 9).getValues();
  var map = { tel: {}, name: {} };
  for (var i = 0; i < data.length; i++) {
    var dbTel = _normPhone(data[i][0]);
    var dbName = String(data[i][1] || "").trim();
    var 할인 = String(data[i][8] || "").trim(); // I열
    if (dbTel && !Object.prototype.hasOwnProperty.call(map.tel, dbTel)) map.tel[dbTel] = 할인;
    if (dbName && !Object.prototype.hasOwnProperty.call(map.name, dbName)) map.name[dbName] = 할인;
  }

  try {
    var json = JSON.stringify(map);
    if (json.length < 95000) cache.put(CUSTOMER_DISCOUNT_CACHE_KEY_, json, CUSTOMER_DISCOUNT_CACHE_TTL_SEC_);
  } catch (e3) {}
  return map;
}

function lookupDiscountFromCustomerDB(sheet, row) {
  // K(예약자명)/L(연락처)/M(할인유형)을 한 번에 읽음
  var klm = sheet.getRange(row, 11, 1, 3).getValues()[0];
  var existing = String(klm[2] || "").trim();
  if (existing && existing !== "일반") return; // 이미 입력됨

  var 예약자명 = String(klm[0] || "").trim();
  var 연락처Norm = _normPhone(klm[1]);
  if (!예약자명 && !연락처Norm) return;

  var map = _getCustomerDiscountMap_();
  if (!map) return;

  // 기존 매칭과 동일: 연락처가 있으면 폰으로만, 없으면 성함으로만 조회
  var matched = 연락처Norm
    ? (Object.prototype.hasOwnProperty.call(map.tel, 연락처Norm) ? map.tel[연락처Norm] : undefined)
    : (Object.prototype.hasOwnProperty.call(map.name, 예약자명) ? map.name[예약자명] : undefined);
  if (matched === undefined) {
    Logger.log("고객DB 매칭 실패 — 이름:" + 예약자명 + " 폰(norm):" + 연락처Norm);
    return;
  }

  var 할인 = String(matched || "").trim();  // I열
  // 단골/제휴만 자동 채움. 학생/개사프리는 Cowork 파싱이 담당.
  if (할인 === "단골" || 할인 === "제휴") {
    sheet.getRange(row, 13).setValue(할인);
    Logger.log("고객DB 매칭 → " + 예약자명 + " 할인유형 " + 할인);
  }
}

/**
 * 계약마스터 K/L 스왑 + 할인유형 드롭다운 + 헤더 서식 통일.
 * 고객DB I열 '할인유형' 헤더도 세팅.
 *
 * 최종 구조: K=할인유형(드롭다운), L=비고
 * 기존 L1='할인유형', K1='비고'였던 상태에서 호출하면
 *   1) K열 전체를 L열로, L열 전체를 K열로 복사(헤더 포함)
 *   2) 헤더 bold + 중앙정렬 기존 헤더들과 통일
 *   3) K열 드롭다운 규칙 적용(일반/학생/개인사업자·프리랜서/단골/제휴)
 * 멱등: 이미 K1='할인유형'이면 스왑 스킵, 드롭다운/서식만 갱신.
 */
function setupDiscountColumns() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var out = [];

  var cm = ss.getSheetByName("계약마스터");
  if (cm) {
    var maxRow = cm.getMaxRows();
    var lastRow = cm.getLastRow();
    var k1 = String(cm.getRange(1, 11).getValue() || "").trim();
    var l1 = String(cm.getRange(1, 12).getValue() || "").trim();

    // 1) K↔L 스왑 (K1 !== 할인유형일 때만)
    if (k1 !== "할인유형") {
      if (lastRow >= 1) {
        var kData = cm.getRange(1, 11, lastRow, 1).getValues();
        var lData = cm.getRange(1, 12, lastRow, 1).getValues();
        // 헤더 행 강제 세팅
        kData[0][0] = "할인유형";
        lData[0][0] = "비고";
        cm.getRange(1, 11, lastRow, 1).setValues(kData.map(function(r, i) {
          return i === 0 ? ["할인유형"] : [lData[i] ? lData[i][0] : ""];
        }));
        cm.getRange(1, 12, lastRow, 1).setValues(lData.map(function(r, i) {
          return i === 0 ? ["비고"] : [kData[i] ? kData[i][0] : ""];
        }));
        out.push("계약마스터 K↔L 스왑 완료 (" + (lastRow - 1) + "행)");
      } else {
        cm.getRange(1, 11).setValue("할인유형");
        cm.getRange(1, 12).setValue("비고");
        out.push("계약마스터 K1/L1 헤더만 세팅 (데이터 없음)");
      }
    } else {
      out.push("계약마스터 K1 이미 '할인유형'");
    }

    // 2) 헤더 서식 통일 (A1:L1 bold + 가운데 정렬)
    cm.getRange(1, 1, 1, 12).setFontWeight("bold").setHorizontalAlignment("center");

    // 3) K열 할인유형 드롭다운 (시트 최대 행까지)
    var disRule = SpreadsheetApp.newDataValidation()
      .requireValueInList(["일반", "학생", "개인사업자/프리랜서", "단골", "제휴"], true)
      .setAllowInvalid(true)
      .setHelpText("일반/학생/개인사업자/프리랜서/단골/제휴")
      .build();
    cm.getRange(2, 11, maxRow - 1, 1).setDataValidation(disRule);
    out.push("계약마스터 K열 드롭다운 적용");
  }

  // 4) 고객DB I열 헤더 + 드롭다운
  try {
    var url = PropertiesService.getScriptProperties().getProperty("개고생2_URL");
    if (url) {
      var dbSheet = SpreadsheetApp.openByUrl(url).getSheetByName("고객DB");
      if (dbSheet) {
        var i1 = dbSheet.getRange(1, 9).getValue();
        if (!i1) {
          dbSheet.getRange(1, 9).setValue("할인유형").setFontWeight("bold");
          out.push("개고생2.0 고객DB I1=할인유형 추가");
        } else {
          out.push("고객DB I1 이미 있음: " + i1);
        }
        // I2:I 끝까지 드롭다운 적용 (단골/제휴만 자동 매칭 대상. '일반' 등 구분용)
        var dbMaxRow = dbSheet.getMaxRows();
        var dbDisRule = SpreadsheetApp.newDataValidation()
          .requireValueInList(["일반", "학생", "개인사업자/프리랜서", "단골", "제휴"], true)
          .setAllowInvalid(true)
          .setHelpText("단골/제휴만 확인요청 M열에 자동 채움됨")
          .build();
        dbSheet.getRange(2, 9, dbMaxRow - 1, 1).setDataValidation(dbDisRule);
        out.push("고객DB I열 드롭다운 적용");
      }
    }
  } catch (e) { out.push("고객DB 업데이트 실패: " + e.message); }

  return out.join(" | ");
}

/**
 * 스케줄상세에서 새 행이 추가될 때 같은 거래ID 그룹의 기존 행 배경색을 복사.
 * formatScheduleSheet 전체 재실행보다 훨씬 가벼움 (read 1행, write N행).
 * @param {Sheet} sheet 스케줄상세
 * @param {string} 거래ID
 * @param {number[]} targetRows 배경 입힐 새 행들 (이 행들은 source 후보에서 제외)
 */
/**
 * 일회성 정리: 스케줄상세 E열에 박힌 '1세트' 텍스트를 모두 숫자 1로 교체.
 * 과거 버그로 들어간 깨진 데이터 복구용.
 */
function fixSchedQuantityTextOne() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sched = ss.getSheetByName("스케줄상세");
  if (!sched || sched.getLastRow() < 2) return "스케줄상세 비어있음";
  var lastRow = sched.getLastRow();
  var range = sched.getRange(2, 5, lastRow - 1, 1);  // E열
  var values = range.getValues();
  var fixed = 0;
  for (var i = 0; i < values.length; i++) {
    var v = String(values[i][0] || "").trim();
    if (v === "1세트" || v === "1 세트") {
      values[i][0] = 1;
      fixed++;
    }
  }
  if (fixed > 0) range.setValues(values);
  return "✅ 스케줄상세 수량 '1세트' → 1 변환: " + fixed + "건";
}

function _inheritGroupBackground(sheet, 거래ID, targetRows) {
  if (!targetRows || targetRows.length === 0) return;
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return;
  var lastCol = sheet.getLastColumn() || 13;

  var bData = sheet.getRange(2, 2, lastRow - 1, 1).getValues();
  var targetSet = {};
  targetRows.forEach(function(r) { targetSet[r] = true; });

  var sourceRow = null;
  for (var i = 0; i < bData.length; i++) {
    var rowNum = i + 2;
    if (targetSet[rowNum]) continue;
    if (String(bData[i][0]).trim() === 거래ID) { sourceRow = rowNum; break; }
  }
  if (!sourceRow) return;  // 새 거래ID — 배경 미상속, 다음 register 플로우에서 정렬됨

  var bgs = sheet.getRange(sourceRow, 1, 1, lastCol).getBackgrounds();
  targetRows.forEach(function(r) {
    sheet.getRange(r, 1, 1, lastCol).setBackgrounds(bgs);
  });
}

/**
 * 스케줄상세 C열(세트/장비명)이 입력되면:
 *   - 세트마스터에 세트로 등록되어 있으면 → 현재 행을 세트 대표행으로 만들고(D=세트명, 수량=1, 단가=세트단가),
 *     구성품을 바로 아래 행들에 삽입(D=구성품, 수량=구성품수량, 단가=0).
 *   - 세트가 아닌 단품이면 → D열에 동일값, 수량=1, 단가 자동 조회.
 *   - 거래ID가 비어있으면 경고만 남기고 스킵.
 * 기존 D열에 이미 값이 있는 경우는 덮어쓰지 않음(사용자 수동 편집 보존).
 */
function autoExpandSetInSchedule(ss, sheet, row, 세트명) {
  var 거래ID = String(sheet.getRange(row, 2).getValue()).trim();
  if (!거래ID) {
    sheet.getRange(row, 11).setValue("❌ B열 거래ID 먼저 입력").setBackground("#FFC7CE");
    return;
  }
  var setSheet = ss.getSheetByName("세트마스터");
  if (!setSheet) return;

  var currentD = String(sheet.getRange(row, 4).getValue()).trim();
  // 세트마스터는 "단품 행"(A=이름, B=빈칸, G=단가)도 포함하므로,
  // 실제 구성품(이름 있는 것)만 추려냄. 자기 자신과 같은 이름도 제거(무한 확장 방지).
  var components = getSetComponents(세트명, setSheet).filter(function(c) {
    var n = String(c.name || "").trim();
    return n !== "" && n !== 세트명;
  });
  var price = findSetPrice(세트명, setSheet);

  if (components.length > 0) {
    // === 세트 ===
    // 현재 행을 세트 대표행으로 설정 (D가 비어있을 때만 덮어씀)
    if (!currentD) sheet.getRange(row, 4).setValue(세트명);
    // 수량은 항상 숫자 1 (계약서 수식에서 수량×일수×단가 계산되므로 텍스트 '1세트' 쓰면 #VALUE 오류)
    if (!sheet.getRange(row, 5).getValue()) sheet.getRange(row, 5).setValue(1);
    if (!sheet.getRange(row, 12).getValue()) sheet.getRange(row, 12).setValue(price);

    // 이미 같은 세트의 구성품 행이 아래에 있으면 중복 생성 방지 체크
    var lastRow = sheet.getLastRow();
    var belowCheckRange = Math.min(components.length + 2, lastRow - row);
    if (belowCheckRange > 0) {
      var below = sheet.getRange(row + 1, 2, belowCheckRange, 2).getValues();  // B거래ID, C세트명
      var hasComponents = 0;
      for (var i = 0; i < below.length; i++) {
        if (String(below[i][0]).trim() === 거래ID && String(below[i][1]).trim() === 세트명) {
          hasComponents++;
        } else break;
      }
      if (hasComponents >= components.length) {
        sheet.getRange(row, 11).setValue("ℹ️ 이미 구성품 있음 — 재삽입 안 함").setBackground("#FFF2CC");
        return;
      }
    }

    // 구성품 행 삽입
    var headerValues = sheet.getRange(row, 1, 1, 13).getValues()[0];
    sheet.insertRowsAfter(row, components.length);

    var maxN = 0;
    var sLast2 = sheet.getLastRow();
    if (sLast2 >= 2) {
      var sIds = sheet.getRange(2, 1, sLast2 - 1, 1).getValues().flat();
      var re = new RegExp("^" + 거래ID.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "-(\\d+)$");
      sIds.forEach(function(sid) {
        var m = String(sid).match(re);
        if (m) { var n = parseInt(m[1], 10); if (n > maxN) maxN = n; }
      });
    }

    var newRows = [];
    for (var j = 0; j < components.length; j++) {
      maxN++;
      newRows.push([
        거래ID + "-" + ("0" + maxN).slice(-2),  // A 스케줄ID
        거래ID,                                   // B 거래ID
        세트명,                                   // C 세트명 (그룹핑)
        components[j].name,                      // D 구성품 장비명
        components[j].qty || 1,                   // E 수량
        headerValues[5],                          // F 반출일
        headerValues[6],                          // G 반출시간
        headerValues[7],                          // H 반납일
        headerValues[8],                          // I 반납시간
        "대기",                                   // J 상태
        "",                                       // K 비고
        0,                                        // L 단가 (구성품은 0, 대표행이 세트 단가)
        headerValues[12]                          // M 예약자명
      ]);
    }
    // 숫자열은 숫자로 남기고 텍스트(시간)는 @ 서식 유지하기 위해 범위 지정 후 setValues
    sheet.getRange(row + 1, 1, newRows.length, 13).setValues(newRows);
    sheet.getRange(row + 1, 6, newRows.length, 1).setNumberFormat("yyyy-MM-dd");
    sheet.getRange(row + 1, 7, newRows.length, 1).setNumberFormat("@");
    sheet.getRange(row + 1, 8, newRows.length, 1).setNumberFormat("yyyy-MM-dd");
    sheet.getRange(row + 1, 9, newRows.length, 1).setNumberFormat("@");

    sheet.getRange(row, 11).clearContent().setBackground(null);

    // 그룹 배경 상속 (대표행 + 구성품 행 모두)
    var inheritRows = [row];
    for (var ri = 0; ri < newRows.length; ri++) inheritRows.push(row + 1 + ri);
    _inheritGroupBackground(sheet, 거래ID, inheritRows);
  } else {
    // === 단품 ===
    if (!currentD) sheet.getRange(row, 4).setValue(세트명);
    if (!sheet.getRange(row, 5).getValue()) sheet.getRange(row, 5).setValue(1);
    if (!sheet.getRange(row, 12).getValue() && price) sheet.getRange(row, 12).setValue(price);
    sheet.getRange(row, 11).clearContent().setBackground(null);

    // 그룹 배경 상속
    _inheritGroupBackground(sheet, 거래ID, [row]);
  }

  if (typeof formatScheduleSheet === "function") {
    formatScheduleSheet(sheet);
  }
}

/**
 * 스케줄상세 B열(거래ID)이 입력되면 계약마스터에서 거래 정보를 읽어
 * 반출일/시간/반납일/시간/예약자명/상태/스케줄ID를 자동으로 채움.
 * 이미 값이 있는 셀은 건드리지 않음 — 사용자가 미리 입력한 건 존중.
 * 장비추가 워크플로우 단순화의 핵심: 거래ID만 치면 나머지 거의 다 채워짐.
 */
function autoFillScheduleRow(ss, sheet, row, 거래ID) {
  var cm = ss.getSheetByName("계약마스터");
  if (!cm || cm.getLastRow() < 2) return;

  var cmRaw = cm.getRange(2, 1, cm.getLastRow() - 1, 8).getValues();
  var found = -1;
  for (var i = 0; i < cmRaw.length; i++) {
    if (String(cmRaw[i][0]).trim() === 거래ID) { found = i; break; }
  }
  if (found === -1) {
    sheet.getRange(row, 11).setValue("❌ 계약마스터에 없는 거래ID");
    sheet.getRange(row, 11).setBackground("#FFC7CE");
    return;
  }

  var 예약자명   = cmRaw[found][1];
  var 반출일str   = _fmtDateStr(cmRaw[found][4]);
  var 반납일str   = _fmtDateStr(cmRaw[found][6]);
  // 시간(F/H열)은 표시값이 필요 — 전체 getDisplayValues 대신 매칭 행만 1회 읽음
  var timeDisp = cm.getRange(found + 2, 6, 1, 3).getDisplayValues()[0];
  var 반출시간str = String(timeDisp[0] || "").trim();
  var 반납시간str = String(timeDisp[2] || "").trim();

  // 스케줄ID 생성: 거래ID-NN (기존 최대 번호 + 1)
  var sLast = sheet.getLastRow();
  var sIds = sLast >= 2 ? sheet.getRange(2, 1, sLast - 1, 1).getValues().flat() : [];
  var maxN = 0;
  var re = new RegExp("^" + 거래ID.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "-(\\d+)$");
  sIds.forEach(function(sid) {
    var m = String(sid).match(re);
    if (m) { var n = parseInt(m[1], 10); if (n > maxN) maxN = n; }
  });
  var newSid = 거래ID + "-" + ("0" + (maxN + 1)).slice(-2);

  // 현재 행 상태 확인 (빈 셀만 채우기)
  var rowData = sheet.getRange(row, 1, 1, 13).getValues()[0];
  var fills = {}; // 열번호 → 채울 값 (빈 셀만 — 값 있는 열은 절대 안 건드림)
  var fmts = {};  // 열번호 → 숫자 서식 (F~I만, 값 쓰기 전 적용)
  if (!rowData[0]) fills[1] = newSid;                                // A 스케줄ID
  if (!rowData[5]) { fmts[6] = "yyyy-MM-dd"; fills[6] = 반출일str; }  // F 반출일
  if (!rowData[6]) { fmts[7] = "@"; fills[7] = 반출시간str; }         // G 반출시간
  if (!rowData[7]) { fmts[8] = "yyyy-MM-dd"; fills[8] = 반납일str; }  // H 반납일
  if (!rowData[8]) { fmts[9] = "@"; fills[9] = 반납시간str; }         // I 반납시간
  if (!rowData[9]) fills[10] = "대기";                                // J 상태
  if (!rowData[12]) fills[13] = 예약자명;                             // M 예약자명

  // 연속 열 구간별로 묶어 한 번에 쓰기 — 셀 단위 setValue 왕복 제거
  var applyRuns = function(colMap, apply) {
    var cols = Object.keys(colMap).map(Number).sort(function(a, b) { return a - b; });
    var s = 0;
    while (s < cols.length) {
      var t = s;
      while (t + 1 < cols.length && cols[t + 1] === cols[t] + 1) t++;
      var run = [];
      for (var c = cols[s]; c <= cols[t]; c++) run.push(colMap[c]);
      apply(cols[s], run);
      s = t + 1;
    }
  };
  applyRuns(fmts, function(c0, run) { sheet.getRange(row, c0, 1, run.length).setNumberFormats([run]); });
  applyRuns(fills, function(c0, run) { sheet.getRange(row, c0, 1, run.length).setValues([run]); });

  // 상태바(K열 비고 활용)에 안내 — 장비명만 선택하면 됨 (D열은 위에서 이미 읽음)
  var 장비명Cell = rowData[3];
  if (!장비명Cell) {
    sheet.getRange(row, 11).setValue("👉 D열 장비명 선택하세요");
    sheet.getRange(row, 11).setBackground("#FFF2CC");
  } else {
    sheet.getRange(row, 11).clearContent().setBackground(null);
  }

  // 같은 거래ID 그룹의 기존 행 배경 상속 (formatScheduleSheet 전체 재실행 회피)
  _inheritGroupBackground(sheet, 거래ID, [row]);
  // K열 안내 메시지가 있으면 노란 배경 유지 — 헬프 메시지 위치 보존
  if (!장비명Cell) {
    sheet.getRange(row, 11).setBackground("#FFF2CC");
  }
}

/**
 * 날짜/시간 값을 register가 쓰는 문자열 포맷으로 변환 (Date → 'yyyy-MM-dd' / 'HH:mm').
 * Date 객체를 그대로 쓰면 스케줄상세 셀 서식이 1899-12-30으로 깨져서 반드시 문자열로.
 */
function _fmtDateStr(v) {
  if (v instanceof Date) return Utilities.formatDate(v, 'Asia/Seoul', 'yyyy-MM-dd');
  return String(v || '').trim();
}
function _fmtTimeStr(v) {
  if (v instanceof Date) return Utilities.formatDate(v, 'Asia/Seoul', 'HH:mm');
  return String(v || '').trim();
}

/**
 * 계약마스터 반출/반납 일시 변경을 스케줄상세와 개고생2.0 거래내역에 즉시 전파.
 * 같은 거래ID의 모든 스케줄상세 행은 계약마스터의 새 날짜/시간으로 통일됨.
 */
function propagateContractDates(ss, contractSheet, row, 거래ID) {
  // 날짜는 Date→yyyy-MM-dd 포맷, 시간은 사용자가 보는 표시값 그대로 복사 (LMT 역해석 회피)
  var 반출일Raw   = contractSheet.getRange(row, 5).getValue();
  var 반납일Raw   = contractSheet.getRange(row, 7).getValue();
  var 반출시간Disp = contractSheet.getRange(row, 6).getDisplayValue();
  var 반납시간Disp = contractSheet.getRange(row, 8).getDisplayValue();

  var 반출일str   = _fmtDateStr(반출일Raw);
  var 반출시간str = String(반출시간Disp || "").trim();
  var 반납일str   = _fmtDateStr(반납일Raw);
  var 반납시간str = String(반납시간Disp || "").trim();

  // 1) 스케줄상세 F~I열 덮어쓰기 (반출일/시간/반납일/시간) — 문자열 + 서식 복구
  var schedSheet = ss.getSheetByName("스케줄상세");
  if (schedSheet && schedSheet.getLastRow() >= 2) {
    var lastRow = schedSheet.getLastRow();
    var bCol = schedSheet.getRange(2, 2, lastRow - 1, 1).getValues();  // B열: 거래ID
    var updatedRows = 0;
    for (var i = 0; i < bCol.length; i++) {
      if (String(bCol[i][0]).trim() === 거래ID) {
        var r = i + 2;
        var rng = schedSheet.getRange(r, 6, 1, 4);
        // 이전 버그로 셀 포맷이 '1899-12-30'으로 깨진 상태를 복구
        rng.setNumberFormats([['yyyy-MM-dd', '@', 'yyyy-MM-dd', '@']]);
        rng.setValues([[반출일str, 반출시간str, 반납일str, 반납시간str]]);
        updatedRows++;
      }
    }
    Logger.log("스케줄상세 일정 전파: " + updatedRows + "행 (" + 거래ID + ")");
  }

  // 2) 개고생2.0 거래내역 A열(반출일) 업데이트 — 거래내역엔 반납일 필드 없음
  // ⚠️ 값이 실제로 다를 때만 setValue. 같은 값이면 setValue 안 함 →
  //    개고생2.0의 autoContract 트리거 폭주 방지 (AppSheet 부하 감소).
  try {
    var 개고생URL = PropertiesService.getScriptProperties().getProperty("개고생2_URL");
    if (개고생URL) {
      var 개고생SS = SpreadsheetApp.openByUrl(개고생URL);
      var 거래시트 = 개고생SS.getSheetByName("거래내역");
      if (거래시트 && 거래시트.getLastRow() >= 2) {
        // 2026-04-23 컬럼 재배치: 거래ID D(4) → E(5)
        var lastR = 거래시트.getLastRow();
        // 거래ID(E) + 반출일(A) 한 번에 읽기 — 행마다 getValue 호출 회피
        var aCol = 거래시트.getRange(2, 1, lastR - 1, 1).getValues();
        var eCol = 거래시트.getRange(2, 5, lastR - 1, 1).getValues();
        // 비교용으로 새 반출일을 'yyyy-MM-dd' 문자열 정규화
        var 새반출일str = (반출일Raw instanceof Date)
          ? Utilities.formatDate(반출일Raw, 'Asia/Seoul', 'yyyy-MM-dd')
          : String(반출일Raw || '').trim();
        for (var j = 0; j < eCol.length; j++) {
          if (String(eCol[j][0]).trim() !== 거래ID) continue;
          var 기존A = aCol[j][0];
          var 기존str = (기존A instanceof Date)
            ? Utilities.formatDate(기존A, 'Asia/Seoul', 'yyyy-MM-dd')
            : String(기존A || '').trim();
          if (기존str === 새반출일str) {
            // 동일 값 — 쓰기 스킵 (autoContract 폭주 방지)
            continue;
          }
          거래시트.getRange(j + 2, 1).setValue(반출일Raw);
          Logger.log("개고생2.0 거래내역 반출일 갱신: " + 기존str + " → " + 새반출일str + " (행 " + (j + 2) + " / " + 거래ID + ")");
        }
      }
    }
  } catch (err) {
    Logger.log("개고생2.0 거래내역 업데이트 실패: " + err.message);
  }
}

/**
 * LMT 복원: 저장된 Date 값에 +32분 8초 더하고 일(day) 정보 제거 → 순수 HH:mm 문자열.
 * 1899-12-31 04:27:52 → 05:00
 */
function _lmtRestoreHHmm(dateVal) {
  if (!(dateVal instanceof Date)) return String(dateVal || "").trim();
  // 저장된 ms에 32m08s(= 1928000ms) 더함
  var restored = new Date(dateVal.getTime() + 1928 * 1000);
  return Utilities.formatDate(restored, "Asia/Seoul", "HH:mm");
}

/**
 * 드라이런: scanCorruptedContractTimes 결과에 각 행의 제안 시간까지 붙여서 반환.
 * 실제 시트는 건드리지 않음. 사용자 검토용.
 */
function previewContractTimeFix() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var cm = ss.getSheetByName("계약마스터");
  if (!cm || cm.getLastRow() < 2) return [];
  var data = cm.getRange(2, 1, cm.getLastRow() - 1, 8).getValues();
  var tz = "Asia/Seoul";
  var out = [];
  for (var i = 0; i < data.length; i++) {
    var id = String(data[i][0]).trim();
    if (!id) continue;
    var ft = data[i][5], bt = data[i][7];
    var fCorrupt = (ft instanceof Date) && Utilities.formatDate(ft, tz, "yyyy-MM-dd") !== "1899-12-30";
    var bCorrupt = (bt instanceof Date) && Utilities.formatDate(bt, tz, "yyyy-MM-dd") !== "1899-12-30";
    if (!fCorrupt && !bCorrupt) continue;
    out.push({
      row: i + 2,
      거래ID: id,
      반출_현재: ft instanceof Date ? Utilities.formatDate(ft, tz, "HH:mm:ss") : String(ft),
      반출_제안: fCorrupt ? _lmtRestoreHHmm(ft) : (ft instanceof Date ? Utilities.formatDate(ft, tz, "HH:mm") : String(ft || "").trim()),
      반납_현재: bt instanceof Date ? Utilities.formatDate(bt, tz, "HH:mm:ss") : String(bt),
      반납_제안: bCorrupt ? _lmtRestoreHHmm(bt) : (bt instanceof Date ? Utilities.formatDate(bt, tz, "HH:mm") : String(bt || "").trim())
    });
  }
  return { count: out.length, items: out };
}

/**
 * 실제 적용: 계약마스터 F/H의 깨진 Date 값을 LMT 복원 문자열로 덮어쓰고
 * 셀 서식을 '@'(text)로 변경. 그리고 스케줄상세까지 resync.
 */
function applyContractTimeFix() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var cm = ss.getSheetByName("계약마스터");
  if (!cm || cm.getLastRow() < 2) return "계약마스터 없음";
  var data = cm.getRange(2, 1, cm.getLastRow() - 1, 8).getValues();
  var tz = "Asia/Seoul";
  var fixed = 0;
  for (var i = 0; i < data.length; i++) {
    var id = String(data[i][0]).trim();
    if (!id) continue;
    var ft = data[i][5], bt = data[i][7];
    var fCorrupt = (ft instanceof Date) && Utilities.formatDate(ft, tz, "yyyy-MM-dd") !== "1899-12-30";
    var bCorrupt = (bt instanceof Date) && Utilities.formatDate(bt, tz, "yyyy-MM-dd") !== "1899-12-30";
    if (fCorrupt) {
      cm.getRange(i + 2, 6).setNumberFormat("@").setValue(_lmtRestoreHHmm(ft));
      fixed++;
    }
    if (bCorrupt) {
      cm.getRange(i + 2, 8).setNumberFormat("@").setValue(_lmtRestoreHHmm(bt));
    }
  }
  // 스케줄상세까지 동일한 새 값으로 재전파 (기존 배치 함수 재사용)
  var resync = resyncAllContractDates();
  return "✅ 계약마스터 시간 복원 완료 (" + fixed + "개 F/H 셀 수정) | " + resync;
}

/**
 * 진단용: 계약마스터 F(반출시간) / H(반납시간) 중 1899-12-30이 아닌 Date 값(= 하루+이상 offset) 찾기.
 * 이런 값은 내부 fraction이 1을 넘어 HH:mm이 의도한 값과 달라진 깨진 셀.
 * 반환: [{row, 거래ID, 반출시간, 반납시간}, ...]
 */
function scanCorruptedContractTimes() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var cm = ss.getSheetByName("계약마스터");
  if (!cm || cm.getLastRow() < 2) return [];

  var data = cm.getRange(2, 1, cm.getLastRow() - 1, 8).getValues();
  var tz = "Asia/Seoul";
  var bad = [];
  for (var i = 0; i < data.length; i++) {
    var id = String(data[i][0]).trim();
    if (!id) continue;
    var 반출시간 = data[i][5];
    var 반납시간 = data[i][7];
    var reason = [];
    if (반출시간 instanceof Date) {
      var d1 = Utilities.formatDate(반출시간, tz, "yyyy-MM-dd");
      if (d1 !== "1899-12-30") reason.push("반출=" + d1 + " " + Utilities.formatDate(반출시간, tz, "HH:mm:ss"));
    }
    if (반납시간 instanceof Date) {
      var d2 = Utilities.formatDate(반납시간, tz, "yyyy-MM-dd");
      if (d2 !== "1899-12-30") reason.push("반납=" + d2 + " " + Utilities.formatDate(반납시간, tz, "HH:mm:ss"));
    }
    if (reason.length > 0) {
      bad.push({ row: i + 2, 거래ID: id, 반출시간: String(반출시간), 반납시간: String(반납시간), reason: reason.join(" | ") });
    }
  }
  return { count: bad.length, items: bad };
}

/**
 * 복구용 (스케줄상세 전용, 배치): 계약마스터 전체 1회 + 스케줄상세 F~I 1회 read/write.
 * 거래내역(개고생2.0)은 건드리지 않음 — 복구 속도가 핵심이므로.
 * 사용자가 보는 그대로를 전파하려고 getDisplayValues 사용 — LMT 역해석으로 값이 밀리는 문제 회피.
 */
function resyncAllContractDates() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var cm = ss.getSheetByName("계약마스터");
  if (!cm || cm.getLastRow() < 2) return "계약마스터 없음";
  var sched = ss.getSheetByName("스케줄상세");
  if (!sched || sched.getLastRow() < 2) return "스케줄상세 없음";

  // 계약마스터 한 번에 읽기 (A~H) — 시간 값은 표시값 그대로 사용
  var cmRaw = cm.getRange(2, 1, cm.getLastRow() - 1, 8).getValues();          // 날짜(Date)는 raw로
  var cmDisp = cm.getRange(2, 1, cm.getLastRow() - 1, 8).getDisplayValues();   // 시간 텍스트 보존용
  var contractMap = {};
  for (var i = 0; i < cmRaw.length; i++) {
    var id = String(cmRaw[i][0]).trim();
    if (!id) continue;
    contractMap[id] = [
      _fmtDateStr(cmRaw[i][4]),       // E 반출일 (Date → 'yyyy-MM-dd')
      String(cmDisp[i][5] || "").trim(), // F 반출시간 (사용자가 보는 텍스트 그대로)
      _fmtDateStr(cmRaw[i][6]),       // G 반납일
      String(cmDisp[i][7] || "").trim()  // H 반납시간
    ];
  }

  // 스케줄상세 B열(거래ID) + F~I열 한 번에 읽기
  var sRows = sched.getLastRow() - 1;
  var bCol = sched.getRange(2, 2, sRows, 1).getValues();
  var existing = sched.getRange(2, 6, sRows, 4).getValues();

  var newValues = [];
  var newFormats = [];
  var changed = 0;
  for (var j = 0; j < bCol.length; j++) {
    var id2 = String(bCol[j][0]).trim();
    var c = contractMap[id2];
    if (c) {
      newValues.push(c);
      changed++;
    } else {
      newValues.push(existing[j]);
    }
    newFormats.push(['yyyy-MM-dd', '@', 'yyyy-MM-dd', '@']);
  }

  var rng = sched.getRange(2, 6, sRows, 4);
  rng.setNumberFormats(newFormats);
  rng.setValues(newValues);

  return "✅ 스케줄상세 " + changed + "행 재전파/서식복구 완료";
}

/**
 * 계약서 재생성을 디바운스하여 예약.
 * - ScriptProperties에 마지막 편집 타임스탬프 기록
 * - regenPendingContracts 트리거가 없으면 3초 뒤 one-time 트리거 생성
 * - 이미 예약된 트리거가 있으면 그대로 두고 타임스탬프만 갱신
 * - 트리거가 fire되면 타임스탬프를 다시 읽어 안정 기간(2.8초) 지난 것만 처리
 */
var CONTRACT_REGEN_TRIGGER_PROP_ = 'contractRegenTriggerScheduledAt_v1';
var CONTRACT_REGEN_TRIGGER_STALE_MS_ = 10 * 60 * 1000;
var CONTRACT_REGEN_CLAIM_PREFIX_ = 'contractRegenClaim_v1_';
var CONTRACT_REGEN_CLAIM_LEASE_MS_ = 7 * 60 * 1000;
var CONTRACT_REGEN_RETRY_PREFIX_ = 'contractRegenRetry_v1_';
var CONTRACT_REGEN_MAX_ATTEMPTS_ = 5;
var CONTRACT_REGEN_WATCHDOG_PROP_ = 'contractRegenWatchdogAt_v1';
var CONTRACT_REGEN_WATCHDOG_HANDLER_ = 'regenPendingContractsWatchdog';

/** 임계구역에서도 안전한 계약서 queue 표식. ScriptApp I/O는 하지 않는다. */
function scheduleContractRegenUnderLock_(거래ID) {
  var props = PropertiesService.getScriptProperties();
  var now = Date.now();
  props.setProperty('contractEditTS_' + 거래ID, String(now));
  try { invalidateDashboardTradeExtraCache_([거래ID]); } catch (e0) {}

  // 거래 변경이 있었으니 dashboard/timeline 캐시도 즉시 무효화 → 다음 fetch는 fresh
  try { invalidateDashboardCache(); } catch (e) {}
  try { invalidateTimelineCache(); } catch (e2) {}
}

/** queue 표식 뒤 one-shot 트리거를 보장한다. 전역 ScriptLock 밖에서만 호출한다. */
function ensureContractRegenTrigger_() {
  var props = PropertiesService.getScriptProperties();
  var now = Date.now();
  try {
    var scheduledAt = Number(props.getProperty(CONTRACT_REGEN_TRIGGER_PROP_) || 0);
    var hasRecentScheduledTrigger = scheduledAt && (now - scheduledAt < CONTRACT_REGEN_TRIGGER_STALE_MS_);
    if (!hasRecentScheduledTrigger) {
      // 주의: GAS 일회성 트리거는 발화 후에도 목록에 남는다. 새 트리거 생성이 성공한
      // 뒤에만 좀비를 정리해 create 실패 때 실행 경로가 0개가 되지 않게 한다.
      var replacement = ScriptApp.newTrigger('regenPendingContracts').timeBased().after(3000).create();
      ScriptApp.getProjectTriggers().forEach(function(t) {
        if (t.getHandlerFunction() === 'regenPendingContracts' && t.getUniqueId() !== replacement.getUniqueId()) {
          try { ScriptApp.deleteTrigger(t); } catch (deleteErr) {}
        }
      });
      props.setProperty(CONTRACT_REGEN_TRIGGER_PROP_, String(now));
    }
  } catch (triggerErr) {
    // 원장 커밋은 이미 끝났다. 트리거 quota/API 오류가 성공 응답을 뒤집지 않게 하고,
    // 매분 rescueDashboardAsyncWorkerTriggers_가 다시 깨운다.
    props.deleteProperty(CONTRACT_REGEN_TRIGGER_PROP_);
    Logger.log('계약서 재생성 트리거 예약 실패(큐 보존): ' +
      (triggerErr && triggerErr.message ? triggerErr.message : String(triggerErr)));
  }
}

function scheduleContractRegen(거래ID) {
  scheduleContractRegenUnderLock_(거래ID);
  ensureContractRegenTrigger_();
}

function parseContractRegenRetry_(raw) {
  var retry = null;
  try { retry = JSON.parse(raw || 'null'); } catch (parseErr) {}
  if (!retry || typeof retry !== 'object') retry = {};
  retry.status = String(retry.status || 'pending');
  retry.attempts = Number(retry.attempts || 0);
  retry.nextAt = Number(retry.nextAt || 0);
  return retry;
}

/** 호출자는 ScriptLock을 보유해야 한다. active claim의 가장 이른 만료 시각에 watchdog 1개만 둔다. */
function armContractRegenWatchdogUnderLock_(props, fireAt) {
  var desiredAt = Math.max(Date.now() + 1000, Number(fireAt || 0));
  var currentAt = Number(props.getProperty(CONTRACT_REGEN_WATCHDOG_PROP_) || 0);
  if (currentAt > Date.now() && currentAt <= desiredAt + 1000) return;

  // 새 watchdog을 먼저 만든 뒤 이전 것들을 치운다. delete→create 사이 강제종료로
  // 복구 트리거가 0개가 되는 창을 만들지 않는다.
  var replacement = ScriptApp.newTrigger(CONTRACT_REGEN_WATCHDOG_HANDLER_)
    .timeBased()
    .after(Math.max(1000, desiredAt - Date.now()))
    .create();
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (
      t.getHandlerFunction() === CONTRACT_REGEN_WATCHDOG_HANDLER_ &&
      t.getUniqueId() !== replacement.getUniqueId()
    ) {
      ScriptApp.deleteTrigger(t);
    }
  });
  props.setProperty(CONTRACT_REGEN_WATCHDOG_PROP_, String(desiredAt));
}

/** 호출자는 ScriptLock을 보유해야 한다. 남은 claim에 맞춰 watchdog을 재계획한다. */
function refreshContractRegenWatchdogUnderLock_(props) {
  var all = props.getProperties();
  var earliestAt = Infinity;
  Object.keys(all).forEach(function(key) {
    if (key.indexOf(CONTRACT_REGEN_CLAIM_PREFIX_) !== 0) return;
    var 거래ID = key.substring(CONTRACT_REGEN_CLAIM_PREFIX_.length);
    if (!all['contractEditTS_' + 거래ID]) {
      props.deleteProperty(key);
      return;
    }
    var claim = null;
    try { claim = JSON.parse(all[key] || 'null'); } catch (parseErr) {}
    if (!claim) return;
    earliestAt = Math.min(earliestAt, Number(claim.leaseUntil || Date.now() + 1000));
  });

  if (isFinite(earliestAt)) {
    armContractRegenWatchdogUnderLock_(props, earliestAt);
    return;
  }
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === CONTRACT_REGEN_WATCHDOG_HANDLER_) ScriptApp.deleteTrigger(t);
  });
  props.deleteProperty(CONTRACT_REGEN_WATCHDOG_PROP_);
}

function armContractRegenRunWatchdog_(props) {
  var lock = LockService.getScriptLock();
  var acquired = false;
  try {
    lock.waitLock(10000);
    acquired = true;
    armContractRegenWatchdogUnderLock_(props, Date.now() + CONTRACT_REGEN_CLAIM_LEASE_MS_);
    return true;
  } catch (lockErr) {
    return false;
  } finally {
    if (acquired) try { lock.releaseLock(); } catch (releaseErr) {}
  }
}

function clearContractRegenWatchdogIfIdle_(props) {
  var lock = LockService.getScriptLock();
  var acquired = false;
  try {
    lock.waitLock(10000);
    acquired = true;
    refreshContractRegenWatchdogUnderLock_(props);
  } catch (lockErr) {
    // 기존 watchdog을 남겨두는 쪽이 고아화보다 안전하다.
  } finally {
    if (acquired) try { lock.releaseLock(); } catch (releaseErr) {}
  }
}

/**
 * 재생성 1건의 소유권만 짧게 선점한다.
 * 계약서/Drive/외부 원장 I/O는 이 함수가 잠금을 푼 뒤 실행해야 한다.
 */
function claimPendingContractRegen_(props, editKey, stableMs) {
  var lock = LockService.getScriptLock();
  var acquired = false;
  try {
    lock.waitLock(10000);
    acquired = true;

    var freshRaw = props.getProperty(editKey);
    var freshTs = Number(freshRaw || 0);
    if (!freshTs) {
      props.deleteProperty(CONTRACT_REGEN_CLAIM_PREFIX_ + editKey.substring('contractEditTS_'.length));
      return { claimed: false };
    }
    if (Date.now() - freshTs < stableMs) {
      return { claimed: false, pending: true, nextAt: freshTs + stableMs };
    }

    var 거래ID = editKey.substring('contractEditTS_'.length);
    // 재시도 상태는 편집 버전별 키다. 이전 재생성 실패가 끝나는 찰나 새 편집이
    // 들어와도 옛 실패 횟수/failed 상태가 새 버전을 막지 않는다.
    var retryKey = CONTRACT_REGEN_RETRY_PREFIX_ + 거래ID + '_' + String(freshRaw);
    var retry = parseContractRegenRetry_(props.getProperty(retryKey));
    if (retry.nextAt > Date.now()) {
      return { claimed: false, pending: true, nextAt: retry.nextAt };
    }

    var claimKey = CONTRACT_REGEN_CLAIM_PREFIX_ + 거래ID;
    var existing = null;
    try { existing = JSON.parse(props.getProperty(claimKey) || 'null'); } catch (parseErr) {}
    if (existing && Number(existing.leaseUntil || 0) > Date.now()) {
      return { claimed: false, pending: true, nextAt: Number(existing.leaseUntil) };
    }

    var token = Utilities.getUuid();
    var claim = {
      claimed: true,
      tradeId: 거래ID,
      editKey: editKey,
      claimedRaw: String(freshRaw),
      claimKey: claimKey,
      retryKey: retryKey,
      token: token,
      leaseUntil: Date.now() + CONTRACT_REGEN_CLAIM_LEASE_MS_
    };
    // GAS hard-timeout은 finally를 실행하지 않을 수 있다. 외부 Drive 작업 전에 lease
    // 만료 watchdog을 먼저 남긴 뒤 claim을 기록해 editTS+claim 고아 상태를 막는다.
    armContractRegenWatchdogUnderLock_(props, claim.leaseUntil);
    props.setProperty(claimKey, JSON.stringify({
      token: token,
      claimedRaw: claim.claimedRaw,
      leaseUntil: claim.leaseUntil
    }));
    return claim;
  } catch (lockErr) {
    return { claimed: false, busy: true, pending: true, nextAt: Date.now() + 3000, error: lockErr };
  } finally {
    if (acquired) try { lock.releaseLock(); } catch (releaseErr) {}
  }
}

/**
 * 선점한 편집 버전만 완료 처리한다. 성공한 동일 버전만 editTS를 지우고,
 * 실패한 버전은 bounded backoff로 재시도한다.
 */
function finishPendingContractRegen_(props, claim, outcome) {
  var lock = LockService.getScriptLock();
  var acquired = false;
  try {
    lock.waitLock(10000);
    acquired = true;

    var currentClaim = null;
    try { currentClaim = JSON.parse(props.getProperty(claim.claimKey) || 'null'); } catch (parseErr) {}
    if (!currentClaim || currentClaim.token !== claim.token) {
      return { pending: true, nextAt: Number(currentClaim && currentClaim.leaseUntil || claim.leaseUntil) };
    }

    var currentRaw = String(props.getProperty(claim.editKey) || '');
    props.deleteProperty(claim.claimKey);

    // 작업 중 새 편집이 들어왔으면 이전 결과/실패가 새 버전의 큐 상태를 덮지 않는다.
    if (currentRaw !== claim.claimedRaw) {
      return {
        pending: !!currentRaw,
        nextAt: currentRaw ? Number(currentRaw) + 2800 : 0
      };
    }

    if (outcome && outcome.success) {
      props.deleteProperty(claim.editKey);
      props.deleteProperty(claim.retryKey);
      return { success: true };
    }

    var retry = parseContractRegenRetry_(props.getProperty(claim.retryKey));
    retry.attempts += 1;
    retry.lastError = String(outcome && outcome.error || '계약서 재생성 실패').slice(0, 1000);
    retry.lastFailedAt = Date.now();
    if (retry.attempts >= CONTRACT_REGEN_MAX_ATTEMPTS_) {
      // transient Drive/GAS 장애가 길어도 계약서 큐를 영구 중지하지 않는다.
      // 사용자 카드 작업은 막지 않고 30분 저빈도 재시도로 계속 수렴한다.
      retry.status = 'degraded';
      retry.nextAt = Date.now() + 30 * 60 * 1000;
      props.setProperty(claim.retryKey, JSON.stringify(retry));
      return { pending: true, degraded: true, nextAt: retry.nextAt, attempts: retry.attempts };
    }

    retry.status = 'pending';
    retry.nextAt = Date.now() + Math.min(5 * 60 * 1000, 15000 * Math.pow(2, retry.attempts - 1));
    props.setProperty(claim.retryKey, JSON.stringify(retry));
    return { pending: true, nextAt: retry.nextAt, attempts: retry.attempts };
  } catch (lockErr) {
    return { pending: true, nextAt: Number(claim.leaseUntil || Date.now() + 3000) };
  } finally {
    if (acquired) try { lock.releaseLock(); } catch (releaseErr) {}
  }
}

/**
 * hard-timeout 복구용 공개 time-trigger handler.
 * watchdog 자체 정리/상태 확인만 잠그고 실제 계약서 재생성은 잠금을 푼 뒤 호출한다.
 */
function regenPendingContractsWatchdog() {
  var props = PropertiesService.getScriptProperties();
  var lock = LockService.getScriptLock();
  var acquired = false;
  var hasWork = false;
  try {
    lock.waitLock(10000);
    acquired = true;
    ScriptApp.getProjectTriggers().forEach(function(t) {
      if (t.getHandlerFunction() === CONTRACT_REGEN_WATCHDOG_HANDLER_) ScriptApp.deleteTrigger(t);
    });
    props.deleteProperty(CONTRACT_REGEN_WATCHDOG_PROP_);
    var all = props.getProperties();
    hasWork = Object.keys(all).some(function(key) {
      return key.indexOf(CONTRACT_REGEN_CLAIM_PREFIX_) === 0 || key.indexOf('contractEditTS_') === 0;
    });
  } catch (lockErr) {
    try {
      ScriptApp.newTrigger(CONTRACT_REGEN_WATCHDOG_HANDLER_).timeBased().after(5000).create();
      props.setProperty(CONTRACT_REGEN_WATCHDOG_PROP_, String(Date.now() + 5000));
    } catch (triggerErr) {}
    return;
  } finally {
    if (acquired) try { lock.releaseLock(); } catch (releaseErr) {}
  }

  if (hasWork) regenPendingContracts();
}

/**
 * 디바운스 트리거 핸들러: 안정된 거래ID 계약서 재생성.
 * 편집이 STABLE_MS 이상 없었던 거래ID만 처리하고, 남아있으면 다시 예약.
 */
function regenPendingContracts() {
  var STABLE_MS = 2800;
  var props = PropertiesService.getScriptProperties();
  // 현재 one-shot을 정리하기 전에 실행 전체를 덮는 watchdog부터 만든다.
  // claim 사이/트리거 정리 직후 hard-timeout도 편집 큐를 고아로 만들 수 없다.
  if (!armContractRegenRunWatchdog_(props)) {
    ScriptApp.newTrigger('regenPendingContracts').timeBased().after(3000).create();
    props.setProperty(CONTRACT_REGEN_TRIGGER_PROP_, String(Date.now()));
    return;
  }
  // 자기 자신(트리거) 먼저 삭제 — 재예약은 마지막에 결정. 트리거 정리는 잠금이 필요 없다.
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'regenPendingContracts') {
      ScriptApp.deleteTrigger(t);
    }
  });
  props.deleteProperty(CONTRACT_REGEN_TRIGGER_PROP_);

  var all = props.getProperties();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var stillPending = false;
  var nextRunAt = Infinity;
  var BUDGET_MS = 4 * 60 * 1000; // 6분 실행 한도 전에 끊고 재예약 (대량 적체 대비)
  var startedAt = Date.now();

  for (var key in all) {
    if (!key.startsWith('contractEditTS_')) continue;
    if (Date.now() - startedAt > BUDGET_MS) {
      stillPending = true;
      nextRunAt = Math.min(nextRunAt, Date.now() + 3000);
      break;
    }

    // 전역 잠금은 "이 거래를 내가 처리한다"는 선점에만 쓴다.
    var claim = claimPendingContractRegen_(props, key, STABLE_MS);
    if (claim.busy) {
      stillPending = true;
      nextRunAt = Math.min(nextRunAt, Number(claim.nextAt || Date.now() + 3000));
      break;
    }
    if (!claim.claimed) {
      if (claim.pending) {
        stillPending = true;
        nextRunAt = Math.min(nextRunAt, Number(claim.nextAt || Date.now() + 3000));
      }
      continue;
    }

    var 거래ID = claim.tradeId;
    var regenSucceeded = false;
    var regenErrorMessage = "";
    try {
      // 중요: Drive 복사/휴지통, 외부 거래내역 갱신을 포함한 실제 재생성은 잠금 밖이다.
      var regenT0 = Date.now();
      deleteAndRegenerateContract(ss, 거래ID);
      regenSucceeded = true;
      try { invalidateDashboardTradeExtraCache_([거래ID]); } catch (e0) {}
      try { invalidateDashboardCache(); } catch (e1) {}
      try { invalidateTimelineCache(); } catch (e2) {}
      try { supaMarkTradeDirty_(거래ID); } catch (eMark) {} // 새 계약서 링크 → Supabase/앱 전파
      Logger.log("계약서 재생성 완료(디바운스): " + 거래ID);
      try { perfLog_("contractRegen", { reqID: 거래ID, totalMs: Date.now() - regenT0 }); } catch (ePerf) {}
    } catch (err) {
      regenErrorMessage = err && err.message ? err.message : String(err);
      try { invalidateDashboardTradeExtraCache_([거래ID]); } catch (e3) {}
      Logger.log("계약서 재생성 실패: " + 거래ID + " - " + regenErrorMessage);
    } finally {
      var finishResult = finishPendingContractRegen_(props, claim, {
        success: regenSucceeded,
        error: regenErrorMessage
      });
      if (finishResult && finishResult.pending) {
        stillPending = true;
        nextRunAt = Math.min(nextRunAt, Number(finishResult.nextAt || Date.now() + 3000));
        if (finishResult.degraded) {
          Logger.log("계약서 재생성 반복 실패(30분 뒤 자동 재시도): " + 거래ID);
        }
      }
    }
    Utilities.sleep(250);
  }

  // 루프 스냅샷 뒤에 추가되었거나, 재생성 도중 다시 편집된 거래도 놓치지 않는다.
  var remaining = props.getProperties();
  for (var remainingKey in remaining) {
    if (remainingKey.startsWith('contractEditTS_')) {
      var remainingTradeId = remainingKey.substring('contractEditTS_'.length);
      var remainingRetry = parseContractRegenRetry_(
        remaining[CONTRACT_REGEN_RETRY_PREFIX_ + remainingTradeId + '_' + String(remaining[remainingKey] || '')]
      );
      stillPending = true;
      nextRunAt = Math.min(
        nextRunAt,
        Number(remainingRetry.nextAt || Number(remaining[remainingKey] || 0) + STABLE_MS || Date.now() + 3000)
      );
    }
  }

  if (stillPending) {
    var scheduledAt = Number(props.getProperty(CONTRACT_REGEN_TRIGGER_PROP_) || 0);
    if (!scheduledAt || Date.now() - scheduledAt >= CONTRACT_REGEN_TRIGGER_STALE_MS_) {
      var nextDelayMs = isFinite(nextRunAt) ? Math.max(1000, nextRunAt - Date.now()) : 3000;
      ScriptApp.newTrigger('regenPendingContracts').timeBased().after(nextDelayMs).create();
      props.setProperty(CONTRACT_REGEN_TRIGGER_PROP_, String(Date.now()));
    }
  } else {
    clearContractRegenWatchdogIfIdle_(props);
  }
}

// ─────────────────────────────────────────────────────────────
// 세트마스터 변경 → 계약서 템플릿 '마스터' 동기화 (디바운스)
// onEdit이 편집마다 호출하지만, 실제 동기화는 편집이 멈춘 뒤 1회만 실행.
// 계약서 생성과 분리 → 생성 속도 영향 없음.
// ─────────────────────────────────────────────────────────────
var TEMPLATE_SYNC_EDIT_TS_PROP_ = 'setMasterEditTS_v1';
var TEMPLATE_SYNC_TRIGGER_PROP_ = 'templateSyncTriggerScheduledAt_v1';
var TEMPLATE_SYNC_TRIGGER_STALE_MS_ = 10 * 60 * 1000;

function scheduleTemplateMasterSync_() {
  var props = PropertiesService.getScriptProperties();
  var now = Date.now();
  props.setProperty(TEMPLATE_SYNC_EDIT_TS_PROP_, String(now));

  var scheduledAt = Number(props.getProperty(TEMPLATE_SYNC_TRIGGER_PROP_) || 0);
  var hasRecent = scheduledAt && (now - scheduledAt < TEMPLATE_SYNC_TRIGGER_STALE_MS_);
  if (!hasRecent) {
    var exists = ScriptApp.getProjectTriggers().some(function (t) {
      return t.getHandlerFunction() === 'syncTemplateMasterDebounced';
    });
    if (!exists) {
      ScriptApp.newTrigger('syncTemplateMasterDebounced').timeBased().after(8000).create();
    }
    props.setProperty(TEMPLATE_SYNC_TRIGGER_PROP_, String(now));
  }
}

function syncTemplateMasterDebounced() {
  var STABLE_MS = 7000;
  var lock = LockService.getScriptLock();
  try { lock.waitLock(10000); } catch (e) { return; }
  try {
    var props = PropertiesService.getScriptProperties();
    ScriptApp.getProjectTriggers().forEach(function (t) {
      if (t.getHandlerFunction() === 'syncTemplateMasterDebounced') ScriptApp.deleteTrigger(t);
    });
    props.deleteProperty(TEMPLATE_SYNC_TRIGGER_PROP_);

    var ts = Number(props.getProperty(TEMPLATE_SYNC_EDIT_TS_PROP_) || 0);
    if (!ts) return;

    if (Date.now() - ts >= STABLE_MS) {
      props.deleteProperty(TEMPLATE_SYNC_EDIT_TS_PROP_);
      try {
        var r = syncTemplateMasterFromSetMaster();
        Logger.log("세트마스터 변경 → 템플릿 마스터 동기화: " + r);
      } catch (err) {
        Logger.log("템플릿 마스터 동기화 실패: " + err.message);
      }
    } else {
      // 아직 편집 중 → 다시 예약
      ScriptApp.newTrigger('syncTemplateMasterDebounced').timeBased().after(8000).create();
      props.setProperty(TEMPLATE_SYNC_TRIGGER_PROP_, String(Date.now()));
    }
  } finally {
    lock.releaseLock();
  }
}

var CANCEL_CLEANUP_ITEM_PREFIX_ = 'cancelCleanup_v1_';
var CANCEL_CLEANUP_TRIGGER_PROP_ = 'cancelCleanupTriggerAt_v1';
var CANCEL_CLEANUP_HANDLER_ = 'processCancelledTradeCleanup';
var CANCEL_CLEANUP_MAX_ATTEMPTS_ = 5;
var CANCEL_CLEANUP_LEASE_MS_ = 7 * 60 * 1000;

function cancelledTradeCleanupKey_(거래ID) {
  return CANCEL_CLEANUP_ITEM_PREFIX_ + String(거래ID || '').trim();
}

function parseCancelledTradeCleanup_(raw, 거래ID) {
  var state = null;
  try { state = JSON.parse(raw || 'null'); } catch (parseErr) {}
  if (!state || typeof state !== 'object') state = {};
  state.tradeId = String(state.tradeId || 거래ID || '').trim();
  state.status = String(state.status || 'pending');
  state.attempts = Number(state.attempts || 0);
  state.nextAt = Number(state.nextAt || 0);
  state.leaseUntil = Number(state.leaseUntil || 0);
  state.completed = state.completed && typeof state.completed === 'object' ? state.completed : {};
  return state;
}

/** 호출자는 ScriptLock을 보유해야 한다. */
function clearCancelledTradeCleanupTriggersUnderLock_(props) {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === CANCEL_CLEANUP_HANDLER_) ScriptApp.deleteTrigger(t);
  });
  props.deleteProperty(CANCEL_CLEANUP_TRIGGER_PROP_);
}

/** 더 이른 트리거가 이미 있으면 그대로 둔다. create 성공 뒤에만 기존 트리거를 정리한다. */
function scheduleCancelledTradeCleanupTriggerUnderLock_(props, delayMs) {
  var safeDelay = Math.max(1000, Number(delayMs || 0));
  var desiredAt = Date.now() + safeDelay;
  var currentAt = Number(props.getProperty(CANCEL_CLEANUP_TRIGGER_PROP_) || 0);
  if (currentAt > Date.now() && currentAt <= desiredAt + 1000) return;
  try {
    var existing = ScriptApp.getProjectTriggers().filter(function(t) {
      return t.getHandlerFunction() === CANCEL_CLEANUP_HANDLER_;
    });
    var replacement = ScriptApp.newTrigger(CANCEL_CLEANUP_HANDLER_).timeBased().after(safeDelay).create();
    props.setProperty(CANCEL_CLEANUP_TRIGGER_PROP_, String(desiredAt));
    var replacementId = '';
    try { replacementId = String(replacement.getUniqueId() || ''); } catch (replacementIdErr) {}
    existing.forEach(function(t) {
      var id = '';
      try { id = String(t.getUniqueId() || ''); } catch (idErr) {}
      if (!replacementId || id !== replacementId) try { ScriptApp.deleteTrigger(t); } catch (deleteErr) {}
    });
  } catch (triggerErr) {
    props.deleteProperty(CANCEL_CLEANUP_TRIGGER_PROP_);
    Logger.log('취소 외부 정리 트리거 예약 실패(큐 보존): ' +
      (triggerErr && triggerErr.message ? triggerErr.message : String(triggerErr)));
  }
}

function ensureCancelledTradeCleanupTrigger_(delayMs) {
  scheduleCancelledTradeCleanupTriggerUnderLock_(PropertiesService.getScriptProperties(), delayMs || 1000);
}

/**
 * 취소 외부 정리를 거래ID별 durable queue에 넣는다.
 * cancelContract 호출자는 이미 ScriptLock을 보유하므로 별도 중첩 잠금을 잡지 않는다.
 */
function scheduleCancelledTradeCleanup_(거래ID) {
  거래ID = String(거래ID || '').trim();
  if (!거래ID) return;

  var props = PropertiesService.getScriptProperties();
  var key = cancelledTradeCleanupKey_(거래ID);
  var state = parseCancelledTradeCleanup_(props.getProperty(key), 거래ID);
  if (state.status !== 'running') {
    if (state.status === 'failed') state.attempts = 0;
    state.status = 'pending';
    state.nextAt = Date.now();
    state.leaseUntil = 0;
    state.token = '';
  }
  state.queuedAt = Date.now();
  props.setProperty(key, JSON.stringify(state));
}

/** 호출자는 ScriptLock을 보유해야 한다. */
function nextCancelledTradeCleanupUnderLock_(props) {
  var all = props.getProperties();
  var now = Date.now();
  var due = null;
  var earliestAt = Infinity;

  Object.keys(all).forEach(function(key) {
    if (key.indexOf(CANCEL_CLEANUP_ITEM_PREFIX_) !== 0) return;
    var 거래ID = key.substring(CANCEL_CLEANUP_ITEM_PREFIX_.length);
    var state = parseCancelledTradeCleanup_(all[key], 거래ID);
    if (!state.tradeId || state.status === 'failed') return;

    var availableAt = state.status === 'running' && state.leaseUntil > now
      ? state.leaseUntil
      : Number(state.nextAt || 0);
    if (availableAt > now) {
      if (availableAt < earliestAt) earliestAt = availableAt;
      return;
    }
    if (!due || availableAt < due.availableAt) {
      due = { key: key, state: state, availableAt: availableAt };
    }
  });

  return { due: due, earliestAt: earliestAt };
}

/** 외부 I/O 전에 짧은 잠금 안에서 정확히 한 거래만 선점한다. */
function claimCancelledTradeCleanup_() {
  var props = PropertiesService.getScriptProperties();
  var lock = LockService.getScriptLock();
  var acquired = false;
  var ensureDelay = 0;
  try {
    lock.waitLock(10000);
    acquired = true;
    props.deleteProperty(CANCEL_CLEANUP_TRIGGER_PROP_);

    var next = nextCancelledTradeCleanupUnderLock_(props);
    if (!next.due) {
      if (isFinite(next.earliestAt)) {
        ensureDelay = Math.max(1000, next.earliestAt - Date.now());
      }
      return null;
    }

    var state = next.due.state;
    if (state.attempts >= CANCEL_CLEANUP_MAX_ATTEMPTS_) {
      state.status = 'degraded';
      state.failedAt = Date.now();
      state.nextAt = Date.now() + 30 * 60 * 1000;
      state.attempts = 0;
      props.setProperty(next.due.key, JSON.stringify(state));
      ensureDelay = 30 * 60 * 1000;
      return null;
    }

    state.status = 'running';
    state.attempts += 1;
    state.token = Utilities.getUuid();
    state.leaseUntil = Date.now() + CANCEL_CLEANUP_LEASE_MS_;
    props.setProperty(next.due.key, JSON.stringify(state));

    // 실행이 강제 종료돼도 lease 만료 뒤 다시 집어갈 watchdog.
    ensureDelay = CANCEL_CLEANUP_LEASE_MS_ + 1000;
    return { key: next.due.key, state: state, token: state.token };
  } catch (lockErr) {
    // 발화된 one-shot은 다시 실행되지 않는다. 잠금 경합만으로 큐가 고아가 되지 않게
    // 새 트리거를 하나 남긴다. 다음 정상 실행이 좀비/중복 트리거를 전부 정리한다.
    ensureDelay = 5000;
    Logger.log("취소 외부 정리 선점 실패(재시도): " + (lockErr && lockErr.message ? lockErr.message : String(lockErr)));
    return null;
  } finally {
    if (acquired) try { lock.releaseLock(); } catch (releaseErr) {}
    if (ensureDelay) ensureCancelledTradeCleanupTrigger_(ensureDelay);
  }
}

function deleteCancelledTradeFromExternalLedger_(거래ID) {
  var 개고생URL = PropertiesService.getScriptProperties().getProperty("개고생2_URL");
  if (!개고생URL) return 0;

  var 개고생SS = SpreadsheetApp.openByUrl(개고생URL);
  var 거래시트 = 개고생SS.getSheetByName("거래내역");
  if (!거래시트 || 거래시트.getLastRow() < 2) return 0;

  // 2026-04-23 컬럼 재배치: 거래ID D(4) → E(5)
  var ids = 거래시트.getRange(2, 5, 거래시트.getLastRow() - 1, 1).getValues();
  var delRows = [];
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]).trim() === 거래ID) delRows.push(i + 2);
  }
  for (var b = delRows.length - 1; b >= 0; b--) {
    var blockEnd = delRows[b];
    while (b - 1 >= 0 && delRows[b - 1] === delRows[b] - 1) b--;
    거래시트.deleteRows(delRows[b], blockEnd - delRows[b] + 1);
  }
  return delRows.length;
}

/**
 * 취소 워커용 strict Drive 정리. 공용 helper는 오류를 삼키므로 여기서는 throw시켜
 * durable queue가 실제로 재시도할 수 있게 한다.
 */
function trashCancelledContractFiles_(거래ID) {
  var props = PropertiesService.getScriptProperties();
  var folderId = props.getProperty("CONTRACT_FOLDER_ID");
  var fileName = "계약서_" + 거래ID + "_";
  var iter = folderId
    ? DriveApp.getFolderById(folderId).getFiles()
    : DriveApp.searchFiles("title contains '" + fileName + "'");
  var trashed = 0;
  while (iter.hasNext()) {
    var file = iter.next();
    if (file.getName().indexOf(fileName) !== 0) continue;
    file.setTrashed(true);
    trashed++;
  }
  return trashed;
}

/** 이 함수 전체는 ScriptLock 밖에서 실행된다. 각 단계는 반복 호출해도 같은 결과다. */
function runCancelledTradeCleanupOutsideLock_(state) {
  var 거래ID = state.tradeId;
  var errors = [];

  if (!state.completed.supabase) {
    try {
      var supaCancel = supaCancelTrade_(거래ID);
      if (!supaCancel || !supaCancel.ok) {
        throw new Error(supaCancel && supaCancel.error ? supaCancel.error : '응답 실패');
      }
      state.completed.supabase = true;
    } catch (supaErr) {
      errors.push('Supabase: ' + (supaErr && supaErr.message ? supaErr.message : String(supaErr)));
    }
  }

  if (!state.completed.externalLedger) {
    try {
      deleteCancelledTradeFromExternalLedger_(거래ID);
      state.completed.externalLedger = true;
    } catch (ledgerErr) {
      errors.push('개고생2.0: ' + (ledgerErr && ledgerErr.message ? ledgerErr.message : String(ledgerErr)));
    }
  }

  if (!state.completed.drive) {
    try {
      trashCancelledContractFiles_(거래ID);
      state.completed.drive = true;
    } catch (driveErr) {
      errors.push('Drive: ' + (driveErr && driveErr.message ? driveErr.message : String(driveErr)));
    }
  }

  return { success: errors.length === 0, errors: errors, state: state };
}

/** 결과 기록과 다음 트리거 계획만 짧은 잠금 안에서 수행한다. */
function finishCancelledTradeCleanup_(claim, result) {
  var props = PropertiesService.getScriptProperties();
  var lock = LockService.getScriptLock();
  var acquired = false;
  var ensureDelay = 0;
  var cleanupIdleTriggers = false;
  try {
    lock.waitLock(10000);
    acquired = true;
    var current = parseCancelledTradeCleanup_(props.getProperty(claim.key), claim.state.tradeId);
    if (current.token === claim.token) {
      if (result.success) {
        props.deleteProperty(claim.key);
      } else {
        current.completed = result.state.completed;
        current.lastError = result.errors.join(' | ').slice(0, 1000);
        current.leaseUntil = 0;
        current.token = '';
        if (current.attempts >= CANCEL_CLEANUP_MAX_ATTEMPTS_) {
          current.status = 'degraded';
          current.failedAt = Date.now();
          current.attempts = 0;
          current.nextAt = Date.now() + 30 * 60 * 1000;
        } else {
          current.status = 'pending';
          current.nextAt = Date.now() + Math.min(5 * 60 * 1000, 15000 * Math.pow(2, current.attempts - 1));
        }
        props.setProperty(claim.key, JSON.stringify(current));
      }
    }

    props.deleteProperty(CANCEL_CLEANUP_TRIGGER_PROP_);
    var next = nextCancelledTradeCleanupUnderLock_(props);
    if (next.due) {
      ensureDelay = 1000;
    } else if (isFinite(next.earliestAt)) {
      ensureDelay = Math.max(1000, next.earliestAt - Date.now());
    } else {
      cleanupIdleTriggers = true;
    }
  } finally {
    if (acquired) try { lock.releaseLock(); } catch (releaseErr) {}
    if (ensureDelay) ensureCancelledTradeCleanupTrigger_(ensureDelay);
    else if (cleanupIdleTriggers) {
      try { clearCancelledTradeCleanupTriggersUnderLock_(props); } catch (cleanupErr) {}
    }
  }
}

/**
 * 취소 외부 정리 one-shot worker.
 * 선점/완료 기록 때만 ScriptLock을 잡고 Supabase·외부 시트·Drive I/O는 잠금 밖에서 한다.
 */
function processCancelledTradeCleanup() {
  var claim = claimCancelledTradeCleanup_();
  if (!claim) return;

  var result;
  try {
    result = runCancelledTradeCleanupOutsideLock_(claim.state);
  } catch (err) {
    result = {
      success: false,
      errors: [err && err.message ? err.message : String(err)],
      state: claim.state
    };
  }
  finishCancelledTradeCleanup_(claim, result);
  Logger.log(
    (result.success ? "취소 외부 정리 완료: " : "취소 외부 정리 재시도 예약: ") +
    claim.state.tradeId
  );
}

/**
 * 계약 취소: 로컬 시트/스타일/캐시는 즉시 반영하고 외부 정리는 durable queue로 넘긴다.
 * 호출자는 ScriptLock을 보유해야 한다.
 */
function cancelContract(ss, 거래ID, contractRow) {
  if (typeof isDashboardTradeCheckoutStarted_ === 'function' && isDashboardTradeCheckoutStarted_(ss, 거래ID)) {
    throw new Error('이미 반출된 거래는 취소할 수 없습니다. 반납 기준선을 보존해야 합니다: ' + 거래ID);
  }
  var contractSheet = ss.getSheetByName("계약마스터");
  supaMarkTradeDirty_(거래ID); // 취소도 Supabase로 — timeline에서 사라져도 계약마스터 상태로 반영됨

  // 1. 스케줄상세에서 해당 거래ID 행 삭제 (연속 블록 단위, 아래부터 — 위 블록 행번호가 안 밀림)
  var schedSheet = ss.getSheetByName("스케줄상세");
  if (schedSheet && schedSheet.getLastRow() >= 2) {
    var schedData = schedSheet.getRange(2, 1, schedSheet.getLastRow() - 1, 2).getValues();
    var delRows = [];
    for (var i = 0; i < schedData.length; i++) {
      if (String(schedData[i][1]).trim() === 거래ID) delRows.push(i + 2);
    }
    for (var b = delRows.length - 1; b >= 0; b--) {
      var blockEnd = delRows[b];
      while (b - 1 >= 0 && delRows[b - 1] === delRows[b] - 1) b--;
      schedSheet.deleteRows(delRows[b], blockEnd - delRows[b] + 1);
    }
    Logger.log("스케줄상세 삭제: " + delRows.length + "행 (" + 거래ID + ")");
  }

  // Supabase/외부 원장/Drive는 버튼 응답을 막지 않도록 잠금 밖 one-shot worker에서 처리.
  scheduleCancelledTradeCleanup_(거래ID);

  // 2. 계약마스터 행 전체를 취소 스타일로 (연빨강 배경 + 취소선 + 어두운 글자)
  var rowRange = contractSheet.getRange(contractRow, 1, 1, 11);  // A:K
  rowRange.setBackground("#FFC7CE");
  rowRange.setFontColor("#9C0006");
  rowRange.setFontLine("line-through");

  // 3. dashboard/timeline 캐시 무효화 (취소된 거래의 반출/반납 날짜 포함)
  try { invalidateDashboardCacheForTrade_(거래ID); } catch (e) {}
  try { invalidateTimelineCache(); } catch (e2) {}

  Logger.log("계약 취소 로컬 반영 완료(외부 정리 예약): " + 거래ID);
}

/**
 * Installable trigger 등록 함수
 * GAS 에디터에서 딱 한 번만 실행하세요.
 * 중복 방지: 이미 등록된 경우 새로 만들지 않음
 */
function setupInstallableTrigger() {
  const triggers = ScriptApp.getProjectTriggers();
  var hasEdit = false;
  var hasChange = false;
  var created = [];
  for (const t of triggers) {
    if (t.getHandlerFunction() === "onEditInstallable") hasEdit = true;
    if (t.getHandlerFunction() === "onChangeInstallable") hasChange = true;
  }
  if (!hasEdit) {
    ScriptApp.newTrigger("onEditInstallable")
      .forSpreadsheet(SpreadsheetApp.getActiveSpreadsheet())
      .onEdit()
      .create();
    hasEdit = true;
    created.push("onEditInstallable");
    Logger.log("✅ onEditInstallable 트리거 등록 완료");
  }
  if (!hasChange) {
    ScriptApp.newTrigger("onChangeInstallable")
      .forSpreadsheet(SpreadsheetApp.getActiveSpreadsheet())
      .onChange()
      .create();
    hasChange = true;
    created.push("onChangeInstallable");
    Logger.log("✅ onChangeInstallable 트리거 등록 완료");
  }
  if (created.length === 0 && hasEdit && hasChange) Logger.log("필수 설치형 트리거가 이미 모두 등록되어 있습니다.");
  return {
    success: hasEdit && hasChange,
    created: created,
    handlers: {
      onEditInstallable: hasEdit,
      onChangeInstallable: hasChange
    }
  };
}


// ─── 기존 함수들 (변경 없음) ───

function 회차완료() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const 실사시트 = ss.getSheetByName("실사 기록");
  const 회차시트 = ss.getSheetByName("실사 회차 이력");

  const lastRow = 실사시트.getLastRow();
  const 현재실사 = 실사시트.getRange(2, 6, lastRow-1, 1).getValues();
  const 입력수 = 현재실사.filter(r => r[0] !== "").length;

  if (입력수 === 0) {
    SpreadsheetApp.getUi().alert("입력된 실사 데이터가 없습니다.");
    return;
  }

  const ui = SpreadsheetApp.getUi();
  const response = ui.alert(
    "회차 완료",
    `총 ${입력수}개 장비 실사 데이터를 확정하시겠습니까?`,
    ui.ButtonSet.YES_NO
  );
  if (response !== ui.Button.YES) return;

  const today = new Date();
  const dateStr = Utilities.formatDate(today, "Asia/Seoul", "yyMMdd");
  const email = Session.getActiveUser().getEmail().split("@")[0];
  const 열헤더 = `${dateStr}_${email}`;

  실사시트.insertColumnBefore(13);
  실사시트.getRange(1, 13).setValue(열헤더);

  // F열 → M열(새 회차 열) 복사 — 셀 단위 getValue/setValue 왕복 제거
  const fVals = 실사시트.getRange(2, 6, lastRow-1, 1).getValues();
  실사시트.getRange(2, 13, lastRow-1, 1).setValues(fVals);

  실사시트.getRange(2, 6, lastRow-1, 1).clearContent();
  실사시트.getRange(2, 7, lastRow-1, 1).clearContent();
  실사시트.getRange(2, 9, lastRow-1, 1).clearContent();
  실사시트.getRange(2, 10, lastRow-1, 1).clearContent();

  const 회차lastRow = 회차시트.getLastRow();
  const 회차ID = `RC-${String(회차lastRow).padStart(3,'0')}`;
  회차시트.getRange(회차lastRow+1, 1, 1, 4).setValues([[회차ID, today, email, "100%"]]);

  ui.alert("회차 완료! 데이터가 저장됐습니다.");
}

function 신규장비확정() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const 신규시트 = ss.getSheetByName("신규장비 추가");
  const 마스터시트 = ss.getSheetByName("장비마스터");

  const ui = SpreadsheetApp.getUi();
  const lastRow = 신규시트.getLastRow();

  let 추가수 = 0;
  for (let r = 2; r <= lastRow; r++) {
    const 확정 = 신규시트.getRange(r, 7).getValue();
    if (확정 !== "확정") continue;

    const 대분류  = 신규시트.getRange(r, 1).getValue();
    const 카테고리 = 신규시트.getRange(r, 2).getValue();
    const 장비ID  = 신규시트.getRange(r, 3).getValue();
    const 장비명  = 신규시트.getRange(r, 4).getValue();
    const 총보유  = 신규시트.getRange(r, 5).getValue();
    const 비고    = 신규시트.getRange(r, 6).getValue();

    if (!장비ID || !장비명) continue;

    const 마스터lastRow = 마스터시트.getLastRow();
    마스터시트.getRange(마스터lastRow+1, 1).setValue(대분류);
    마스터시트.getRange(마스터lastRow+1, 2).setValue(장비ID);
    마스터시트.getRange(마스터lastRow+1, 3).setValue(카테고리);
    마스터시트.getRange(마스터lastRow+1, 4).setValue(장비명);
    마스터시트.getRange(마스터lastRow+1, 5).setValue(총보유);
    마스터시트.getRange(마스터lastRow+1, 9).setValue("정상");
    마스터시트.getRange(마스터lastRow+1, 10).setValue(비고);

    신규시트.getRange(r, 7).setValue("완료");
    추가수++;
  }

  if (추가수 === 0) {
    ui.alert("확정 상태인 신규장비가 없습니다.");
  } else {
    ui.alert(`${추가수}개 장비가 장비마스터에 추가됐습니다.`);
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 장비마스터 → 실사기록 동기화 (장비ID 기준)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * 장비마스터와 실사기록을 장비ID(B열) 기준으로 동기화
 * - 이름/카테고리/대분류 변경 → 자동 반영
 * - 신규 장비 → 실사기록 하단에 추가
 * - 삭제된 장비 → 실사기록에서 삭제 안 함 (H열에 "삭제됨" 표시)
 * - 기존 실사 입력값(F~L열) → 절대 안 건드림
 *
 * ★ 메뉴에서 "실사기록 동기화" 클릭 또는 GAS에서 직접 실행 ★
 */
function syncAuditFromMaster() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const masterSheet = ss.getSheetByName("장비마스터");
  const auditSheet = ss.getSheetByName("실사 기록");

  if (!masterSheet || !auditSheet) {
    try { SpreadsheetApp.getUi().alert("❌ 장비마스터 또는 실사 기록 시트가 없습니다."); } catch(e) {}
    return;
  }

  const masterLastRow = masterSheet.getLastRow();
  if (masterLastRow < 2) return;

  // 장비마스터 데이터: A(대분류), B(장비ID), C(카테고리), D(장비명), M(사진)
  const masterData = masterSheet.getRange(2, 1, masterLastRow - 1, 13).getValues();
  // { 장비ID → { 대분류, 카테고리, 장비명, 사진URL } }
  const masterMap = {};
  for (let i = 0; i < masterData.length; i++) {
    const id = String(masterData[i][1]).trim(); // B열
    if (!id) continue;
    masterMap[id] = {
      대분류: masterData[i][0] || "",     // A열
      카테고리: masterData[i][2] || "",   // C열
      장비명: masterData[i][3] || "",     // D열
      사진: masterData[i][12] || ""       // M열
    };
  }

  // 실사기록 데이터: A(대분류), B(장비ID), C(카테고리), D(장비명) + H(삭제표시)까지 한 번에 읽음
  const auditLastRow = auditSheet.getLastRow();
  const auditIDs = new Set();
  let updated = 0;
  let marked = 0;

  if (auditLastRow >= 2) {
    const auditData = auditSheet.getRange(2, 1, auditLastRow - 1, 8).getValues();
    const abcd = auditData.map(r => r.slice(0, 4)); // A~D 쓰기 버퍼
    let abcdDirty = false;
    const markRows = []; // H열 "삭제됨" 표시 대상 행

    for (let i = 0; i < auditData.length; i++) {
      const auditID = String(auditData[i][1]).trim(); // B열
      if (!auditID) continue;
      auditIDs.add(auditID);
      const row = i + 2;

      if (masterMap[auditID]) {
        // ── 장비ID 매칭: 이름/카테고리/대분류 업데이트 ──
        const m = masterMap[auditID];
        const changed = [];

        if (String(auditData[i][0]).trim() !== String(m.대분류).trim()) {
          abcd[i][0] = m.대분류;
          changed.push("대분류");
        }
        if (String(auditData[i][2]).trim() !== String(m.카테고리).trim()) {
          abcd[i][2] = m.카테고리;
          changed.push("카테고리");
        }
        if (String(auditData[i][3]).trim() !== String(m.장비명).trim()) {
          abcd[i][3] = m.장비명;
          changed.push("장비명");
        }

        if (changed.length > 0) { updated++; abcdDirty = true; }
      } else {
        // ── 장비마스터에서 삭제된 장비 → 표시만 ──
        if (String(auditData[i][7]) !== "삭제됨") { // H열
          markRows.push(row);
          marked++;
        }
      }
    }

    // A~D 변경분을 한 번에 반영 (변경 없으면 안 씀)
    if (abcdDirty) {
      auditSheet.getRange(2, 1, abcd.length, 4).setValues(abcd);
    }
    // H열 "삭제됨" 표시 일괄 반영 (비연속 행은 RangeList로)
    if (markRows.length > 0) {
      const markList = auditSheet.getRangeList(markRows.map(r => "H" + r));
      markList.setValue("삭제됨");
      markList.setBackground("#F4CCCC");
    }
  }

  // ── 장비마스터에 있는데 실사기록에 없는 → 새 행 일괄 추가 ──
  const masterIDs = Object.keys(masterMap);
  const newAuditRows = [];

  for (let i = 0; i < masterIDs.length; i++) {
    const id = masterIDs[i];
    if (auditIDs.has(id)) continue;

    const m = masterMap[id];
    // A: 대분류, B: 장비ID, C: 카테고리, D: 장비명 (F~L은 빈칸 유지)
    newAuditRows.push([m.대분류, id, m.카테고리, m.장비명]);
  }
  const added = newAuditRows.length;
  if (added > 0) {
    const nextRow = Math.max(auditLastRow + 1, 2);
    auditSheet.getRange(nextRow, 1, added, 4).setValues(newAuditRows);
  }

  SpreadsheetApp.flush();
  const msg = "✅ 실사기록 동기화 완료!\n\n" +
    "• 정보 업데이트: " + updated + "건 (이름/카테고리 변경 반영)\n" +
    "• 신규 장비 추가: " + added + "건\n" +
    "• 삭제 표시: " + marked + "건\n\n" +
    "⚠️ 기존 실사 입력값(F~L열)은 변경되지 않았습니다.";
  Logger.log(msg);
  try { SpreadsheetApp.getUi().alert(msg); } catch(e) {}
}
