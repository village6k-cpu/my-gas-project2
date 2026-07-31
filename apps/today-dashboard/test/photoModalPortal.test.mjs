import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(appRoot, "components/PhotoStrip.tsx"), "utf8");

test("사진 모달은 카드의 opacity/overflow 화면층을 벗어나 document.body에 렌더링된다", () => {
  assert.match(source, /import\s+\{\s*createPortal\s*\}\s+from\s+["']react-dom["']/);
  assert.match(source, /createPortal\([\s\S]*document\.body[\s\S]*\)/);
  assert.match(source, /\{photoModal\}/);
});
