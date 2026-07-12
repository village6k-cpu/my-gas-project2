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
  PhotoMeta,
  ReturnCount,
  Settlement,
  Trade,
} from "../domain/types";
import { buildSeed } from "./seed";
import { isSupabase } from "../supabase/client";
import { categoryOf } from "../domain/catalog";
import { deleteScheduleItem, fetchAllTrades, fetchNotes, persistNotes, persistTrade, subscribeChanges } from "./remote";
import { gasMutation, gasRead, gasWrite, writeBackDisabledReason, writeBackEnabled } from "./writeback";
import {
  configurePhotoUploadQueue,
  discardPhotoUpload,
  enqueuePhotoUpload,
  resumePhotoUploads,
  retryPhotoUpload,
  type PhotoUploadJob,
} from "./photoUploadQueue";
import { pollTimelineChanges, repairDashboardDateDetails, repairDashboardDetailsForIncompleteTrades, repairDashboardSearchResults, shouldPruneMissingSheetBacked } from "./sync";

interface State {
  date: string;
  trades: Trade[];
  notes: HandoverNote[];
  savingTrades: Record<string, boolean>;
  toast: { id: number; text: string; kind: "saving" | "saved" | "error" } | null;
}

const cache: Record<string, { trades: Trade[]; notes: HandoverNote[] }> = {};
let state: State = { date: "", trades: [], notes: [], savingTrades: {}, toast: null };
const listeners = new Set<() => void>();
let toastSeq = 0;

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

type ContractMutationPayload = {
  result?: ContractMutationPayload;
  skipped?: boolean;
  error?: string;
  url?: string;
  contractUrl?: string;
  amount?: unknown;
  finalAmount?: unknown;
  contractRegenPending?: boolean;
  removedScheduleIds?: unknown;
  removedEquipments?: unknown;
};

function markLocalMutation() {
  localMutationSeq++;
}

function hasPendingPersist(): boolean {
  return pendingPersistTrades.size > 0 || notesPersistPending;
}

function canApplyRemoteSnapshot(mutationSeqAtStart: number): boolean {
  return !hasPendingPersist() && mutationSeqAtStart === localMutationSeq;
}

function preserveTradePhotos(next: Trade, previous?: Trade): Trade {
  const existing = previous?.photos ?? [];
  if (!existing.length) return next;
  if (!next.photos?.length) return { ...next, photos: existing };
  return { ...next, photos: mergePhotos(existing, next.photos) };
}

function preservePhotosInSnapshot(next: Trade[], previous = state.trades): Trade[] {
  const previousById = new Map(previous.map((t) => [t.tradeId, t]));
  return next.map((t) => preserveTradePhotos(t, previousById.get(t.tradeId)));
}

function mergeTradeChanges(base: Trade[], changed: Trade[]): Trade[] {
  const baseById = new Map(base.map((t) => [t.tradeId, t]));
  const byId = new Map(changed.map((t) => [t.tradeId, t]));
  const merged = base.map((t) => {
    const next = byId.get(t.tradeId);
    return next ? preserveTradePhotos(next, t) : t;
  });
  for (const t of changed) if (!baseById.has(t.tradeId)) merged.push(t);
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
  for (const t of changed) persistTrade(t, { pruneMissingSheetBacked: shouldPruneMissingSheetBacked(t) }).catch(() => {});
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
    const mergedTrades = preservePhotosInSnapshot(trades);
    remoteLoaded = true;
    set({ trades: mergedTrades, notes });
    await repairEmptyEquipmentTrades(mergedTrades);
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
          const mergedTrades = preservePhotosInSnapshot(trades);
          set({ trades: mergedTrades, notes });
          await repairEmptyEquipmentTrades(mergedTrades, mutationSeqAtSchedule);
        } catch {
          /* noop */
        }
      }, 500);
    });
  }
  // 시트→앱 자동 폴링(변경분만): 90초마다 timeline에서 예약 변경 감지
  if (!pollTimer) {
    pollTimer = setInterval(() => {
      if (document.hidden) return;
      void pollSheetChangesNow();
    }, POLL_MS);
  }
}

/**
 * 시트 변경분 즉시 반영 — 등록/수정 직후 90초 폴링을 기다리지 않고 호출.
 * (확인요청 등록 완료 시 신규 거래가 오늘일정·검색에 바로 보이도록)
 */
export async function pollSheetChangesNow(): Promise<void> {
  if (!isSupabase || hasPendingPersist()) return;
  const mutationSeqAtPoll = localMutationSeq;
  try {
    if (await repairEmptyEquipmentTrades(state.trades, mutationSeqAtPoll)) return;
    if (state.date && await repairDayDetails(state.date, mutationSeqAtPoll)) return;
    const changed = await pollTimelineChanges(state.trades);
    if (!changed.length) return;
    if (!canApplyRemoteSnapshot(mutationSeqAtPoll)) return;
    set({ trades: mergeTradeChanges(state.trades, changed) });
    for (const t of changed) persistTrade(t).catch(() => {});
  } catch {
    /* noop */
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
      // 실패를 화면에 알린다(예전엔 조용히 삼켜 '저장됨'만 떠서 유실을 몰랐다).
      // 다음 편집 시 schedulePersistTrade가 다시 호출되어 재저장이 시도된다.
      set({ toast: { id: ++toastSeq, text: "⚠️ 저장 실패 — 인터넷/로그인 확인 후 다시 시도", kind: "error" } });
      return;
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
      set({ toast: { id: ++toastSeq, text: "⚠️ 메모 저장 실패 — 인터넷/로그인 확인 후 다시 시도", kind: "error" } });
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

function unwrapContractMutation(raw: unknown): ContractMutationPayload {
  const payload = (raw ?? {}) as ContractMutationPayload;
  return payload.result ?? payload;
}

function numberFromMutation(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.replace(/[^0-9.-]/g, ""));
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}

function amountFromMutation(result: ContractMutationPayload): number | undefined {
  return numberFromMutation(result.finalAmount) ?? numberFromMutation(result.amount);
}

function contractUrlFromMutation(result: ContractMutationPayload): string {
  return String(result.url || result.contractUrl || "").trim();
}

function removedScheduleIdsFromMutation(result: ContractMutationPayload, fallback: string[]): string[] {
  const ids = Array.isArray(result.removedScheduleIds) ? result.removedScheduleIds : [];
  const clean = ids.map((id) => String(id || "").trim()).filter(Boolean);
  fallback.forEach((id) => {
    const cleanId = String(id || "").trim();
    if (cleanId && !clean.includes(cleanId)) clean.push(cleanId);
  });
  return clean;
}

function applyContractMutationResult(tradeId: string, raw: unknown, fallbackRemovedIds: string[] = []) {
  const result = unwrapContractMutation(raw);
  if (result.skipped) throw new Error("쓰기 백이 비활성화되어 원장에 반영되지 않았습니다");
  if (result.error) throw new Error(result.error);

  const url = contractUrlFromMutation(result);
  const amount = amountFromMutation(result);
  const removedIds = removedScheduleIdsFromMutation(result, fallbackRemovedIds);
  const removedSet = new Set(removedIds);
  removedIds.forEach((id) => deleteScheduleItem(tradeId, id).catch(() => {}));

  mutateTrade(tradeId, (t) => ({
    ...t,
    equipments: removedSet.size ? t.equipments.filter((e) => !removedSet.has(e.scheduleId)) : t.equipments,
    amount: amount ?? t.amount,
    contractUrl: url || t.contractUrl || null,
    contractRegenPending: !!result.contractRegenPending && !url,
  }));
  flashSave(tradeId);
}

function restoreRemovedItem(tradeId: string, item: EquipmentItem, message: string) {
  mutateTrade(tradeId, (t) => {
    const exists = t.equipments.some((e) => e.scheduleId === item.scheduleId);
    return {
      ...t,
      equipments: exists ? t.equipments : [...t.equipments, { ...item, checkoutState: "pending" }],
      contractRegenPending: false,
      issueNote: message,
    };
  });
  flashSave(tradeId);
}

function removeEquipmentAndRegenerateContract(tradeId: string, item: EquipmentItem) {
  const scheduleId = item.scheduleId;
  mutateTrade(tradeId, (t) => ({
    ...t,
    equipments: t.equipments.filter((e) => e.scheduleId !== scheduleId),
    contractRegenPending: true,
  }));
  flashSave(tradeId);
  deleteScheduleItem(tradeId, scheduleId).catch(() => {});

  gasMutation("removeEquip", {
    tid: tradeId,
    scheduleId,
    equipName: item.name,
    directRegenerate: true,
  })
    .then((res) => applyContractMutationResult(tradeId, res, [scheduleId]))
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      restoreRemovedItem(tradeId, item, "장비 제외/계약서 갱신 실패: " + message);
      console.error("[write-back] removeEquip 실패:", error);
    });
}

function isSheetBackedScheduleId(tradeId: string, scheduleId: string): boolean {
  return new RegExp(`^${tradeId}-\\d+$`).test(scheduleId);
}

function rejectSheetBackedRemovalWithoutWriteBack(tradeId: string, scheduleId?: string) {
  const message = "장비 제외 실패: " + writeBackDisabledReason;
  mutateTrade(tradeId, (t) => {
    const restored = scheduleId ? mapItem(t, scheduleId, (e) => ({ ...e, checkoutState: "pending" })) : t;
    return {
      ...restored,
      contractRegenPending: false,
      issueNote: message,
    };
  });
  flashSave(tradeId);
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
  // 해제 시 GAS는 이전 계약상태(예약 등)를 복원 — 앱이 무조건 '반출'로 두면 어긋남
  gasMutation("toggleReturn", { tid: tradeId, done: on })
    .then((res) => {
      const restored = res?.contractStatus;
      if (!on && restored && restored !== "반출") {
        mutateTrade(tradeId, (t) => ({ ...t, contractStatus: restored }));
      }
    })
    .catch((e) => console.error("[write-back] toggleReturn 실패:", e));
}

// ── 품목별 반출/반납 상태 ───────────────────────────────────────
export function setItemCheckout(tradeId: string, scheduleId: string, next: CheckoutState) {
  let final: CheckoutState | undefined;
  let isSynthetic = false;
  let targetItem: EquipmentItem | undefined;
  mutateTrade(tradeId, (t) =>
    mapItem(t, scheduleId, (e) => {
      final = e.checkoutState === next ? "pending" : next;
      isSynthetic = !!e.synthetic;
      targetItem = e;
      return { ...e, checkoutState: final };
    }),
  );
  flashSave(tradeId);
  // 합성 ID(시트 행번호)는 실제 스케줄ID와 달라 엉뚱한 품목에 체크가 기록될 수 있음 → 시트 write 차단
  if (isSynthetic) return;
  if (final === "excluded" && targetItem) {
    if (writeBackEnabled) {
      removeEquipmentAndRegenerateContract(tradeId, targetItem);
    } else {
      rejectSheetBackedRemovalWithoutWriteBack(tradeId, scheduleId);
    }
    return;
  }
  if (final === "taken") gasWrite("toggleItem", { scheduleId, phase: "checkout", done: true });
  else if (final === "pending") gasWrite("toggleItem", { scheduleId, phase: "checkout", done: false });
  // 원장 쓰기가 꺼져 있으면 제외를 앱 상태로만 숨기지 않는다.
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
  // 세트 헤더 수량 변경 시 GAS가 구성품 수량을 비례 조정 — 응답을 받아 앱/Supabase도 동일하게
  gasMutation("updateEquipQty", { tid: tradeId, scheduleId, qty: safeQty })
    .then((res) => {
      const updates: { scheduleId: string; newQty: number }[] = res?.updatedItems ?? [];
      if (updates.length <= 1) return;
      const byId = new Map(updates.map((u) => [u.scheduleId, Number(u.newQty) || 1]));
      mutateTrade(tradeId, (t) => ({
        ...t,
        equipments: t.equipments.map((e) => (byId.has(e.scheduleId) ? { ...e, qty: byId.get(e.scheduleId)! } : e)),
      }));
    })
    .catch((e) => console.error("[write-back] updateEquipQty 실패:", e));
}
// 품목 메모는 적은 시점(phase)별로 저장한다. 반대쪽 카드에는 출처 태그와 함께 그대로 노출되므로
// 예전처럼 양쪽 필드에 미러링하지 않는다 (미러링하면 반출/반납 구분이 사라짐).
export function setItemMemo(tradeId: string, scheduleId: string, phase: Phase, text: string) {
  const memo = text.trim();
  mutateTrade(tradeId, (t) =>
    mapItem(t, scheduleId, (e) =>
      phase === "checkout" ? { ...e, memoCheckout: memo } : { ...e, memoCheckin: memo },
    ),
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

function onsiteNumber(scheduleId: string): number {
  const match = String(scheduleId || "").match(/(?:^|-)ONS-(\d+)/);
  return match ? Number(match[1]) : 0;
}

function nextOnsiteScheduleId(t: Trade): string {
  const next = t.equipments.reduce((max, e) => Math.max(max, onsiteNumber(e.scheduleId)), 0) + 1;
  return `ONS-${next}`;
}

function sameOnsiteName(a: string, b: string): boolean {
  return a.trim().replace(/\s+/g, " ").toLowerCase() === b.trim().replace(/\s+/g, " ").toLowerCase();
}

function findMergeableOnsiteItem(t: Trade, en: OnsiteEntry, settlement: Settlement): EquipmentItem | undefined {
  if (en.isSetHeader || en.isComponent || en.setName) return undefined;
  return t.equipments.find(
    (e) =>
      e.onsite &&
      !e.isSetHeader &&
      !e.isComponent &&
      !e.setName &&
      sameOnsiteName(e.name, en.name) &&
      (e.settlement ?? settlement) === settlement,
  );
}

// 메모리/배터리/카드 등 수량 주의 품목 강조 (sync.ts EMPH와 동일 기준)
const ONSITE_EMPH = /배터리|메모리|카드|CFexpress|SD|미디어/;

/** 현장추가 — 앱(Supabase) 전용 옵티미스틱 추가. write-back이 꺼져 있을 때의 폴백. */
function addOnsiteItemsLocal(tradeId: string, entries: OnsiteEntry[], settlement: Settlement) {
  mutateTrade(tradeId, (t) => {
    let nextTrade = { ...t, equipments: [...t.equipments] };
    for (const en of entries) {
      const target = findMergeableOnsiteItem(nextTrade, en, settlement);
      if (target) {
        nextTrade = {
          ...nextTrade,
          equipments: nextTrade.equipments.map((e) =>
            e.scheduleId === target.scheduleId
              ? { ...e, qty: target.qty + en.qty, checkoutState: "taken", settlement }
              : e,
          ),
        };
        continue;
      }
      const add: EquipmentItem = {
        scheduleId: nextOnsiteScheduleId(nextTrade),
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
      };
      nextTrade = { ...nextTrade, equipments: [...nextTrade.equipments, add] };
    }
    return nextTrade;
  });
  flashSave(tradeId);
}

/** 현장추가 — 유상만 스케줄상세(시트)에 기록되도록 GAS onsiteAddon 호출 후, 시트가 발급한
 *  실 scheduleId로 품목을 반영한다. 무상/미정은 반출 카드 운영 원장에만 남긴다.
 *  세트는 백엔드가 세트마스터로 구성품을 전개하므로 대표/단품만 보낸다.
 *  자유입력 품목은 rawNames로 그대로 시트에 기록됨(장비마스터 매칭 안 함). 가용 불가면 에러를 던진다. */
export async function addOnsiteItems(tradeId: string, entries: OnsiteEntry[], settlement: Settlement) {
  // 무상/미정 현장추가는 반출 카드 전용 운영 기록이다. 유상만 정산/계약/스케줄 원장으로 승격한다.
  if (settlement !== "유상" || !writeBackEnabled) {
    addOnsiteItemsLocal(tradeId, entries, settlement);
    return;
  }

  // 세트 구성품은 백엔드가 세트마스터로 다시 전개하므로 대표행/단품만 전송(중복 방지)
  const payload = entries.filter((e) => !e.isComponent).map((e) => ({ name: e.name, qty: e.qty }));
  if (payload.length === 0) return;

  const res = await gasMutation("onsiteAddon", {
    tid: tradeId,
    entries: JSON.stringify(payload),
    rawNames: true,
    settlement_status: settlement,
    actorName: "오늘 일정 웹앱",
    directRegenerate: true,
  });

  // write-back 게이트가 막았으면 폴백
  if (res?.skipped) {
    addOnsiteItemsLocal(tradeId, entries, settlement);
    return;
  }

  const out = res?.result ?? res ?? {};
  const mutationResult = unwrapContractMutation(res);
  const url = contractUrlFromMutation(mutationResult);
  const amount = amountFromMutation(mutationResult);
  const added = (out.addedItems ?? []) as Array<{
    scheduleId?: string;
    name?: string;
    qty?: number;
    setName?: string;
    isHeader?: boolean;
    isComponent?: boolean;
  }>;
  if (added.length === 0) {
    throw new Error(out.error || "현장 추가가 스케줄상세에 반영되지 않았습니다");
  }

  // 원래 입력의 자유입력 여부 매핑(시트엔 기록되지만 재고 미연동 표시용)
  const offByName = new Map(entries.map((e) => [e.name.trim(), !!e.offCatalog]));

  const newItems: EquipmentItem[] = added.map((a) => {
    const name = String(a.name ?? "").trim();
    return {
      scheduleId: String(a.scheduleId ?? "").trim(),
      name,
      qty: Number(a.qty) || 1,
      setName: a.setName || undefined,
      isSetHeader: a.isHeader || undefined,
      isComponent: a.isComponent || undefined,
      category: categoryOf(name) ?? undefined,
      offCatalog: offByName.get(name) || undefined,
      emphasize: ONSITE_EMPH.test(name) || undefined,
      onsite: true,
      settlement,
      checkoutState: "taken",
      returnState: "pending",
    };
  });

  // 시트가 발급한 실 scheduleId로 반영(같은 ID가 이미 있으면 교체)
  const ids = new Set(newItems.map((i) => i.scheduleId));
  mutateTrade(tradeId, (t) => ({
    ...t,
    equipments: [...t.equipments.filter((e) => !ids.has(e.scheduleId)), ...newItems],
    amount: amount ?? t.amount,
    contractUrl: url || t.contractUrl || null,
    contractRegenPending: !!mutationResult.contractRegenPending && !url,
  }));
  flashSave(tradeId);
}
export function setOnsiteSettlement(tradeId: string, scheduleId: string, settlement: Settlement) {
  mutateTrade(tradeId, (t) => mapItem(t, scheduleId, (e) => ({ ...e, settlement })));
  flashSave(tradeId);
}
export function removeItem(tradeId: string, scheduleId: string) {
  const item = state.trades.find((t) => t.tradeId === tradeId)?.equipments.find((e) => e.scheduleId === scheduleId);
  // 실 스케줄ID(tid-NN) 행은 스케줄상세에서도 삭제 — 가용성 점유·repair 부활 방지.
  // 시트에 기록된 현장추가도 실 ID라 포함됨. (레거시 앱 전용 ONS-N은 tid-ONS-N이라 매칭 안 돼 제외)
  if (item && isSheetBackedScheduleId(tradeId, scheduleId)) {
    if (writeBackEnabled) {
      removeEquipmentAndRegenerateContract(tradeId, item);
      return;
    }
    rejectSheetBackedRemovalWithoutWriteBack(tradeId);
    return;
  }
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
  const rcItem = state.trades.find((t) => t.tradeId === tradeId)?.equipments.find((e) => e.scheduleId === scheduleId);
  if (rcItem?.synthetic) return; // 합성 ID — 시트 write 금지
  if (writeback !== undefined) gasWrite("toggleItem", { scheduleId, phase: "checkin", done: writeback });
}

// ── 결제·정산 (개고생2.0 회계로 write-back 대상) ────────────────
export async function setPaymentMethod(tradeId: string, method: string) {
  mutateTrade(tradeId, (t) => ({ ...t, paymentMethod: method }));
  flashSave(tradeId);
  try {
    const res = await gasMutation("updatePayment", { tid: tradeId, method });
    const result = res?.result || res || {};
    const sideEffects = result.sideEffects;
    if (sideEffects?.applied) {
      mutateTrade(tradeId, (t) => ({
        ...t,
        proofType: sideEffects.columns.K || t.proofType,
        issueStatus: sideEffects.columns.L || t.issueStatus,
        depositStatus: sideEffects.columns.M || t.depositStatus,
        paymentWarning: sideEffects.columns.M ? /미|대기|예정/.test(sideEffects.columns.M) : t.paymentWarning,
      }));
    }
  } catch (err) {
    console.error("[write-back] 결제수단 저장 실패:", err);
  }
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
export async function requestProofIssue(tradeId: string) {
  mutateTrade(tradeId, (t) => ({ ...t, issueStatus: "발행요청", issueNote: "발행 요청 중..." }));
  flashSave(tradeId);
  try {
    const res = await gasMutation("updateTradeProof", { tid: tradeId, field: "issueStatus", value: "발행요청" });
    const result = res?.result || res || {};
    mutateTrade(tradeId, (t) => ({
      ...t,
      issueStatus: result.issueStatus || "발행완료",
      issueNote: result.message || result.error || t.issueNote,
    }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    mutateTrade(tradeId, (t) => ({ ...t, issueStatus: "전송실패", issueNote: message }));
    throw err;
  }
}
export async function setBillingCompany(tradeId: string, billingCompany: string) {
  mutateTrade(tradeId, (t) => ({ ...t, billingCompany }));
  flashSave(tradeId);
  try {
    const res = await gasMutation("updateBillingCompany", { tid: tradeId, billingCompany });
    const result = res?.result || res || {};
    if (Object.prototype.hasOwnProperty.call(result, "billingCompany")) {
      mutateTrade(tradeId, (t) => ({ ...t, billingCompany: result.billingCompany }));
    }
  } catch (err) {
    console.error("[write-back] 발행처 저장 실패:", err);
  }
}
export function sendEstimate(tradeId: string) {
  mutateTrade(tradeId, (t) => ({ ...t, estimateSent: true }));
  flashSave(tradeId);
  gasWrite("sendEstimate", { tid: tradeId });
}

export async function sendStatement(tradeId: string) {
  mutateTrade(tradeId, (t) => ({ ...t, issueNote: "거래명세서 발송 요청 중..." }));
  flashSave(tradeId);
  try {
    const res = await gasMutation("sendStatement", { tid: tradeId });
    const result = res?.result || res || {};
    mutateTrade(tradeId, (t) => ({
      ...t,
      statementSent: true,
      issueNote: result.message || "거래명세서 발송 접수 완료",
    }));
    flashSave(tradeId);
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    mutateTrade(tradeId, (t) => ({ ...t, issueNote: message }));
    flashSave(tradeId);
    throw err;
  }
}

export async function sendPayAppPaymentLink(tradeId: string) {
  mutateTrade(tradeId, (t) => ({ ...t, issueNote: "결제링크 발송 요청 중..." }));
  flashSave(tradeId);
  try {
    const res = await gasMutation("sendPayAppPaymentLink", { tid: tradeId });
    const result = res?.result || res || {};
    mutateTrade(tradeId, (t) => ({
      ...t,
      issueNote: result.message || "결제링크 발송 완료",
    }));
    flashSave(tradeId);
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    mutateTrade(tradeId, (t) => ({ ...t, issueNote: message }));
    flashSave(tradeId);
    throw err;
  }
}

export async function regenerateContract(tradeId: string) {
  mutateTrade(tradeId, (t) => ({ ...t, contractRegenPending: true }));
  flashSave(tradeId);
  try {
    const res = await gasMutation("regenerateContract", { tid: tradeId });
    const result = unwrapContractMutation(res);
    if (result.skipped) throw new Error("쓰기 백이 비활성화되어 계약서를 재생성하지 못했습니다");
    if (result.error) throw new Error(result.error);
    const url = contractUrlFromMutation(result);
    if (!url) throw new Error("새 계약서 URL이 응답에 없습니다");
    const amount = amountFromMutation(result);
    mutateTrade(tradeId, (t) => ({ ...t, contractUrl: url, amount: amount ?? t.amount, contractRegenPending: false }));
    flashSave(tradeId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    mutateTrade(tradeId, (t) => ({ ...t, contractUrl: null, contractRegenPending: false, issueNote: "계약서 재생성 실패: " + message }));
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

// ── 반출/반납 사진 ──────────────────────────────────────────────
function normalizePhotoPhase(value: unknown): Phase | "other" {
  const raw = String(value ?? "").trim().toLowerCase();
  if (raw === "checkout" || raw.includes("반출") || raw.includes("출고")) return "checkout";
  if (raw === "checkin" || raw.includes("반납") || raw.includes("입고") || raw.includes("회수")) return "checkin";
  return "other";
}

function photoLabel(phase: Phase | "other"): string {
  return phase === "checkout" ? "반출 사진" : phase === "checkin" ? "반납 사진" : "사진";
}

function photoSwatch(phase: Phase | "other"): string {
  return phase === "checkout" ? "#2d5be3" : phase === "checkin" ? "#0f8a61" : "#787774";
}

function photoKey(photo: PhotoMeta): string {
  return photo.fileId || photo.url || photo.thumbnailUrl || photo.id;
}

function normalizeGasPhoto(raw: unknown, fallbackPhase: Phase | "other", index: number): PhotoMeta {
  const src = (raw || {}) as Record<string, unknown>;
  const phase = normalizePhotoPhase(src.phase ?? fallbackPhase);
  const uploadedAt = String(src.uploadedAt ?? "");
  const fileId = String(src.fileId ?? "");
  const url = String(src.url ?? "");
  const thumbnailUrl = String(src.thumbnailUrl ?? "");
  const id = String(src.id ?? "") || fileId || url || thumbnailUrl || `${phase}-${uploadedAt || Date.now()}-${index}`;
  return {
    id,
    phase,
    swatch: String(src.swatch ?? photoSwatch(phase)),
    label: String(src.label ?? (uploadedAt ? `${photoLabel(phase)} ${uploadedAt}` : photoLabel(phase))),
    memo: src.memo != null ? String(src.memo) : undefined,
    url: url || undefined,
    thumbnailUrl: thumbnailUrl || undefined,
    fileId: fileId || undefined,
    sheetValue: src.sheetValue != null ? String(src.sheetValue) : undefined,
    uploadedAt: uploadedAt || undefined,
    row: typeof src.row === "number" ? src.row : undefined,
  };
}

function flattenGasPhotos(raw: unknown): PhotoMeta[] {
  if (Array.isArray(raw)) return raw.map((p, index) => normalizeGasPhoto(p, "other", index));
  const bucket = (raw || {}) as Record<string, unknown>;
  return (["checkout", "checkin", "other"] as const).flatMap((phase) => {
    const list = Array.isArray(bucket[phase]) ? (bucket[phase] as unknown[]) : [];
    return list.map((p, index) => normalizeGasPhoto(p, phase, index));
  });
}

function mergePhotos(existing: PhotoMeta[], incoming: PhotoMeta[]): PhotoMeta[] {
  const map = new Map<string, PhotoMeta>();
  for (const photo of existing) map.set(photoKey(photo), photo);
  for (const photo of incoming) map.set(photoKey(photo), { ...map.get(photoKey(photo)), ...photo });
  return Array.from(map.values());
}

const DASHBOARD_PHOTO_BATCH_DELAY_MS = 80;
const DASHBOARD_PHOTO_BATCH_SIZE = 35;
const loadedPhotoTrades = new Set<string>();
const loadingPhotoTrades = new Set<string>();
const queuedPhotoTrades = new Set<string>();
let photoBatchTimer: ReturnType<typeof setTimeout> | null = null;

function normalizeTradeIds(tradeIds: string[]): string[] {
  return Array.from(new Set(tradeIds.map((id) => String(id || "").trim()).filter(Boolean)));
}

function extractGasPhotoMap(res: any, tradeIds: string[]): Record<string, unknown> {
  const body = res?.result ?? res ?? {};
  if (body.photosByTrade && typeof body.photosByTrade === "object") return body.photosByTrade as Record<string, unknown>;
  if (tradeIds.length === 1) return { [tradeIds[0]]: body.photos ?? res?.photos };
  return {};
}

function mergeTradePhotosFromGas(photoMap: Map<string, PhotoMeta[]>): void {
  if (!photoMap.size) return;
  let changed = false;
  const trades = state.trades.map((t) => {
    const incoming = photoMap.get(t.tradeId);
    if (!incoming?.length) return t;
    changed = true;
    return { ...t, photos: mergePhotos(t.photos, incoming) };
  });
  if (!changed) return;
  if (!isSupabase) cache[state.date] = { trades, notes: state.notes };
  set({ trades });
}

async function loadTradePhotosBatch_(tradeIds: string[], force = false): Promise<void> {
  const ids = normalizeTradeIds(tradeIds).filter((id) => !loadingPhotoTrades.has(id) && (force || !loadedPhotoTrades.has(id)));
  if (!ids.length) return;

  ids.forEach((id) => loadingPhotoTrades.add(id));
  try {
    for (let i = 0; i < ids.length; i += DASHBOARD_PHOTO_BATCH_SIZE) {
      const batch = ids.slice(i, i + DASHBOARD_PHOTO_BATCH_SIZE);
      const res =
        batch.length === 1
          ? await gasRead("dashboardPhotos", { tid: batch[0] })
          : await gasRead("dashboardPhotosBatch", { tids: JSON.stringify(batch) });
      const rawMap = extractGasPhotoMap(res, batch);
      const photoMap = new Map<string, PhotoMeta[]>();
      for (const tradeId of batch) {
        loadedPhotoTrades.add(tradeId);
        photoMap.set(tradeId, flattenGasPhotos(rawMap[tradeId]));
      }
      mergeTradePhotosFromGas(photoMap);
    }
  } finally {
    ids.forEach((id) => loadingPhotoTrades.delete(id));
  }
}

export function ensureTradePhotos(tradeIds: string[]): void {
  for (const tradeId of normalizeTradeIds(tradeIds)) {
    if (loadedPhotoTrades.has(tradeId) || loadingPhotoTrades.has(tradeId)) continue;
    queuedPhotoTrades.add(tradeId);
  }
  if (!queuedPhotoTrades.size || photoBatchTimer) return;
  photoBatchTimer = setTimeout(() => {
    photoBatchTimer = null;
    const batch = Array.from(queuedPhotoTrades);
    queuedPhotoTrades.clear();
    void loadTradePhotosBatch_(batch).catch(() => {
      // 다음 카드 마운트나 상세 열기에서 다시 시도한다.
    });
  }, DASHBOARD_PHOTO_BATCH_DELAY_MS);
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("사진 파일 읽기 실패"));
    reader.readAsDataURL(file);
  });
}

const DASHBOARD_PHOTO_MAX_SIDE = 1600;
const DASHBOARD_PHOTO_JPEG_QUALITY = 0.82;
const DASHBOARD_PHOTO_MAX_DATA_URL_CHARS = 4_000_000;

type DashboardPhotoUploadPayload = {
  fileName: string;
  mimeType: string;
  data: string;
};

function loadDashboardPhotoImage_(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("사진을 압축할 수 없습니다"));
    img.src = dataUrl;
  });
}

async function prepareDashboardPhotoUpload_(file: File): Promise<DashboardPhotoUploadPayload> {
  if (!file.type.startsWith("image/")) {
    throw new Error("이미지 파일만 업로드할 수 있습니다");
  }

  const original = await readFileAsDataUrl(file);
  let img: HTMLImageElement;
  try {
    img = await loadDashboardPhotoImage_(original);
  } catch (error) {
    if (original.length <= DASHBOARD_PHOTO_MAX_DATA_URL_CHARS) {
      return {
        fileName: file.name || "photo.jpg",
        mimeType: file.type || "image/jpeg",
        data: original,
      };
    }
    throw error;
  }

  const width = img.naturalWidth || img.width;
  const height = img.naturalHeight || img.height;
  if (!width || !height) throw new Error("사진 크기를 확인할 수 없습니다");

  const attempts = [
    { maxSide: DASHBOARD_PHOTO_MAX_SIDE, quality: DASHBOARD_PHOTO_JPEG_QUALITY },
    { maxSide: 1280, quality: 0.78 },
    { maxSide: 1024, quality: 0.72 },
  ];
  const baseName = (file.name || "photo").replace(/\.[^.]+$/, "") || "photo";

  for (const { maxSide, quality } of attempts) {
    const scale = Math.min(1, maxSide / Math.max(width, height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("사진 압축을 시작할 수 없습니다");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const data = canvas.toDataURL("image/jpeg", quality);
    if (data.length <= DASHBOARD_PHOTO_MAX_DATA_URL_CHARS) {
      return {
        fileName: `${baseName}.jpg`,
        mimeType: "image/jpeg",
        data,
      };
    }
  }

  throw new Error("사진 용량이 너무 큽니다. 카메라 해상도를 낮추거나 다시 촬영해 주세요.");
}

export async function refreshTradePhotos(tradeId: string): Promise<void> {
  await loadTradePhotosBatch_([tradeId], true);
}

// 업로드 대기 타일의 미리보기(data URL)는 Supabase 저장/동기화에 실리지 않도록 메모리에만 둔다.
const localPhotoPreviews = new Map<string, string>();

export function getPhotoPreview(queueId: string | undefined): string | undefined {
  return queueId ? localPhotoPreviews.get(queueId) : undefined;
}

// 사진은 압축 즉시 화면에 반영하고, 실제 전송은 photoUploadQueue가 뒤에서 처리한다(실패 시 재시도).
export async function uploadTradePhoto(tradeId: string, phase: Phase, file: File): Promise<void> {
  if (!writeBackEnabled) throw new Error(writeBackDisabledReason);
  const upload = await prepareDashboardPhotoUpload_(file);
  const queueId = `pq-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  localPhotoPreviews.set(queueId, upload.data);
  const optimistic: PhotoMeta = {
    id: queueId,
    phase,
    swatch: photoSwatch(phase),
    label: `${photoLabel(phase)} 업로드 중`,
    status: "uploading",
    queueId,
  };
  mutateTrade(tradeId, (t) => ({ ...t, photos: mergePhotos(t.photos, [optimistic]) }));
  await enqueuePhotoUpload({
    queueId,
    tradeId,
    phase,
    fileName: upload.fileName,
    mimeType: upload.mimeType,
    data: upload.data,
    createdAt: Date.now(),
    attempts: 0,
  });
}

export function retryTradePhotoUpload(tradeId: string, queueId: string): void {
  mutateTrade(tradeId, (t) => ({
    ...t,
    photos: t.photos.map((p) => (p.queueId === queueId ? { ...p, status: "uploading" as const } : p)),
  }));
  retryPhotoUpload(queueId);
}

export function discardTradePhotoUpload(tradeId: string, queueId: string): void {
  localPhotoPreviews.delete(queueId);
  mutateTrade(tradeId, (t) => ({ ...t, photos: t.photos.filter((p) => p.queueId !== queueId) }));
  void discardPhotoUpload(queueId);
}

function sendQueuedPhoto_(job: PhotoUploadJob): Promise<unknown> {
  return gasMutation("uploadDashboardPhoto", {
    tid: job.tradeId,
    phase: job.phase,
    fileName: job.fileName,
    mimeType: job.mimeType,
    data: job.data,
    clientKey: job.queueId,
  }).then((res) => {
    if (res?.skipped) {
      throw Object.assign(new Error("사진 업로드 쓰기 경로가 비활성화되어 있습니다"), { permanent: true });
    }
    return res;
  });
}

if (typeof window !== "undefined") {
  configurePhotoUploadQueue({
    send: sendQueuedPhoto_,
    onSuccess: (job, res) => {
      localPhotoPreviews.delete(job.queueId);
      const raw = (res ?? {}) as { photo?: unknown; result?: { photo?: unknown } };
      const photo = normalizeGasPhoto(raw.photo || raw.result?.photo, job.phase, 0);
      mutateTrade(job.tradeId, (t) => ({
        ...t,
        photos: mergePhotos(t.photos.filter((p) => p.queueId !== job.queueId), [photo]),
      }));
      flashSave(job.tradeId);
    },
    onFailure: (job, message, willRetry) => {
      if (willRetry) return;
      mutateTrade(job.tradeId, (t) => ({
        ...t,
        photos: t.photos.map((p) =>
          p.queueId === job.queueId ? { ...p, status: "failed" as const, memo: message } : p
        ),
      }));
    },
  });
  void resumePhotoUploads();
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
