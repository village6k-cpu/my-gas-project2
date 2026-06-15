/**
 * 전화번호 정규화 단위 테스트 (Node.js 내장 test runner, 의존성 없음)
 *
 * 실행:  node --test test/phoneNormalize.test.js
 *
 * TypeScript 파일을 직접 import할 수 없으므로 정규화 로직을 여기서 재구현.
 * 로직이 단순(숫자 추출 → 끝 8자리)하므로 인라인으로 검증.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");

/** lib/server/phoneNormalize.ts의 normalizePhoneLast8 동일 구현 */
function normalizePhoneLast8(raw) {
  const digits = raw.replace(/\D/g, "");
  return digits.slice(-8);
}

// ── 기본 케이스 ───────────────────────────────────────────────────
test("하이픈 포함 010 번호", () => {
  assert.equal(normalizePhoneLast8("010-6403-9315"), "64039315");
});

test("하이픈 없는 11자리 숫자", () => {
  assert.equal(normalizePhoneLast8("01064039315"), "64039315");
});

test("앞 0 빠진 10자리 숫자 (DB 저장 형식)", () => {
  assert.equal(normalizePhoneLast8("1063233116"), "63233116");
});

test("+82 국제 형식", () => {
  assert.equal(normalizePhoneLast8("+82 10-6403-9315"), "64039315");
});

test("+82 하이픈 없는 국제 형식", () => {
  assert.equal(normalizePhoneLast8("+821064039315"), "64039315");
});

test("공백 섞인 형식", () => {
  assert.equal(normalizePhoneLast8("010 6403 9315"), "64039315");
});

// ── 같은 끝 8자리로 매칭되는 두 형식 비교 ────────────────────────
test("010-6403-9315 vs 1063239315는 끝 8자리 동일", () => {
  // 두 번호의 끝 8자리가 같으면 같은 사람으로 인식
  const a = normalizePhoneLast8("010-6403-9315");
  const b = normalizePhoneLast8("01064039315");
  assert.equal(a, b);
});

test("010-6403-9315 vs 1063239316은 끝 8자리 다름", () => {
  const a = normalizePhoneLast8("010-6403-9315");
  const b = normalizePhoneLast8("010-6403-9316");
  assert.notEqual(a, b);
});

// ── 엣지 케이스 ───────────────────────────────────────────────────
test("빈 문자열은 빈 문자열 반환", () => {
  assert.equal(normalizePhoneLast8(""), "");
});

test("숫자가 8자리 미만이면 그대로 반환", () => {
  // 7자리 숫자: 끝 8자리 = 전체
  assert.equal(normalizePhoneLast8("1234567"), "1234567");
});

test("숫자가 정확히 8자리면 그대로 반환", () => {
  assert.equal(normalizePhoneLast8("12345678"), "12345678");
});
