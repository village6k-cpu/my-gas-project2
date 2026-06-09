// Supabase 원격 데이터 레이어 (실데이터 모드)
import { supabase } from "../supabase/client";
import type { HandoverNote, Trade } from "../domain/types";
import { itemFromRow, itemToRow, noteToRow, tradeFromRow, tradeToRow } from "./mappers";
import { normalizeItems } from "../domain/catalog";

/* eslint-disable @typescript-eslint/no-explicit-any */

export async function fetchAllTrades(): Promise<Trade[]> {
  const sb = supabase;
  if (!sb) return [];
  const [{ data: trades, error: te }, { data: items, error: ie }] = await Promise.all([
    sb.from("trades").select("*"),
    sb.from("schedule_items").select("*").order("sort", { ascending: true }),
  ]);
  if (te) throw te;
  if (ie) throw ie;
  const byTrade = new Map<string, any[]>();
  for (const it of items ?? []) (byTrade.get(it.trade_id) ?? byTrade.set(it.trade_id, []).get(it.trade_id)!).push(it);
  return (trades ?? []).map((r: any) => tradeFromRow(r, normalizeItems((byTrade.get(r.trade_id) ?? []).map(itemFromRow))));
}

export async function fetchNotes(): Promise<HandoverNote[]> {
  const sb = supabase;
  if (!sb) return [];
  const { data, error } = await sb.from("handover_notes").select("*").order("position", { ascending: true });
  if (error) throw error;
  return (data ?? []).map((r: any) => ({ id: r.id, body: r.body ?? "" }));
}

/** 거래 1건 + 그 품목들 저장 (DB에 없는 품목은 삭제) */
export async function persistTrade(trade: Trade): Promise<void> {
  const sb = supabase;
  if (!sb) return;
  await sb.from("trades").upsert(tradeToRow(trade), { onConflict: "trade_id" });
  const rows = trade.equipments.map((e, i) => itemToRow(e, trade.tradeId, i));
  if (rows.length) await sb.from("schedule_items").upsert(rows, { onConflict: "schedule_id" });
  const keepIds = trade.equipments.map((e) => e.scheduleId);
  let del = sb.from("schedule_items").delete().eq("trade_id", trade.tradeId);
  if (keepIds.length) del = del.not("schedule_id", "in", `(${keepIds.map((s) => `"${s}"`).join(",")})`);
  await del;
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
