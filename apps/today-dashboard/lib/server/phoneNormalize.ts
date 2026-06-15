/**
 * 전화번호 정규화 유틸
 *
 * normalizePhoneLast8: 숫자만 추출 후 끝 8자리 반환.
 * 입력·DB 양쪽에 적용해 형식 차이를 흡수한다.
 *
 * 예시:
 *   '010-6403-9315'    → '64039315'
 *   '1063233116'       → '63233116'
 *   '+82 10-6403-9315' → '64039315'
 *   '01064039315'      → '64039315'
 */
export function normalizePhoneLast8(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  return digits.slice(-8);
}
