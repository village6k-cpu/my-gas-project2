import assert from "node:assert/strict";
import { sanitizeCautionDisplayText } from "../apps/today-dashboard/lib/domain/cautions.ts";

const cases = [
  ["분류: 카메라 전원. NotebookLM: 미러리스 전원 사고 묶음", "미러리스 전원 사고 묶음"],
  ["분류: 렌즈. NotebookLM: kakao-2023; 조리개 조절 불능 기체 발견", "조리개 조절 불능 기체 발견"],
  ["분류: 저장매체. NotebookLM: kakao-2025, kakao-2026; 1년간 메모리 12장 분실", "1년간 메모리 12장 분실"],
  ["분류: 카메라 출력. NotebookLM: corrections.md, kakao-2024; SDI 출력 불량과 LCD 이슈", "SDI 출력 불량과 LCD 이슈"],
  ["배터리 3개와 충전기 1개 구성 확인", "배터리 3개와 충전기 1개 구성 확인"],
];

for (const [input, expected] of cases) {
  const actual = sanitizeCautionDisplayText(input);
  assert.equal(actual, expected);
  assert.equal(/NotebookLM|kakao-\d{4}|corrections\.md/i.test(actual), false);
}

console.log("today-dashboard caution sanitize checks passed");
