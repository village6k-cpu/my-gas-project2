const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const root = path.resolve(__dirname, "..");
const mappers = fs.readFileSync(path.join(root, "lib/data/mappers.ts"), "utf8");
const timeline = fs.readFileSync(path.join(root, "lib/domain/timeline.ts"), "utf8");

test("스케줄은 stale is_component=false여도 set_name과 name이 다르면 세트 구성품을 숨긴다", () => {
  assert.match(
    mappers,
    /isComponent:\s*isSetComponentRow\(r\.set_name,\s*r\.name,\s*r\.is_component\)/,
    "Supabase 매퍼가 오래된 is_component 값보다 set_name/name 구조를 함께 판정해야 한다",
  );
  assert.match(
    timeline,
    /if \(isTimelineSetComponent\(e\)\) continue/,
    "스케줄 막대 생성도 캐시에 남은 오래된 구성품 플래그를 방어해야 한다",
  );
});
