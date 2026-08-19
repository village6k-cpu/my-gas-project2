export function classifyGasResponseForAudit(responseBody) {
  try {
    const parsed = JSON.parse(String(responseBody || ""));
    const error = parsed && typeof parsed === "object" ? String(parsed.error || "") : "";
    if (/인증 실패|key 파라미터/.test(error)) return { outcome: "auth_rejected" };
    if (error) return { outcome: "logical_error" };
    return { outcome: "ok" };
  } catch {
    return { outcome: "non_json" };
  }
}
