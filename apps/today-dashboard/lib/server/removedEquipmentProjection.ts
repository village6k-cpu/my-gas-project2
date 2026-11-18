import { itemFromRow, tradeFromRow } from "../data/mappers";
import { packingReservationChanges, packingStarted, transitionPacking } from "../domain/packing";
import type { getInventoryAuditServiceClient } from "./inventoryAuditDb";

type Db = ReturnType<typeof getInventoryAuditServiceClient>;

// Limit URL length even when a set expands to many component IDs.
function batches(ids: string[]): string[][] {
  const result: string[][] = [];
  for (let i = 0; i < ids.length; i += 100) result.push(ids.slice(i, i + 100));
  return result;
}

/** GAS가 확정한 제외만 즉시 투영한다. 분 단위 GAS 워커를 다음 검수 명령이 기다리지 않는다. */
export async function projectConfirmedEquipmentRemoval(db: Db, tradeId: string, result: any, actor: string) {
  if (!/^\d{6}-\d{3}$/.test(tradeId) || result?.success !== true || result.error) throw new Error("장비 제외 확정 응답 없음");
  const confirmed = new Set<string>(Array.isArray(result.removedScheduleIds) ? result.removedScheduleIds : []);
  const targets = new Map<string, string>();
  for (const row of Array.isArray(result.removedEquipments) ? result.removedEquipments : []) {
    if (confirmed.has(row.scheduleId)) targets.set(row.scheduleId, row.name);
  }
  // 응답 유실 후 재시도: GAS가 이미 없는 것으로 확인한 정확한 ID/이름만 수렴시킨다.
  for (const row of Array.isArray(result.results) ? result.results : []) {
    if (row.success === true && row.alreadyRemoved === true) targets.set(row.scheduleId, row.equipName);
  }
  if (!targets.size || [...targets].some(([id, name]) => !id.startsWith(`${tradeId}-`) || !name || typeof name !== "string") || [...confirmed].some(id => !targets.has(id))) throw new Error("장비 제외 대상 확인 실패");
  const idsByName = new Map<string, string[]>();
  for (const [id, name] of targets) {
    const ids = idsByName.get(name) ?? [];
    ids.push(id);
    idsByName.set(name, ids);
  }
  const unverified = new Set(targets.keys());
  const removedAt = new Date().toISOString();
  // PostgREST returns the updated rows in the same request. Keep the ID/name pair and checkout guard on each write.
  const updates = [...idsByName].flatMap(([name, ids]) => batches(ids).map(async group => {
    const { data, error } = await db.from("schedule_items").update({ removed_at: removedAt })
      .eq("trade_id", tradeId).eq("name", name).in("schedule_id", group).is("taken_qty", null)
      .is("removed_at", null).select("schedule_id,name,removed_at,taken_qty");
    if (error) throw error;
    for (const row of data ?? []) {
      if (targets.get(row.schedule_id) !== row.name || !row.removed_at || row.taken_qty !== null)
        throw new Error("장비 제외 투영 상태를 확인해주세요");
      unverified.delete(row.schedule_id);
    }
  }));
  await Promise.all(updates);
  // A retry may find an already removed or absent row. Check those IDs together, including name/checkout conflicts.
  await Promise.all(batches([...unverified]).map(async ids => {
    const { data, error } = await db.from("schedule_items").select("schedule_id,name,removed_at,taken_qty")
      .eq("trade_id", tradeId).in("schedule_id", ids);
    if (error) throw error;
    for (const row of data ?? []) {
      if (targets.get(row.schedule_id) !== row.name || !row.removed_at || row.taken_qty !== null)
        throw new Error("장비 제외 투영 상태를 확인해주세요");
    }
  }));
  // 직원의 체크/교체/직접 입력은 기존 refresh 규칙으로 보존한다. CAS 충돌 시 최신본에서 재계산한다.
  for (let attempt = 0; attempt < 3; attempt++) {
    const [tr, items] = await Promise.all([
      db.from("trades").select("*").eq("trade_id", tradeId).single(),
      db.from("schedule_items").select("*").eq("trade_id", tradeId).is("removed_at", null).order("sort"),
    ]);
    if (tr.error || items.error) throw new Error("제외 후 예약 조회 실패");
    const trade = tradeFromRow(tr.data, (items.data ?? []).map(itemFromRow));
    if (!trade.packing || trade.packing.phase !== "draft" || packingStarted(trade) || !packingReservationChanges(trade).length) return trade.packing;
    const next = transitionPacking(trade, { action: "refresh" }, new Date().toISOString());
    const saved = await db.rpc("save_packing_manifest", {
      p_trade_id: tradeId, p_version: trade.packing.version, p_next: next, p_actor: actor, p_action: "refresh",
    });
    if (!saved.error) return saved.data;
    if (saved.error.code !== "40001") throw saved.error;
  }
  throw new Error("다른 구성품 변경을 반영 중입니다");
}
