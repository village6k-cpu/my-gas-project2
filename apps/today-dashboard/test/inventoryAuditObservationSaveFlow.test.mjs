import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function read(relativePath) {
  return fs.readFileSync(path.join(HERE, "..", relativePath), "utf8");
}

const MVP = read("components/inventory-audit/InventoryAuditMvp.tsx");
const REVIEW = read("components/inventory-audit/InventoryAuditReview.tsx");
const VIEW = read("components/InventoryView.tsx");
const STAFF = read("lib/server/inventoryAuditStaff.ts");
const START_ROUTE = read("app/api/inventory-audits/start/route.ts");

test("observation save commits to local state before the photo upload and reuses one id per form", () => {
  // 관측 저장 결과는 사진 업로드 전에 로컬 상태에 반영된다 — 사진 실패가 저장된 계수를 유실시키지 않는다
  const applyIndex = MVP.indexOf("applyObservationToWorkspace(saved)");
  const photoIndex = MVP.indexOf("compressInventoryAuditEvidence(photo)");
  assert.notEqual(applyIndex, -1, "saved observation must be merged into the workspace");
  assert.notEqual(photoIndex, -1, "photo upload path must remain");
  assert.ok(applyIndex < photoIndex, "observation commit must run before the photo upload");

  // 저장 시도마다 새 UUID를 만들지 않는다 — 재시도는 폼을 열 때 정한 id를 재사용해 관측 중복 생성을 막는다
  assert.doesNotMatch(MVP, /editing\?\.id \?\? crypto\.randomUUID\(\)/);
  assert.match(MVP, /draftObservationId/);
  assert.match(MVP, /setDraftObservationId\(crypto\.randomUUID\(\)\)/);

  // 사진 실패 시 관측은 저장된 상태임을 알리고 폼을 유지한다
  assert.match(MVP, /항목은 저장됐고 사진만 실패했습니다/);
});

test("stale_write conflict rebases on the server's current observation and retries once", () => {
  assert.match(MVP, /stale_write/);
  assert.match(MVP, /currentObservation/);
  // 복구 후 같은 폼에서 이어서 저장할 수 있도록 editing 기준을 서버 현재값으로 갱신한다
  assert.match(MVP, /setEditing\(current\)/);
  assert.match(MVP, /await putObservation\(current\)/);
});

test("audit workspace fetch failure no longer locks the whole inventory tab", () => {
  // 조회 실패는 잠금이 아니다 — 실제 원장 쓰기 잠금은 서버 RLS가 강제한다
  assert.match(MVP, /if \(!hasLoadedOnce\.current\) onLockChange\(false\);/);
  // 검증 UI는 실사 진행이 확인된(locked) 경우에만 숨긴다
  assert.match(VIEW, /auditLock === "locked"/);
  assert.match(VIEW, /auditLock !== "locked"/);
});

test("owner review preserves unsaved per-equipment decisions across reloads", () => {
  assert.match(REVIEW, /dirtyDecisionKeys/);
  assert.match(REVIEW, /dirtyCountKeys/);
  // 대여명 묶음 판정 뒤 재조회는 화면을 리셋하지 않고(silent) dirty 값을 보존한다
  assert.match(REVIEW, /await load\(\{ silent: true \}\)/);
  assert.match(REVIEW, /checkpointApprovedAt === null/);
});

test("audit start loads schedule item batches with bounded parallelism and a route time budget", () => {
  assert.match(STAFF, /TRADE_BATCH_CONCURRENCY/);
  assert.match(STAFF, /Promise\.all\(/);
  assert.match(START_ROUTE, /export const maxDuration = 60/);
});
