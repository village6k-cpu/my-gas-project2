import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cardSource = fs.readFileSync(path.join(appRoot, "components/ScheduleCard.tsx"), "utf8");
const photoSource = fs.readFileSync(path.join(appRoot, "components/PhotoStrip.tsx"), "utf8");

test("완료 카드가 접혀 있어도 반출·반납 사진 진입점은 항상 표시된다", () => {
  const detailStart = cardSource.indexOf("{/* 상세 */}");
  const alwaysVisibleMarker = cardSource.indexOf("{/* 사진은 완료 카드가 접혀도 항상 접근할 수 있어야 한다. */}");
  const photoStrip = cardSource.indexOf("<PhotoStrip", alwaysVisibleMarker);

  assert.notEqual(detailStart, -1, "상세 영역을 찾을 수 없습니다");
  assert.ok(alwaysVisibleMarker > detailStart, "사진 진입점은 상세 영역과 분리되어야 합니다");
  assert.ok(photoStrip > alwaysVisibleMarker, "항상 표시되는 사진 진입점이 없습니다");
  assert.match(cardSource, /<PhotoStrip[^>]*showThumbnails=\{open\}/);
  assert.match(photoSource, /showThumbnails\s*&&\s*\(/);
});
