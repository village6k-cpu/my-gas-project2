const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const view = fs.readFileSync(path.join(root, "apps/today-dashboard/components/ConfirmView.tsx"), "utf8");
const gas = fs.readFileSync(path.join(root, "checkAvailability.js"), "utf8");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(
  /queueSave\([\s\S]{0,100}\{ 새이름: name\.trim\(\), 수량: q, skipCheck: true \}/.test(view) &&
    /가용확인 없이 저장/.test(view),
  "품목 인라인 편집기에 가용확인 없이 이름·수량만 저장하는 버튼이 필요하다",
);

const updateItem = gas.slice(gas.indexOf("function updateRequestItem(req)"), gas.indexOf("\n\nfunction updateRequest(req)"));
assert(
  /if \(req\.skipCheck === true\)/.test(updateItem) &&
    /setValue\("가용확인 생략"\)/.test(updateItem) &&
    /else \{[\s\S]{0,180}processByReqID\(sheet, target\)/.test(updateItem),
  "GAS는 skipCheck 저장 시 이전 결과를 지우고 가용확인 호출만 생략해야 한다",
);

console.log("confirm request item save without availability check passed");
