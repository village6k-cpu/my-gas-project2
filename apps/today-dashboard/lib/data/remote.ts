// Supabase 원격 데이터 레이어 (실데이터 모드)
import { supabase } from "../supabase/client";
import type { HandoverNote, ReturnCount, Trade } from "../domain/types";
import { canonicalOnsiteScheduleId, dedupeOnsiteItems, isSheetBackedScheduleId, itemFromRow, itemToRow, noteToRow, tradeFromRow, tradeToRow } from "./mappers";
import { normalizeItems } from "../domain/catalog";
import { isCheckoutBaselineLocked } from "../domain/status";

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
  /** 수동 시트 동기화처럼 입력이 최신 원장임이 보장될 때만 기존 구조 열을 갱신한다. */
  updateExistingStructure?: boolean;
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
        (q) => q.in("trade_id", chunk)
      )
    )
  );
  const byTrade = new Map<string, any[]>();
  for (const raw of itemPages.flat()) {
    // removed_at은 예약 목록 제외 표식이지만 taken_qty>0은 실제 반출 기준선이다.
    // 과거 버전에서 반출 뒤 제외된 행도 taken 상태로 되살려 반납 체크리스트에서
    // 사라지지 않게 한다.
    if (raw.removed_at && !(Number(raw.taken_qty) > 0)) continue;
    const it = raw.removed_at && Number(raw.taken_qty) > 0
      ? { ...raw, checkout_state: "taken" }
      : raw;
    (byTrade.get(it.trade_id) ?? byTrade.set(it.trade_id, []).get(it.trade_id)!).push(it);
  }
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

function tradeStructureRow(trade: Trade): any {
  const row = tradeToRow(trade);
  // 아래 열은 카드별 전용 writer 또는 앱 사용자가 소유한다. 시트 복구 snapshot이 덮지 않는다.
  delete row.contract_status;
  delete row.setup_done;
  delete row.setup_done_at;
  delete row.return_done;
  delete row.return_done_at;
  delete row.return_counts;
  delete row.payment_method;
  delete row.payment_warning;
  delete row.deposit_status;
  delete row.proof_type;
  delete row.issue_status;
  delete row.billing_company;
  delete row.estimate_sent;
  delete row.note_checkout;
  delete row.note_checkin;
  delete row.photos;
  delete row.contract_regen_pending;
  return row;
}

function scheduleStructureRow(row: any): any {
  const structural = { ...row };
  // 반출/반납 상태와 앱 메타데이터는 항목별 PATCH writer가 소유한다.
  delete structural.taken_qty;
  delete structural.actual_name;
  delete structural.actual_taken_qty;
  delete structural.actual_source;
  delete structural.checkout_state;
  delete structural.settlement;
  delete structural.start_shift_days;
  delete structural.end_shift_days;
  delete structural.memo_checkout;
  delete structural.memo_checkin;
  return structural;
}

/**
 * 시트/복구 snapshot을 저장한다.
 * - 누락 행은 전체 값으로 insert하되 기존 행은 ignore하여 오래된 snapshot의 역행을 막는다.
 * - 기존 구조 갱신은 명시적인 수동 동기화만 허용하며, 상태/메모 열은 항상 제외한다.
 */
export async function persistTrade(trade: Trade, options: PersistTradeOptions = {}): Promise<void> {
  const sb = supabase;
  if (!sb) return;
  // supabase-js는 실패 시 throw하지 않고 {error}를 반환한다. 세션 만료(RLS 거부)·네트워크·스키마
  // 오류를 그냥 무시하면 반출/반납 체크·결제상태가 유실됐는데도 화면엔 '저장됨'으로 뜬다.
  // error를 확인해 throw → schedulePersistTrade의 catch가 사용자에게 실패를 알리도록 한다.
  const tradeRow = tradeToRow(trade);
  // 신규 행에는 현재 원장 상태 전체가 필요하다. ignoreDuplicates가 기존 행 충돌을 무시하므로
  // 오래된 snapshot은 기존 완료/반납 상태를 덮지 않고, 누락 거래만 정확한 상태로 생성한다.
  const { error: tradeErr } = await sb.from("trades").upsert(tradeRow, {
    onConflict: "trade_id",
    ignoreDuplicates: true,
  });
  if (tradeErr) throw tradeErr;

  if (options.updateExistingStructure) {
    const { error: structureErr } = await sb
      .from("trades")
      .upsert(tradeStructureRow(trade), { onConflict: "trade_id" });
    if (structureErr) throw structureErr;
  }

  const rows = uniqueScheduleRows(trade);
  // 반출 후 누락 행은 taken_qty 불변 기준선이 확인된 행만 복구한다.
  // 기준선 없는 dashboard snapshot은 GAS의 repairTradeProjection이 시트·기존 기준선을
  // 검증한 뒤 추가한다. 여기서 null taken_qty로 insert하면 반납 검증이 무력화된다.
  const checkoutLocked = isCheckoutBaselineLocked(trade) || rows.some((row) => Number(row.taken_qty) > 0);
  const insertRows = checkoutLocked
    ? rows.filter((row) => Number(row.taken_qty) > 0)
    : rows;
  if (insertRows.length) {
    // 먼저 누락 행만 생성한다. 기존 행의 checkout/memo/settlement 등은 절대 건드리지 않는다.
    const { error: insertItemsErr } = await sb
      .from("schedule_items")
      .upsert(insertRows, { onConflict: "schedule_id", ignoreDuplicates: true });
    if (insertItemsErr) throw insertItemsErr;
    // 반출 후 구조 투영은 DB에 없는 행을 기준선 없이 INSERT하지 않도록
    // GAS의 existing-only 구조 writer가 담당한다.
    if (options.updateExistingStructure && !checkoutLocked) {
      const { error: structureItemsErr } = await sb
        .from("schedule_items")
        .upsert(rows.map(scheduleStructureRow), { onConflict: "schedule_id" });
      if (structureItemsErr) throw structureItemsErr;
    }
  }
  if (options.pruneMissingSheetBacked) await pruneMissingSheetBackedItems(sb, trade.tradeId, rows);
}

function scheduleItemDbId(tradeId: string, scheduleId: string): string {
  const appScheduleId = canonicalOnsiteScheduleId(scheduleId, tradeId);
  return appScheduleId.startsWith(`${tradeId}-`) ? appScheduleId : `${tradeId}-${appScheduleId}`;
}

/** 메모·정산·타임라인 보정처럼 앱만 소유하는 품목 필드는 해당 열만 갱신한다. */
export async function persistScheduleItemPatch(
  tradeId: string,
  scheduleId: string,
  patch: Record<string, string | number | boolean | null>,
): Promise<void> {
  const sb = supabase;
  if (!sb || !Object.keys(patch).length) return;
  const dbScheduleId = scheduleItemDbId(tradeId, scheduleId);
  const { data, error } = await sb
    .from("schedule_items")
    .update(patch)
    .eq("trade_id", tradeId)
    .eq("schedule_id", dbScheduleId)
    .select("schedule_id")
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error(`품목 저장 대상이 없습니다: ${scheduleId}`);
}

/** 카드에서 실제로 바꾼 거래 열만 저장한다. 다른 직원의 무관한 최신 필드는 건드리지 않는다. */
export async function persistTradeFieldPatch(
  tradeId: string,
  patch: Record<string, string | number | boolean | null>,
): Promise<void> {
  const sb = supabase;
  if (!sb || !Object.keys(patch).length) return;
  const { data, error } = await sb
    .from("trades")
    .update(patch)
    .eq("trade_id", tradeId)
    .select("trade_id")
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error(`거래 저장 대상이 없습니다: ${tradeId}`);
}

const RETURN_COUNT_CAS_ATTEMPTS = 8;

/** 완료된 거래를 오래된 화면이 수정하려는 충돌. 호출부는 GAS 정본을 먼저 재오픈한다. */
export class ReturnCompletionConflictError extends Error {
  constructor(tradeId: string) {
    super(`반납완료 거래를 먼저 다시 열어야 합니다: ${tradeId}`);
    this.name = "ReturnCompletionConflictError";
  }
}

/** 반납 체크의 빠른 경로: 호출자가 바꾼 scheduleId 묶음만 jsonb CAS 병합한다.
 * 한 직원이 빠르게 10줄을 눌러도
 * 1개 batch가 되고, 다른 직원이 먼저 저장했으면 그 JSON을 다시 읽어 내 batch만 합친다.
 */
export async function persistReturnCounts(
  tradeId: string,
  returnCountsPatch: Record<string, Partial<ReturnCount> | null>,
): Promise<void> {
  const sb = supabase;
  if (!sb) return;
  if (!Object.keys(returnCountsPatch).length) return;
  for (let attempt = 0; attempt < RETURN_COUNT_CAS_ATTEMPTS; attempt++) {
    const { data: currentRow, error: readError } = await sb
      .from("trades")
      .select("trade_id,return_counts,return_done")
      .eq("trade_id", tradeId)
      .maybeSingle();
    if (readError) throw readError;
    if (!currentRow) throw new Error(`반납 수량 저장 대상 거래가 없습니다: ${tradeId}`);
    if (currentRow.return_done === true) throw new ReturnCompletionConflictError(tradeId);

    const currentRaw = currentRow.return_counts;
    const current = currentRaw && typeof currentRaw === "object" && !Array.isArray(currentRaw)
      ? currentRaw as Record<string, ReturnCount>
      : {};
    const next: Record<string, ReturnCount> = { ...current };
    for (const [scheduleId, count] of Object.entries(returnCountsPatch)) {
      if (count == null) delete next[scheduleId];
      else {
        const currentCount = current[scheduleId] ?? { good: 0, damaged: 0, lost: 0 };
        next[scheduleId] = { ...currentCount, ...count };
      }
    }
    let update = sb
      .from("trades")
      .update({ return_counts: next })
      .eq("trade_id", tradeId);
    update = currentRaw == null
      ? update.is("return_counts", null)
      : update.filter("return_counts", "eq", JSON.stringify(currentRaw));
    update = update.or("return_done.is.null,return_done.eq.false");
    const { data: updated, error: updateError } = await update
      .select("trade_id")
      .maybeSingle();
    if (updateError) throw updateError;
    if (updated) return;
  }
  throw new Error(`반납 수량 동시 저장 충돌이 계속됩니다: ${tradeId}`);
}

/** 단일 품목 호출도 같은 batch CAS 경로를 사용한다. */
export async function persistReturnCountPatch(
  tradeId: string,
  scheduleId: string,
  count: ReturnCount,
): Promise<void> {
  return persistReturnCounts(tradeId, { [scheduleId]: count });
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

export async function deleteScheduleItem(
  tradeId: string,
  scheduleId: string,
  options?: { expectedName?: string },
): Promise<"deleted" | "already-missing"> {
  const sb = supabase;
  if (!sb) return "already-missing";
  const variants = deleteScheduleItemVariants(tradeId, scheduleId);
  if (variants) {
    let deletion = sb
      .from("schedule_items")
      .delete()
      .eq("trade_id", tradeId)
      .is("taken_qty", null)
      .or(`schedule_id.eq.${variants.canonical},schedule_id.eq.${variants.prefixed},schedule_id.like.${variants.prefixed}__%`);
    if (options?.expectedName) deletion = deletion.eq("name", options.expectedName);
    const { data, error } = await deletion.select("schedule_id");
    if (error) throw error;
    if (data?.length) return "deleted";
    return verifyMissingScheduleItemDelete_(tradeId, scheduleId, options?.expectedName, variants);
  }
  let deletion = sb
    .from("schedule_items")
    .delete()
    .eq("trade_id", tradeId)
    .eq("schedule_id", scheduleId)
    .is("taken_qty", null);
  if (options?.expectedName) deletion = deletion.eq("name", options.expectedName);
  const { data, error } = await deletion.select("schedule_id");
  if (error) throw error;
  if (data?.length) return "deleted";
  return verifyMissingScheduleItemDelete_(tradeId, scheduleId, options?.expectedName);
}

async function verifyMissingScheduleItemDelete_(
  tradeId: string,
  scheduleId: string,
  expectedName?: string,
  variants?: { canonical: string; prefixed: string },
): Promise<"already-missing"> {
  const sb = supabase;
  if (!sb) return "already-missing";
  let query = sb
    .from("schedule_items")
    .select("schedule_id,name,taken_qty")
    .eq("trade_id", tradeId);
  query = variants
    ? query.or(`schedule_id.eq.${variants.canonical},schedule_id.eq.${variants.prefixed},schedule_id.like.${variants.prefixed}__%`)
    : query.eq("schedule_id", scheduleId);
  const { data, error } = await query;
  if (error) throw error;
  if (!data?.length) return "already-missing";
  if (data.some((row: any) => Number(row.taken_qty) > 0)) {
    throw new Error("반출 기준선이 있는 품목은 삭제할 수 없습니다");
  }
  if (expectedName && data.some((row: any) => String(row.name || "").trim() !== expectedName.trim())) {
    throw new Error("같은 스케줄ID가 다른 장비로 바뀌어 삭제를 중단했습니다");
  }
  throw new Error("Supabase 품목 삭제가 확정되지 않았습니다");
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
