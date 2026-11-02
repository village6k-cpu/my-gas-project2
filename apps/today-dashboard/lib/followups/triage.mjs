export const ARCHIVE_KIND = "owner_archived_reset";
export const ACTIVE_STATES = ["open", "in_progress", "snoozed"];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const text = (v, max = 5000) => typeof v === "string" ? v.slice(0, max) : "";
const money = v => (typeof v === "number" || (typeof v === "string" && /^\d+$/.test(v))) && Number.isSafeInteger(Number(v)) && Number(v) >= 0 ? Number(v) : null;
function array(v) { try { const a = typeof v === "string" ? JSON.parse(v) : v; return Array.isArray(a) ? a : []; } catch { return []; } }
export function isCritical(row) { return row?.payload?.owner_triage === "critical" && ACTIVE_STATES.includes(row.state); }
export function isArchived(row) { return row?.state === "dismissed" && row.resolution_kind === ARCHIVE_KIND; }
export function parseRestore(body) {
  if (!body || Object.keys(body).sort().join(",") !== "expectedVersion,id" || !uuid.test(body.id) || !Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 1) throw new Error("invalid restore");
  return { id: body.id, expectedVersion: body.expectedVersion };
}
export function triageItem(row) {
  const p = row.payload || {};
  return { id: row.id, version: row.version, caseKey: row.room_key || row.id,
    title: text(row.title, 500), summary: text(row.summary), action: p.owner_triage_kind === "damage_settlement" ? "은행 입금 원본을 파손 명세서와 대조하고 배상비 충당 내역과 남은 분쟁 여부를 확인하세요." : text(p.recommended_action || p.owner_next_action_summary),
    reason: text(p.owner_triage_reason), kind: text(p.owner_triage_kind, 80),
    balance: money(p.owner_triage_balance ?? null), unallocated: money(p.owner_triage_unallocated ?? null),
    // Missing amounts are unknown, never silently zero-valued.
    verifiedAt: text(p.owner_triage_verified_at, 100), updatedAt: row.updated_at,
    accounts: array(p.owner_triage_accounts).flatMap(a => /^\d{6}-\d{3}$/.test(a?.tradeId) ? [{ tradeId: a.tradeId, balance: money(a.balance), paid: money(a.paid), depositStatus: text(a.sheetDeposit, 60) }] : []),
    archivedAt: row.resolved_at || null,
  };
}
export function groupCritical(items) {
  const groups = new Map();
  for (const item of items) {
    const key = item.caseKey || item.id;
    if (!groups.has(key)) groups.set(key, { key, title: item.title.split(" ")[0] + " 확인", items: [] });
    groups.get(key).items.push(item);
  }
  return [...groups.values()];
}
