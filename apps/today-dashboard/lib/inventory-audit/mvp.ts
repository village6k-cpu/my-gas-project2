export function normalizeAuditLocation(value: string): string {
  return value.trim() || "위치 미입력";
}
