# Village 확인요청 F열 validation recovery

## Symptom

Kakao DOM watcher/AI worker is alive and correctly decides `should_write_to_sheet=true`, but `insertAndCheckRequest` fails with a Google Sheets validation error like:

```text
셀 F21에 입력한 데이터가 이 셀에 설정된 데이터 확인 규칙을 위반했습니다.
```

This can happen even though the normal 확인요청 F열 dropdown is configured with `setAllowInvalid(true)`.

## Cause

Rows reused as the next append target may still carry row-level strict validations from older generated rows, especially:

- 세트 구성품 rows that had `setAllowInvalid(false)` reapplied after set expansion.
- 모델 선택 필요/category rows that received a filtered validation list.
- Cleared/empty rows whose content was cleared but whose data validation was not reset.

The worker and bridge are not the root cause in this case. The write is blocked by stale sheet metadata on the target row.

## Durable fix pattern

In the Apps Script append path (`insertAndCheckRequest` / `_insertAndCheckRequest`), before `setValues([rowData])` on each new 확인요청 row:

1. Rebuild the normal 확인요청 F열 validation rule from `목록!A2:A...` with `setAllowInvalid(true)`.
2. Apply that rule to the target F cell, or clear data validation if the rule cannot be built.
3. Then write the row.

Example shape:

```js
var confirmRequestFRule = null;
try {
  if (listSheet && equipNames.length > 0) {
    confirmRequestFRule = SpreadsheetApp.newDataValidation()
      .requireValueInRange(listSheet.getRange("A2:A" + (equipNames.length + 1)), true)
      .setAllowInvalid(true)
      .setHelpText("장비명 또는 세트명을 검색하세요")
      .build();
  }
} catch (validationRuleErr) {
  confirmRequestFRule = null;
}

// inside append loop, before setValues([rowData])
var fCellForInsert = sheet.getRange(row, 6);
if (confirmRequestFRule) fCellForInsert.setDataValidation(confirmRequestFRule);
else fCellForInsert.clearDataValidations();
sheet.getRange(row, 1, 1, 18).setValues([rowData]);
```

## Verification

- Syntax check the GAS JS locally if possible.
- Push and deploy the Apps Script web app if the automation calls the deployed `/exec` URL.
- Re-run the exact `insertAndCheckRequest` payload that failed. Success may still return `❓ 미등록 장비` if the equipment is not in 장비마스터/세트마스터; that is a business-data result, not an automation write failure.
- Search 확인요청 by the returned RQ ID or customer name to verify the row exists.
- Re-check Kakao automation `/health` / `./scripts/kakao-automation status` and recent `worker-results.ndjson`: after the fix, later worker runs should report duplicate/already_answered instead of repeating the sheet validation error.

## Operational note

If the working repo is dirty with unrelated in-progress changes, clone/pull the live GAS project to a temporary directory, apply the minimal hotfix there, `clasp push`, then deploy the existing web app deployment ID. Mirror the same patch into the local repo afterward so future work does not regress.