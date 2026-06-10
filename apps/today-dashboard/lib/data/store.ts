"use client";

// 클라이언트 옵티미스틱 스토어 (프로토타입).
// 변이는 즉시 반영 + "저장 중 → 저장됨" 시뮬레이션. 추후 이 레이어만 Supabase 호출로 교체.

import { useSyncExternalStore } from "react";
import type {
  CheckoutState,
  DashboardDay,
  EquipmentItem,
  HandoverNote,
  Phase,
  ReturnCount,
  Settlement,
  Trade,
} from "../domain/types";
import { buildSeed } from "./seed";
import { isSupabase } from "../supabase/client";
import { categoryOf } from "../domain/catalog";
import { deleteScheduleItem, fetchAllTrades, fetchNotes, persistNotes, persistTrade, subscribeChanges } from "./remote";
import { gasMutation, gasWrite } from "./writeback";
import { pollTimelineChanges, repairDashboardDateDetails, repairDashboardDetailsForIncompleteTrades, repairDashboardSearchResults } from "./sync";

interface State {
  date: string;
  trades: Trade[];
  notes: HandoverNote[];
  savingTrades: Record<string, boolean>;
  toast: { id: number; text: string; kind: "saving" | "saved" } | null;
}

const cache: Record<string, { trades: Trade[]; notes: HandoverNote[] }> = {};
let state: State = { date: "", trades: [], notes: [], savingTrades: {}, toast: null };
const listeners = new Set<() => void>();
let toastSeq = 0;
let onsiteSeq = 0;

function emit() {
  for (const l of listeners) l();
}
function set(next: Partial<State>) {
  state = { ...state, ...next };
  emit();
}
function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}
function getSnapshot(): State {
  return state;
}
function dayData(date: string) {
  if (!cache[date]) cache[date] = buildSeed(date);
  return cache[date];
}

// ── Supabase(실데이터) 모드 ────────────────────────────────────
let remoteLoaded = false;
let subscribed = false;
let refetchTimer: ReturnType<typeof setTimeout> | null = null;
const persistTimers: Record<string, ReturnType<typeof setTimeout>> = {};
const persistGenerations: Record<string, number> = {};
const pendingPersistTrades = new Set<string>();
let notesTimer: ReturnType<typeof setTimeout> | null = null;
let notesPersistGeneration = 0;
let notesPersistPending = false;
let pollTimer: ReturnType<typeof setInterval> | null = null;
const POLL_MS = 90_000;
let localMutationSeq = 0;

function markLocalMutation() {
  localMutationSeq++;
}

function hasPendingPersist(): boolean {
  return pendingPersistTrades.size > 0 || notesPersistPending;
}

function canApplyRemoteSnapshot(mutationSeqAtStart: number): boolean {
  return !hasPendingPersist() && mutationSeqAtStart === localMutationSeq;
}

function mergeTradeChanges(base: Trade[], changed: Trade[]): Trade[] {
  const byId = new Map(changed.map((t) => [t.tradeId, t]));
  const merged = base.map((t) => byId.get(t.tradeId) ?? t);
  for (const t of changed) if (!base.some((x) => x.tradeId === t.tradeId)) merged.push(t);
  return merged;
}

async function repairEmptyEquipmentTrades(base = state.trades, mutationSeqAtStart = localMutationSeq): Promise<boolean> {
  const changed = await repairDashboardDetailsForIncompleteTrades(base);
  if (!changed.length) return false;
  if (!canApplyRemoteSnapshot(mutationSeqAtStart)) return false;
  set({ trades: mergeTradeChanges(base, changed) });
  for (const t of changed) persistTrade(t).catch(() => {});
  return true;
}

async function applyDashboardRepairs(changed: Trade[], mutationSeqAtStart: number): Promise<boolean> {
  if (!changed.length) return false;
  if (!canApplyRemoteSnapshot(mutationSeqAtStart)) return false;
  set({ trades: mergeTradeChanges(state.trades, changed) });
  for (const t of changed) persistTrade(t).catch(() => {});
  return true;
}

async function repairDayDetails(date: string, mutationSeqAtStart = localMutationSeq): Promise<boolean> {
  if (!isSupabase || hasPendingPersist()) return false;
  const changed = await repairDashboardDateDetails(state.trades, date);
  return applyDashboardRepairs(changed, mutationSeqAtStart);
}

export async function repairSearchResults(query: string): Promise<void> {
  if (!isSupabase || hasPendingPersist()) return;
  const q = query.trim();
  if (q.length < 2) return;
  const mutationSeqAtSearch = localMutationSeq;
  const changed = await repairDashboardSearchResults(state.trades, q);
  await applyDashboardRepairs(changed, mutationSeqAtSearch);
}

async function loadRemote() {
  try {
    const [trades, notes] = await Promise.all([fetchAllTrades(), fetchNotes()]);
    remoteLoaded = true;
    set({ trades, notes });
    await repairEmptyEquipmentTrades(trades);
    if (state.date) await repairDayDetails(state.date);
  } catch (e) {
    console.error("[supabase] load 실패", e);
  }
  if (!subscribed) {
    subscribed = true;
    subscribeChanges(() => {
      if (hasPendingPersist()) return; // 내 변이 반영 중이면 스킵
      const mutationSeqAtSchedule = localMutationSeq;
      if (refetchTimer) clearTimeout(refetchTimer);
      refetchTimer = setTimeout(async () => {
        if (!canApplyRemoteSnapshot(mutationSeqAtSchedule)) return;
        try {
          const [trades, notes] = await Promise.all([fetchAllTrades(), fetchNotes()]);
          if (!canApplyRemoteSnapshot(mutationSeqAtSchedule)) return;
          set({ trades, notes });
          await repairEmptyEquipmentTrades(trades, mutationSeqAtSchedule);
        } catch {
          /* noop */
        }
      }, 500);
    });
  }
  // 시트→앱 자동 폴링(변경분만): 90초마다 timeline에서 예약 변경 감지
  if (!pollTimer) {
    pollTimer = setInterval(async () => {
      if (hasPendingPersist() || document.hidden) return;
      const mutationSeqAtPoll = localMutationSeq;
      try {
        if (await repairEmptyEquipmentTrades(state.trades, mutationSeqAtPoll)) return;
        const changed = await pollTimelineChanges(state.trades);
        if (!changed.length) return;
        if (!canApplyRemoteSnapshot(mutationSeqAtPoll)) return;
        set({ trades: mergeTradeChanges(state.trades, changed) });
        for (const t of changed) persistTrade(t).catch(() => {});
      } catch {
        /* noop */
      }
    }, POLL_MS);
  }
}

function schedulePersistTrade(trade: Trade) {
  if (!isSupabase) return;
  const tradeId = trade.tradeId;
  const generation = (persistGenerations[tradeId] ?? 0) + 1;
  persistGenerations[tradeId] = generation;
  pendingPersistTrades.add(tradeId);
  if (persistTimers[trade.tradeId]) clearTimeout(persistTimers[trade.tradeId]);
  persistTimers[trade.tradeId] = setTimeout(async () => {
    const latest = state.trades.find((t) => t.tradeId === tradeId) ?? trade;
    try {
      await persistTrade(latest);
    } catch (e) {
      console.error("[supabase] 저장 실패", e);
    } finally {
      if (persistGenerations[tradeId] === generation) {
        delete persistGenerations[tradeId];
        delete persistTimers[tradeId];
        pendingPersistTrades.delete(tradeId);
      }
    }
  }, 450);
}
function schedulePersistNotes() {
  if (!isSupabase) return;
  const generation = ++notesPersistGeneration;
  notesPersistPending = true;
  if (notesTimer) clearTimeout(notesTimer);
  notesTimer = setTimeout(async () => {
    try {
      await persistNotes(state.notes);
    } catch (e) {
      console.error("[supabase] 메모 저장 실패", e);
    } finally {
      if (notesPersistGeneration === generation) notesPersistPending = false;
    }
  }, 600);
}

export function loadDay(date: string) {
  if (isSupabase) {
    if (state.date !== date) set({ date });
    if (!remoteLoaded) loadRemote();
    else repairDayDetails(date);
    return;
  }
  if (state.date === date && state.trades.length) return;
  const d = dayData(date);
  state = { date, trades: d.trades, notes: d.notes, savingTrades: {}, toast: null };
  emit();
}

function flashSave(tradeId?: string) {
  const id = ++toastSeq;
  if (tradeId) set({ savingTrades: { ...state.savingTrades, [tradeId]: true }, toast: { id, text: "저장 중…", kind: "saving" } });
  else set({ toast: { id, text: "저장 중…", kind: "saving" } });
  if (typeof window === "undefined") return;
  window.setTimeout(() => {
    const saving = { ...state.savingTrades };
    if (tradeId) delete saving[tradeId];
    set({ savingTrades: saving, toast: { id, text: "저장됨", kind: "saved" } });
    window.setTimeout(() => {
      if (state.toast?.id === id) set({ toast: null });
    }, 1100);
  }, 420);
}

function mutateTrade(tradeId: string, fn: (t: Trade) => Trade) {
  markLocalMutation();
  let changed: Trade | undefined;
  const trades = state.trades.map((t) => (t.tradeId === tradeId ? (changed = fn(t)) : t));
  if (!isSupabase) cache[state.date] = { trades, notes: state.notes };
  set({ trades });
  if (changed) schedulePersistTrade(changed);
}
function mapItem(t: Trade, scheduleId: string, fn: (e: Trade["equipments"][number]) => Trade["equipments"][number]): Trade {
  return { ...t, equipments: t.equipments.map((e) => (e.scheduleId === scheduleId ? fn(e) : e)) };
}

// ── 거래 단위 검수 토글 ─────────────────────────────────────────
export function toggleSetup(tradeId: string) {
  let done = false;
  mutateTrade(tradeId, (t) => {
    done = !t.setupDone;
    return { ...t, setupDone: done, setupDoneAt: done ? new Date().toISOString() : null };
  });
  flashSave(tradeId);
  gasWrite("toggleSetup", { tid: tradeId, done });
}
export function toggleReturn(tradeId: string) {
  let on = false;
  mutateTrade(tradeId, (t) => {
    on = !t.returnDone;
    return { ...t, returnDone: on, returnDoneAt: on ? new Date().toISOString() : null, contractStatus: on ? "반납완료" : "반출" };
  });
  flashSave(tradeId);
  gasWrite("toggleReturn", { tid: tradeId, done: on });
}

// ── 품목별 반출/반납 상태 ───────────────────────────────────────
export function setItemCheckout(tradeId: string, scheduleId: string, next: CheckoutState) {
  let final: CheckoutState | undefined;
  mutateTrade(tradeId, (t) =>
    mapItem(t, scheduleId, (e) => {
      final = e.checkoutState === next ? "pending" : next;
      return { ...e, checkoutState: final };
    }),
  );
  flashSave(tradeId);
  if (final === "taken") gasWrite("toggleItem", { scheduleId, phase: "checkout", done: true });
  else if (final === "pending") gasWrite("toggleItem", { scheduleId, phase: "checkout", done: false });
  // 'excluded'(제외)는 시트에 대응 칸 없음 → Supabase 전용
}
export function setItemName(tradeId: string, scheduleId: string, name: string) {
  const clean = name.trim();
  if (!clean) return;
  mutateTrade(tradeId, (t) =>
    mapItem(t, scheduleId, (e) => ({
      ...e,
      name: clean,
      setName: e.setName && e.setName.trim() === e.name.trim() ? clean : e.setName,
      category: categoryOf(clean) ?? e.category,
    })),
  );
  flashSave(tradeId);
  gasWrite("updateEquipName", { tid: tradeId, scheduleId, equipName: clean });
}
export function setItemQty(tradeId: string, scheduleId: string, qty: number) {
  const safeQty = Math.max(1, Math.round(qty));
  mutateTrade(tradeId, (t) =>
    mapItem(t, scheduleId, (e) => ({
      ...e,
      qty: safeQty,
      takenQty: e.takenQty != null ? Math.min(e.takenQty, safeQty) : undefined,
    })),
  );
  flashSave(tradeId);
  gasWrite("updateEquipQty", { tid: tradeId, scheduleId, qty: safeQty });
}
export function setItemMemo(tradeId: string, scheduleId: string, phase: Phase, text: string) {
  mutateTrade(tradeId, (t) =>
    mapItem(t, scheduleId, (e) => (phase === "checkout" ? { ...e, memoCheckout: text } : { ...e, memoCheckin: text })),
  );
  flashSave(tradeId);
}

// ── 현장 항목 추가/삭제 ─────────────────────────────────────────
export type OnsiteEntry = {
  name: string;
  qty: number;
  category?: string;
  offCatalog?: boolean;
  isSetHeader?: boolean;
  isComponent?: boolean;
  setName?: string;
  emphasize?: boolean;
};

export function addOnsiteItems(tradeId: string, entries: OnsiteEntry[], settlement: Settlement) {
  mutateTrade(tradeId, (t) => {
    const add: EquipmentItem[] = entries.map((en) => ({
      scheduleId: `ONS-${++onsiteSeq}`,
      name: en.name,
      qty: en.qty,
      category: en.category,
      offCatalog: en.offCatalog,
      isSetHeader: en.isSetHeader,
      isComponent: en.isComponent,
      setName: en.setName,
      emphasize: en.emphasize,
      onsite: true,
      settlement,
      checkoutState: "taken",
      returnState: "pending",
    }));
    return { ...t, equipments: [...t.equipments, ...add] };
  });
  flashSave(tradeId);
}
export function setOnsiteSettlement(tradeId: string, scheduleId: string, settlement: Settlement) {
  mutateTrade(tradeId, (t) => mapItem(t, scheduleId, (e) => ({ ...e, settlement })));
  flashSave(tradeId);
}
export function removeItem(tradeId: string, scheduleId: string) {
  mutateTrade(tradeId, (t) => ({ ...t, equipments: t.equipments.filter((e) => e.scheduleId !== scheduleId) }));
  flashSave(tradeId);
  deleteScheduleItem(tradeId, scheduleId).catch(() => {});
}

// ── 반납: 품목(scheduleId) 단위 카운트 + 시트 write-back ────────────
export function setReturnCount(tradeId: string, scheduleId: string, patch: Partial<ReturnCount>) {
  let writeback: boolean | undefined;
  mutateTrade(tradeId, (t) => {
    const item = t.equipments.find((e) => e.scheduleId === scheduleId);
    const expected = item ? item.takenQty ?? item.qty : 0;
    const cur = t.returnCounts?.[scheduleId] ?? { good: 0, damaged: 0, lost: 0 };
    const next = { ...cur, ...patch };
    const wasIn = expected > 0 && cur.good + cur.damaged + cur.lost >= expected;
    const isIn = expected > 0 && next.good + next.damaged + next.lost >= expected;
    if (wasIn !== isIn) writeback = isIn; // 줄이 전부 처리됨 ↔ 해제 전환 시에만 시트 반영
    return { ...t, returnCounts: { ...t.returnCounts, [scheduleId]: next } };
  });
  flashSave(tradeId);
  if (writeback !== undefined) gasWrite("toggleItem", { scheduleId, phase: "checkin", done: writeback });
}

// ── 결제·정산 (개고생2.0 회계로 write-back 대상) ────────────────
export function setPaymentMethod(tradeId: string, method: string) {
  mutateTrade(tradeId, (t) => ({ ...t, paymentMethod: method }));
  flashSave(tradeId);
  gasWrite("updatePayment", { tid: tradeId, method });
}
export function setDepositStatus(tradeId: string, status: string) {
  mutateTrade(tradeId, (t) => ({ ...t, depositStatus: status, paymentWarning: /미|대기|예정/.test(status) }));
  flashSave(tradeId);
  gasWrite("updateTradeProof", { tid: tradeId, field: "depositStatus", value: status });
}
export function setProofType(tradeId: string, proofType: string) {
  mutateTrade(tradeId, (t) => ({ ...t, proofType }));
  flashSave(tradeId);
  gasWrite("updateTradeProof", { tid: tradeId, field: "proofType", value: proofType });
}
export function setIssueStatus(tradeId: string, issueStatus: string) {
  mutateTrade(tradeId, (t) => ({ ...t, issueStatus }));
  flashSave(tradeId);
  gasWrite("updateTradeProof", { tid: tradeId, field: "issueStatus", value: issueStatus });
}
export function setBillingCompany(tradeId: string, billingCompany: string) {
  mutateTrade(tradeId, (t) => ({ ...t, billingCompany }));
  flashSave(tradeId);
  gasWrite("updateBillingCompany", { tid: tradeId, billingCompany });
}
export function sendEstimate(tradeId: string) {
  mutateTrade(tradeId, (t) => ({ ...t, estimateSent: true }));
  flashSave(tradeId);
  gasWrite("sendEstimate", { tid: tradeId });
}

export async function regenerateContract(tradeId: string) {
  mutateTrade(tradeId, (t) => ({ ...t, contractRegenPending: true }));
  flashSave(tradeId);
  try {
    const res = await gasMutation("regenerateContract", { tid: tradeId });
    const result = res?.result || res;
    const url = result?.url || res?.url || "";
    mutateTrade(tradeId, (t) => ({ ...t, contractUrl: url || t.contractUrl, contractRegenPending: false }));
    flashSave(tradeId);
  } catch (error) {
    mutateTrade(tradeId, (t) => ({ ...t, contractRegenPending: false }));
    flashSave(tradeId);
    console.error("[contract] regenerate failed:", error);
    throw error;
  }
}

// ── 타임라인: 이 품목(막대)만 날짜 이동/리사이즈 (드래그) ────────
export function shiftEquipmentDates(tradeId: string, scheduleId: string, days: number) {
  if (!days) return;
  mutateTrade(tradeId, (t) =>
    mapItem(t, scheduleId, (e) => ({ ...e, startShiftDays: (e.startShiftDays ?? 0) + days, endShiftDays: (e.endShiftDays ?? 0) + days })),
  );
  flashSave(tradeId);
}
export function resizeEquipment(tradeId: string, scheduleId: string, edge: "start" | "end", days: number) {
  if (!days) return;
  mutateTrade(tradeId, (t) =>
    mapItem(t, scheduleId, (e) => {
      const s0 = e.startShiftDays ?? 0;
      const en0 = e.endShiftDays ?? 0;
      // 시작이 종료를 넘지 않도록 보호는 컴포넌트에서 clamp; 여기선 그대로 반영
      return edge === "start" ? { ...e, startShiftDays: s0 + days } : { ...e, endShiftDays: en0 + days };
    }),
  );
  flashSave(tradeId);
}

// ── 반출/반납 전체 메모 (분리) ──────────────────────────────────
export function setPhaseNote(tradeId: string, phase: Phase, text: string) {
  mutateTrade(tradeId, (t) => (phase === "checkout" ? { ...t, noteCheckout: text } : { ...t, noteCheckin: text }));
  flashSave(tradeId);
}

// ── 인수인계 메모 ──────────────────────────────────────────────
function mutateNotes(notes: HandoverNote[]) {
  markLocalMutation();
  if (!isSupabase) cache[state.date] = { trades: state.trades, notes };
  set({ notes });
  schedulePersistNotes();
}
export function addNote() {
  mutateNotes([...state.notes, { id: `n${Date.now()}`, body: "" }]);
}
export function updateNote(id: string, body: string) {
  mutateNotes(state.notes.map((n) => (n.id === id ? { ...n, body } : n)));
}
export function deleteNote(id: string) {
  mutateNotes(state.notes.filter((n) => n.id !== id));
}

// ── 훅 ─────────────────────────────────────────────────────────
export function useDashboard(): DashboardDay & { savingTrades: Record<string, boolean> } {
  const s = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return { date: s.date, trades: s.trades, notes: s.notes, savingTrades: s.savingTrades };
}
export function useToast() {
  return useSyncExternalStore(subscribe, () => state.toast, () => state.toast);
}
