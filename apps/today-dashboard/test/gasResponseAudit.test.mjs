import test from "node:test";
import assert from "node:assert/strict";

import { classifyGasResponseForAudit } from "../lib/server/gasResponseAudit.mjs";

test("GAS response audit distinguishes authentication rejection without retaining response data", () => {
  const auth = classifyGasResponseForAudit('{"error":"인증 실패. key 파라미터를 확인하세요.","customer":"secret"}');
  assert.deepEqual(auth, { outcome: "auth_rejected" });
  assert.equal(JSON.stringify(auth).includes("secret"), false);

  assert.deepEqual(classifyGasResponseForAudit('{"error":"업무 검증 실패"}'), { outcome: "logical_error" });
  assert.deepEqual(classifyGasResponseForAudit('{"success":true,"customer":"secret"}'), { outcome: "ok" });
  assert.deepEqual(classifyGasResponseForAudit("<html>upstream error</html>"), { outcome: "non_json" });
});
