import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { normalizeAuditLocation } from "../lib/inventory-audit/mvp.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI = fs.readFileSync(
  path.join(HERE, "../components/inventory-audit/InventoryAuditMvp.tsx"),
  "utf8",
);

test("blank location never blocks an inventory observation save", () => {
  assert.equal(normalizeAuditLocation(""), "위치 미입력");
  assert.equal(normalizeAuditLocation("   "), "위치 미입력");
  assert.equal(normalizeAuditLocation(" A 선반 "), "A 선반");
});

test("mobile audit UI makes save, pause, persistence, and photo state explicit", () => {
  assert.match(UI, /현재 항목 저장/);
  assert.match(UI, /저장하고 나가기/);
  assert.match(UI, /앱을 닫아도 유지됩니다/);
  assert.match(UI, /사진 선택됨/);
  assert.match(UI, /사진 저장 완료/);
  assert.doesNotMatch(UI, /현재 위치를 입력해 주세요/);
});
