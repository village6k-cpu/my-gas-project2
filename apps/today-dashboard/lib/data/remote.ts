// Supabase 원격 데이터 레이어 (실데이터 모드)
import { supabase } from "../supabase/client";
import type { HandoverNote, Trade } from "../domain/types";
import { canonicalOnsiteScheduleId, dedupeOnsiteItems, isSheetBackedScheduleId, itemFromRow, itemToRow, noteToRow, tradeFromRow, tradeToRow } from "./mappers";
import { normalizeItems } from "../domain/catalog";

/* eslint-disable @typescript-eslint/no-explicit-any */

const PAGE_SIZE = 1000;

type SupabaseOrder = {
  column: string;
  ascending?: boolean;
};

type PersistTradeOptions = {
  pruneMissingSheetBacked?: boolean;
};

async function fetchRowsPaginated<T>(
  sb: any,
  table: string,
  select: string,
  orders: SupabaseOrder[] = []
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    let query = sb.from(table).select(select);
    for (const order of orders) query = query.order(order.column, { ascending: order.ascending ?? true });
    const { data, error } = await query.range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    const page = (data ?? []) as T[];
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return rows;
}

function uniqueScheduleRows(trade: Trade): any[] {
  const seenScheduleIds = new Map<string, number>();
  // 합성(synthetic) 품목은 timeline 행번호 기반 가짜 scheduleId라 실제 행과 안 맞는다.
  // 시트뿐 아니라 Supabase에도 쓰면 유령 행이 생기고 체크/제외가 엉뚱하게 기록됨 → 영속화 제외.
  return trade.equipments.filter((e) => !e.synthetic).map((e, i) => {
    const row = itemToRow(e, trade.tradeId, i);
    const baseId = row.schedule_id;
    const seen = seenScheduleIds.get(baseId) ?? 0;
    seenScheduleIds.set(baseId, seen + 1);
    if (seen > 0) {
      if (row.onsite) return null;
      row.schedule_id = `${baseId}__${seen + 1}`;
    }
    return row;
  }).filter((row): row is any => !!row);
}

export async function fetchAllTrades(): Promise<Trade[]> {
  const sb = supabase;
  if (!sb) return [];
  const [trades, items] = await Promise.all([
    fetchRowsPaginated<any>(sb, "trades", "*", [{ column: "trade_id" }]),
    fetchRowsPaginated<any>(sb, "schedule_items", "*", [
      { column: "trade_id" },
      { column: "sort" },
      { column: "schedule_id" },
    ]),
  ]);
  const byTrade = new Map<string, any[]>();
  for (const it of items ?? []) (byTrade.get(it.trade_id) ?? byTrade.set(it.trade_id, []).get(it.trade_id)!).push(it);
  return (trades ?? []).map((r: any) => tradeFromRow(r, dedupeOnsiteItems(normalizeItems((byTrade.get(r.trade_id) ?? []).map(itemFromRow)))));
}

export async function fetchNotes(): Promise<HandoverNote[]> {
  const sb = supabase;
  if (!sb) return [];
  const data = await fetchRowsPaginated<any>(sb, "handover_notes", "*", [{ column: "position" }]);
  return (data ?? []).map((r: any) => ({ id: r.id, body: r.body ?? "" }));
}

async function pruneMissingSheetBackedItems(sb: any, tradeId: string, rows: any[]): Promise<void> {
  const keepSet = new Set(rows.map((row) => String(row.schedule_id || "").trim()).filter(Boolean));
  if (!keepSet.size) return;
  const { data: existingRows, error } = await sb
    .from("schedule_items")
    .select("schedule_id")
    .eq("trade_id", tradeId);
  if (error) throw error;
  const staleIds = (existingRows ?? [])
    .map((row: any) => String(row.schedule_id || "").trim())
    .filter((scheduleId: string) => isSheetBackedScheduleId(scheduleId, tradeId) && !keepSet.has(scheduleId));
  if (!staleIds.length) return;
  await sb
    .from("schedule_items")
    .delete()
    .eq("trade_id", tradeId)
    .in("schedule_id", staleIds);
}

/** 거래 1건 + 현재 가진 품목들을 저장. 기본 저장은 부분 스냅샷 보호를 위해 누락 품목을 삭제하지 않는다. */
export async function persistTrade(trade: Trade, options: PersistTradeOptions = {}): Promise<void> {
  const sb = supabase;
  if (!sb) return;
  await sb.from("trades").upsert(tradeToRow(trade), { onConflict: "trade_id" });
  const rows = uniqueScheduleRows(trade);
  if (rows.length) await sb.from("schedule_items").upsert(rows, { onConflict: "schedule_id" });
  if (options.pruneMissingSheetBacked) await pruneMissingSheetBackedItems(sb, trade.tradeId, rows);
}

export async function deleteScheduleItem(tradeId: string, scheduleId: string): Promise<void> {
  const sb = supabase;
  if (!sb) return;
  const variants = deleteScheduleItemVariants(tradeId, scheduleId);
  if (variants) {
    await sb
      .from("schedule_items")
      .delete()
      .eq("trade_id", tradeId)
      .or(`schedule_id.eq.${variants.canonical},schedule_id.eq.${variants.prefixed},schedule_id.like.${variants.prefixed}__%`);
    return;
  }
  await sb.from("schedule_items").delete().eq("trade_id", tradeId).eq("schedule_id", scheduleId);
}

function deleteScheduleItemVariants(tradeId: string, scheduleId: string): { canonical: string; prefixed: string } | null {
  const canonical = canonicalOnsiteScheduleId(scheduleId, tradeId);
  if (!/^ONS-\d+$/.test(canonical)) return null;
  return { canonical, prefixed: `${tradeId}-${canonical}` };
}

export async function persistNotes(notes: HandoverNote[]): Promise<void> {
  const sb = supabase;
  if (!sb) return;
  await sb.from("handover_notes").upsert(notes.map((n, i) => noteToRow(n, i)), { onConflict: "id" });
  const keep = notes.map((n) => n.id);
  let del = sb.from("handover_notes").delete().neq("id", "__none__");
  if (keep.length) del = del.not("id", "in", `(${keep.map((s) => `"${s}"`).join(",")})`);
  await del;
}

export function subscribeChanges(onChange: () => void): () => void {
  const sb = supabase;
  if (!sb) return () => {};
  const ch = sb
    .channel("village-changes")
    .on("postgres_changes", { event: "*", schema: "village", table: "trades" }, onChange)
    .on("postgres_changes", { event: "*", schema: "village", table: "schedule_items" }, onChange)
    .on("postgres_changes", { event: "*", schema: "village", table: "handover_notes" }, onChange)
    .subscribe();
  return () => {
    sb.removeChannel(ch);
  };
}
