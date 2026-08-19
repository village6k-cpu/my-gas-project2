# 확인요청 모델선택/비고 누수 방지 가드

Use when troubleshooting Village `확인요청` rows that block on `모델 선택 필요`, or when Kakao/AI worker text leaks into `비고(Q)` / `추가요청(R)` and then into contracts.

## Durable lessons

1. **Generic model-selection warnings must name the blocker.**
   - Bad: `F열 드롭다운에서 구체 모델을 선택하세요` only.
   - Good: include row number, parent set if any (`[세트]...` from Q), current F value, and concrete candidate models from `장비마스터` C-category → D-name rows.
   - Also put the candidate list in the F-cell note and highlight F, not only I/J.

2. **F열 selection must invalidate stale `모델 선택 필요` results.**
   - Registration preflight must not skip rows just because I/J already has text.
   - If I contains `모델 선택 필요`, rerun availability/check logic after F was changed.
   - Otherwise staff can pick a concrete model but registration still blocks on the stale warning.

3. **Q/R are not internal logs.**
   - `확인요청` Q/R can flow to `계약마스터`, `스케줄상세`, generated contracts, or document text.
   - Never use `decision.reason`, `suggested_human_review_action`, Kakao original text, AI reasoning, normalization explanation, duplicate lookup notes, or “가용확인 후 안내 필요” as Q/R fallback values.
   - Store internal reasoning in worker evidence/follow-up records only.

4. **Contract generation must defend again.**
   - Even if insertion sanitizes Q/R, `generatecontract.js` should not blindly append R열 `추가요청` into contract item cells.
   - Only explicit short contract item lines should enter the contract, e.g. lines with quantity (`1개`, `2ea`) or an explicit `추가품목:` prefix.
   - Filter out quote memo, AI/internal, availability, duplicate, and sheet-path terms.

5. **Version/deployment verification matters.**
   - `clasp push --force` only updates source/HEAD; the live Web App may still use the prior version.
   - After `clasp deploy -i <existing-web-app-deployment-id> -d ...`, run `clasp deployments` and verify the deployment ID used by workers points to the new version.
   - If Apps Script says `Cannot create more versions: Script has reached the limit of 200 versions`, do not report the versioned Web App as updated. Say push succeeded but deployment is blocked until old Apps Script versions are deleted or another valid redeploy path is used.
   - Deployment cleanup and version cleanup are different: `clasp undeploy` can remove/archive old deployments, but Apps Script immutable version history has no supported `clasp versions delete` / public API delete. The remaining cleanup must be done from the Apps Script editor/project-history UI, or by an explicitly approved UI/destructive path.
   - If you need to know whether the live deployment already contains the safety fix despite the version cap, clone or inspect the deployed version (e.g. `clasp clone <scriptId> <versionNumber>` in a temp dir) and scan/compare the relevant functions. Only say “live already contains X” when that deployed-version inspection proves the exact guards are present.
   - `clasp redeploy -V <existingVersion>` can only repoint/update a deployment description to an existing version; it does **not** publish current HEAD changes. Use it for clarity only, not as a workaround for blocked new-version creation.

## Implementation pattern

### GAS / `checkAvailability.js`

- Add a helper like `_setModelSelectionPrompt_(sheet,row,equipName,categoryItems,ownerSet)`:
  - I = `⚠️ 모델 선택 필요`
  - J = `F열에서 구체 모델 선택 필요 (세트: ...) — 후보: ...`
  - F background = yellow
  - F note = candidate list
- In registration preflight, collect blockers as `row + parent set + F value + candidate sample` and write that to O before clearing N.
- In pre-registration rerun loops, skip only non-empty results **except** stale `모델 선택 필요` results.
- Sanitize `req.비고` and `req.추가요청` before writing Q/R, and also sanitize `updateRequest` changes to R.

### Worker / `worker.mjs`

- Prompt rule: `sheet_row_candidate.memo` / `extra_request` default to blank; only customer-visible short field requests are allowed.
- Payload builder: do not fallback to `decision.reason` or `suggested_human_review_action` for Q/R.
- Add tests proving AI reason/review text does not appear in `payload.args.비고` / `payload.args.추가요청`.

### Contract / `generatecontract.js`

- Add `sanitizeContractAdditionalRequestText_()` before appending `추가요청` to contract items.
- Require quantity or explicit item prefix; reject internal patterns like `카카오`, `원문`, `가용확인`, `확인요청`, `계약마스터`, `스케줄상세`, `중복`, `정규화`, `AI`, `후속`, `검토 필요`, `고객에게`, etc.

## Verification checklist

- `node --check checkAvailability.js sheetAPI.js generatecontract.js`
- worker syntax checks
- static test for stale model-selection rerun and Q/R sanitization
- worker test that Q/R does not leak AI reason/review text
- `git diff --check`
- `clasp push --force`
- `clasp deploy -i <live deployment id> -d ...`
- `clasp deployments` confirms the live deployment ID and new version
- Read a few `확인요청` rows to confirm Q/R are clean and model-selection rows have actionable details
