const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

const view = read("apps/today-dashboard/components/ConfirmView.tsx");
const gas = read("checkAvailability.js");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(
  /buildConfirmEquipmentRows\(req\.장비목록 \|\| \[\]\)[\s\S]{0,260}\.map\(\(r\) => \(\{[\s\S]{0,220}비고: String\(r\.비고/.test(view) &&
    !/buildConfirmEquipmentRows\(req\.장비목록 \|\| \[\]\)[\s\S]{0,200}\.filter\(\(r\) => r\.role !== "set-component"\)/.test(view),
  "수정창은 세트 대표명뿐 아니라 현재 선택된 세트 구성품을 모두 보존해야 한다",
);

assert(
  /const normalizedEquipment = cleanEquips\.map\(\(e\) => \(\{[\s\S]{0,240}비고: e\.비고[\s\S]{0,240}결과: isUnchangedSetHeader\(e\)/.test(view) &&
    /if \(equipmentChanged\) args\.장비 = normalizedEquipment/.test(view),
  "수정 저장 payload는 세트 구성품 소속 비고와 세트 헤더 결과를 함께 보내야 한다",
);

assert(
  /items\[j\]\.결과[\s\S]{0,180}items\[j\]\.비고/.test(gas),
  "GAS updateRequest는 전달받은 세트 헤더/구성품 메타데이터를 I/Q열에 다시 기록해야 한다",
);

console.log("confirm-request edit preserves set components checks passed");
