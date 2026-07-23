// Supabase 원격 데이터 레이어 (실데이터 모드)
import { supabase } from "../supabase/client";
import type { HandoverNote, ReturnCount, Trade } from "../domain/types";
import { canonicalOnsiteScheduleId, dedupeOnsiteItems, isSheetBackedScheduleId, itemFromRow, itemToRow, noteToRow, tradeFromRow, tradeToRow } from "./mappers";
import { normalizeItems } from "../domain/catalog";

/* eslint-disable @typescript-eslint/no-explicit-any */

const PAGE_SIZE = 1000;
// 운영 윈도우: 반납일이 최근 N일 이내(+미래 전체)인 거래만 초기 로드.
// 전체 이력을 매번 내려받으면 거래가 쌓일수록 앱이 선형으로 느려진다.
// 윈도우 밖 과거 거래는 검색/과거 날짜 진입 시 지연 로드(searchTradesRemote/fetchTradesOverlappingDate).
const ACTIVE_WINDOW_DAYS = 60;
const TRADE_ID_CHUNK = 150;

type SupabaseOrder = {
  column: string;
  ascending?: boolean;
};

type PersistTradeOptions = {
  pruneMissingSheetBacked?: boolean;
};

function activeWindowCutoffISO(): string {
  return new Date(Date.now() - ACTIVE_WINDOW_DAYS * 86400000).toISOString();
}

/** 운영 윈도우 시작일(YYYY-MM-DD) — 이보다 과거 날짜 화면은 지연 로드가 필요하다. */
export function activeWindowStartYmd(): string {
  return activeWindowCutoffISO().slice(0, 10);
}

async function fetchRowsPaginated<T>(
  sb: any,
  table: string,
  select: string,
  orders: SupabaseOrder[] = [],
  applyFilter?: (query: any) => any
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    let query = sb.from(table).select(select);
    if (applyFilter) query = applyFilter(query);
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
    // taken_qty는 반출 순간의 불변 기준선이다. GAS의 toggleSetupDone만 기록하며,
    // 브라우저의 오래된 스냅샷(null/옛 수량)이 직후 upsert로 기준선을 지우거나 줄이면 안 된다.
    delete row.taken_qty;
    // 실제값 overlay도 Slack 서버 동기화만 쓴다. 열어둔 오래된 브라우저가 null로 지우지 못하게 한다.
    delete row.actual_name;
    delete row.actual_taken_qty;
    delete row.actual_source;
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

/** 거래 행 목록에 schedule_items를 붙여 Trade[]로 조립한다(trade_id 청크 병렬 조회). */
async function attachScheduleItems(sb: any, tradeRows: any[]): Promise<Trade[]> {
  const ids = tradeRows.map((r: any) => String(r.trade_id));
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += TRADE_ID_CHUNK) chunks.push(ids.slice(i, i + TRADE_ID_CHUNK));
  const itemPages = await Promise.all(
    chunks.map((chunk) =>
      fetchRowsPaginated<any>(
        sb,
        "schedule_items",
        "*",
        [{ column: "trade_id" }, { column: "sort" }, { column: "schedule_id" }],
        (q) => q.in("trade_id", chunk).is("removed_at", null)
      )
    )
  );
  const byTrade = new Map<string, any[]>();
  for (const it of itemPages.flat()) (byTrade.get(it.trade_id) ?? byTrade.set(it.trade_id, []).get(it.trade_id)!).push(it);
  return tradeRows.map((r: any) => tradeFromRow(r, dedupeOnsiteItems(normalizeItems((byTrade.get(r.trade_id) ?? []).map(itemFromRow)))));
}

/** 운영 윈도우(반납일 기준 최근 60일 + 미래 전체) 거래 조회 — 이름은 호환을 위해 유지. */
export async function fetchAllTrades(): Promise<Trade[]> {
  const sb = supabase;
  if (!sb) return [];
  const cutoff = activeWindowCutoffISO();
  const trades = await fetchRowsPaginated<any>(sb, "trades", "*", [{ column: "trade_id" }], (q) =>
    q.or(`return_at.gte.${cutoff},return_at.is.null`)
  );
  return attachScheduleItems(sb, trades);
}

/** realtime 변경분 반영용 — 해당 거래만 재조회한다(전량 refetch 대체). */
export async function fetchTradesByIds(tradeIds: string[]): Promise<Trade[]> {
  const sb = supabase;
  const ids = Array.from(new Set(tradeIds.map((id) => String(id || "").trim()).filter(Boolean)));
  if (!sb || !ids.length) return [];
  const trades = await fetchRowsPaginated<any>(sb, "trades", "*", [{ column: "trade_id" }], (q) => q.in("trade_id", ids));
  return attachScheduleItems(sb, trades);
}

/** 윈도우 밖 과거 거래 검색(지연 로드) — 이름/전화/거래ID 부분일치. */
export async function searchTradesRemote(query: string, limit = 60): Promise<Trade[]> {
  const sb = supabase;
  const term = String(query || "").trim().replace(/[,()%*]/g, "");
  if (!sb || term.length < 2) return [];
  const pattern = `*${term}*`;
  const { data, error } = await sb
    .from("trades")
    .select("*")
    .or(`customer_name.ilike.${pattern},customer_phone.ilike.${pattern},trade_id.ilike.${pattern}`)
    .order("trade_id", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return attachScheduleItems(sb, data ?? []);
}

/** 윈도우 밖 과거 날짜 화면 진입 시 그 날짜와 겹치는 거래만 지연 로드. */
export async function fetchTradesOverlappingDate(date: string): Promise<Trade[]> {
  const sb = supabase;
  const day = String(date || "").trim();
  if (!sb || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return [];
  const dayStart = `${day}T00:00:00+09:00`;
  const dayEnd = `${day}T23:59:59+09:00`;
  const trades = await fetchRowsPaginated<any>(sb, "trades", "*", [{ column: "trade_id" }], (q) =>
    q.lte("checkout_at", dayEnd).gte("return_at", dayStart)
  );
  return attachScheduleItems(sb, trades);
}

export async function fetchNotes(): Promise<HandoverNote[]> {
  const sb = supabase;
  if (!sb) return [];
  const data = await fetchRowsPaginated<any>(sb, "handover_notes", "*", [{ column: "position" }]);
  return (data ?? []).map((r: any) => ({ id: r.id, body: r.body ?? "" }));
}

/** 결과 미확정 반출완료 요청을 서버 저장값으로 재조정한다. */
export async function fetchSetupCompletion(tradeId: string): Promise<{ done: boolean; doneAt: string | null }> {
  const sb = supabase;
  if (!sb) throw new Error("Supabase 연결 없음");
  const { data, error } = await sb
    .from("trades")
    .select("setup_done,setup_done_at")
    .eq("trade_id", tradeId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error(`반출완료 확인 대상 거래가 없습니다: ${tradeId}`);
  return { done: !!data.setup_done, doneAt: data.setup_done_at ?? null };
}

async function pruneMissingSheetBackedItems(sb: any, tradeId: string, rows: any[]): Promise<void> {
  const keepSet = new Set(rows.map((row) => String(row.schedule_id || "").trim()).filter(Boolean));
  if (!keepSet.size) return;
  const { data: existingRows, error } = await sb
    .from("schedule_items")
    .select("schedule_id,taken_qty")
    .eq("trade_id", tradeId);
  if (error) throw error;
  const staleIds = (existingRows ?? [])
    .filter((row: any) => !(Number(row.taken_qty) > 0))
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
  // supabase-js는 실패 시 throw하지 않고 {error}를 반환한다. 세션 만료(RLS 거부)·네트워크·스키마
  // 오류를 그냥 무시하면 반출/반납 체크·결제상태가 유실됐는데도 화면엔 '저장됨'으로 뜬다.
  // error를 확인해 throw → schedulePersistTrade의 catch가 사용자에게 실패를 알리도록 한다.
  const tradeRow = tradeToRow(trade);
  // 반출완료는 GAS가 기준선과 함께 확정하는 서버 권한 필드다. 브라우저의 오래된 전체
  // 스냅샷이 다른 탭/기기에서 뒤늦게 upsert되어 완료값을 false로 되돌리지 못하게 한다.
  delete tradeRow.setup_done;
  delete tradeRow.setup_done_at;
  const { error: tradeErr } = await sb.from("trades").upsert(tradeRow, { onConflict: "trade_id" });
  if (tradeErr) throw tradeErr;
  const rows = uniqueScheduleRows(trade);
  if (rows.length) {
    const { error: itemErr } = await sb.from("schedule_items").upsert(rows, { onConflict: "schedule_id" });
    if (itemErr) throw itemErr;
  }
  if (options.pruneMissingSheetBacked) await pruneMissingSheetBackedItems(sb, trade.tradeId, rows);
}

/** 반납 체크의 빠른 경로. 거래/품목 전체 upsert 대신 JSON 한 필드만 갱신한다. */
export async function persistReturnCounts(
  tradeId: string,
  returnCounts: Record<string, ReturnCount>,
): Promise<void> {
  const sb = supabase;
  if (!sb) return;
  const { data, error } = await sb
    .from("trades")
    .update({ return_counts: returnCounts })
    .eq("trade_id", tradeId)
    .select("trade_id")
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error(`반납 수량 저장 대상 거래가 없습니다: ${tradeId}`);
}

// 거래 완전 삭제 — Supabase의 schedule_items(자식) + trades(부모)를 로그인 세션으로 제거.
// GAS가 계약마스터/스케줄상세 시트행을 지운 뒤 호출(앱은 Supabase를 읽으므로 여기서 지워야 사라짐).
export async function deleteTradeRemote(tradeId: string): Promise<void> {
  const sb = supabase;
  if (!sb) return;
  const items = await sb.from("schedule_items").delete().eq("trade_id", tradeId);
  if (items.error) throw items.error;
  const trade = await sb.from("trades").delete().eq("trade_id", tradeId);
  if (trade.error) throw trade.error;
}

/** 취소는 거래 이력을 남기되 일정 점유 품목을 제거한다. */
export async function cancelTradeRemote(tradeId: string): Promise<void> {
  const sb = supabase;
  if (!sb) return;
  const items = await sb.from("schedule_items").delete().eq("trade_id", tradeId);
  if (items.error) throw items.error;
  const trade = await sb
    .from("trades")
    .update({ contract_status: "취소", contract_url: null })
    .eq("trade_id", tradeId);
  if (trade.error) throw trade.error;
}

export async function deleteScheduleItem(tradeId: string, scheduleId: string): Promise<void> {
  const sb = supabase;
  if (!sb) return;
  const variants = deleteScheduleItemVariants(tradeId, scheduleId);
  if (variants) {
    const { data, error } = await sb
      .from("schedule_items")
      .delete()
      .eq("trade_id", tradeId)
      .is("taken_qty", null)
      .or(`schedule_id.eq.${variants.canonical},schedule_id.eq.${variants.prefixed},schedule_id.like.${variants.prefixed}__%`)
      .select("schedule_id");
    if (error) throw error;
    if (!data?.length) throw new Error("반출 기준선이 있거나 삭제할 품목이 없습니다");
    return;
  }
  const { data, error } = await sb
    .from("schedule_items")
    .delete()
    .eq("trade_id", tradeId)
    .eq("schedule_id", scheduleId)
    .is("taken_qty", null)
    .select("schedule_id");
  if (error) throw error;
  if (!data?.length) throw new Error("반출 기준선이 있거나 삭제할 품목이 없습니다");
}

function deleteScheduleItemVariants(tradeId: string, scheduleId: string): { canonical: string; prefixed: string } | null {
  const canonical = canonicalOnsiteScheduleId(scheduleId, tradeId);
  if (!/^ONS-\d+$/.test(canonical)) return null;
  return { canonical, prefixed: `${tradeId}-${canonical}` };
}

export async function persistNotes(notes: HandoverNote[]): Promise<void> {
  const sb = supabase;
  if (!sb) return;
  // persistTrade와 동일 이유: 반환 {error}를 확인해 인수인계 메모의 조용한 유실을 막는다.
  const { error: upErr } = await sb.from("handover_notes").upsert(notes.map((n, i) => noteToRow(n, i)), { onConflict: "id" });
  if (upErr) throw upErr;
  const keep = notes.map((n) => n.id);
  let del = sb.from("handover_notes").delete().neq("id", "__none__");
  if (keep.length) del = del.not("id", "in", `(${keep.map((s) => `"${s}"`).join(",")})`);
  const { error: delErr } = await del;
  if (delErr) throw delErr;
}

export type RemoteChange =
  | { table: "trades" | "schedule_items"; tradeId: string | null }
  | { table: "handover_notes" };

function tradeIdFromPayload(payload: any): string | null {
  const row = payload?.new && Object.keys(payload.new).length ? payload.new : payload?.old;
  const direct = String(row?.trade_id ?? "").trim();
  if (direct) return direct;
  // DELETE 이벤트의 old에는 PK(schedule_id)만 올 수 있다 — 접두어(YYMMDD-NNN)에서 복원.
  const scheduleId = String(row?.schedule_id ?? "").trim();
  const match = scheduleId.match(/^(\d{6}-\d{3})-/);
  return match ? match[1] : null;
}

/**
 * 변경 이벤트를 테이블·거래 단위로 전달한다(전량 refetch 대신 부분 재조회용).
 * onResync는 realtime 재연결 시 호출 — 끊긴 동안의 이벤트 유실을 전체 수렴으로 복구한다.
 */
export function subscribeChanges(onChange: (change: RemoteChange) => void, onResync?: () => void): () => void {
  const sb = supabase;
  if (!sb) return () => {};
  let wasSubscribed = false;
  const ch = sb
    .channel("village-changes")
    .on("postgres_changes", { event: "*", schema: "village", table: "trades" }, (payload: any) =>
      onChange({ table: "trades", tradeId: tradeIdFromPayload(payload) })
    )
    .on("postgres_changes", { event: "*", schema: "village", table: "schedule_items" }, (payload: any) =>
      onChange({ table: "schedule_items", tradeId: tradeIdFromPayload(payload) })
    )
    .on("postgres_changes", { event: "*", schema: "village", table: "handover_notes" }, () =>
      onChange({ table: "handover_notes" })
    )
    .subscribe((status: string) => {
      if (status !== "SUBSCRIBED") return;
      if (wasSubscribed) onResync?.();
      wasSubscribed = true;
    });
  return () => {
    sb.removeChannel(ch);
  };
}
