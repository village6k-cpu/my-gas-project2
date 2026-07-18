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
import { isCheckoutBaselineLocked, returnCompletionBlockers, type ReturnCompletionBlocker } from "../domain/status";
import {
  activeWindowStartYmd,
  cancelTradeRemote,
  deleteScheduleItem,
  fetchAllTrades,
  fetchNotes,
  fetchSetupCompletion,
  fetchTradesByIds,
  fetchTradesOverlappingDate,
  persistNotes,
  persistReturnCounts,
  persistTrade,
  searchTradesRemote,
  subscribeChanges,
  type RemoteChange,
} from "./remote";
import { gasMutation, gasRead, gasWrite, isGasOutcomeUnknownError, setGasWriteFailureHandler, writeBackDisabledReason, writeBackEnabled } from "./writeback";
import {
  configurePhotoUploadQueue,
  discardPhotoUpload,
  enqueuePhotoUpload,
  resumePhotoUploads,
  retryPhotoUpload,
  type PhotoUploadJob,
} from "./photoUploadQueue";
import { pollTimelineChanges, repairDashboardDateDetails, repairDashboardDetailsForIncompleteTrades, repairDashboardSearchResults, resetRepairBackoff, shouldPruneMissingSheetBacked } from "./sync";

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

// 거래 완전 삭제 후 즉시 화면에서 제거(낙관적). 서버(GAS+Supabase)에서 이미 지운 뒤 호출.
export function removeTradeLocally(tradeId: string) {
  set({ trades: state.trades.filter((t) => t.tradeId !== tradeId) });
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
let remoteLoadPromise: Promise<void> | null = null;
let subscribed = false;
const persistTimers: Record<string, ReturnType<typeof setTimeout>> = {};
const persistGenerations: Record<string, number> = {};
const persistInFlight: Record<string, Promise<Trade> | undefined> = {};
const pendingPersistTrades = new Set<string>();
const setupOutcomeRetryTimers: Record<string, number | undefined> = {};
const returnCountPersistTimers: Record<string, ReturnType<typeof setTimeout> | undefined> = {};
const returnCountPersistInFlight: Record<string, Promise<Trade> | undefined> = {};
const pendingReturnCountTrades = new Set<string>();
let notesTimer: ReturnType<typeof setTimeout> | null = null;
let notesPersistGeneration = 0;
let notesPersistPending = false;
let pollTimer: ReturnType<typeof setInterval> | null = null;
const POLL_MS = 90_000;
let pollCount = 0;
let pollInFlight = false;
let lastPollAt = 0;
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
  return (
    pendingPersistTrades.size > 0 ||
    pendingReturnCountTrades.size > 0 ||
    notesPersistPending ||
    Object.keys(state.savingTrades).length > 0
  );
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

async function repairDayDetails(date: string, mutationSeqAtStart = localMutationSeq, opts?: { fresh?: boolean }): Promise<boolean> {
  if (!isSupabase || hasPendingPersist()) return false;
  const changed = await repairDashboardDateDetails(state.trades, date, opts);
  return applyDashboardRepairs(changed, mutationSeqAtStart);
}

export async function repairSearchResults(query: string): Promise<void> {
  if (!isSupabase || hasPendingPersist()) return;
  const q = query.trim();
  if (q.length < 2) return;
  const mutationSeqAtSearch = localMutationSeq;
  // 운영 윈도우 밖 과거 거래도 검색되도록 Supabase에서 지연 로드(원장 검색 복구와 병렬)
  const [changed, remoteMatches] = await Promise.all([
    repairDashboardSearchResults(state.trades, q),
    searchTradesRemote(q).catch(() => [] as Trade[]),
  ]);
  if (remoteMatches.length && canApplyRemoteSnapshot(mutationSeqAtSearch)) {
    const known = new Set(state.trades.map((t) => t.tradeId));
    const fresh = remoteMatches.filter((t) => !known.has(t.tradeId));
    if (fresh.length) {
      fresh.forEach((t) => extraTradeIds.add(t.tradeId));
      set({ trades: [...state.trades, ...fresh] });
    }
  }
  await applyDashboardRepairs(changed, mutationSeqAtSearch);
}

// ── realtime 변경 반영: 전량 refetch 대신 바뀐 거래만 재조회 ──────
// 예전엔 어떤 행 1개가 바뀌어도(자기 쓰기 에코 포함) 전 테이블을 다시 내려받았다.
// 거래가 쌓일수록 이벤트당 비용이 선형 증가 → "점점 느려짐"의 직접 원인.
const realtimeTradeIds = new Set<string>();
let realtimeNotesChanged = false;
let realtimeNeedsFullResync = false;
let realtimeFlushTimer: ReturnType<typeof setTimeout> | null = null;
let realtimeFlushInFlight = false;
const REALTIME_FLUSH_MS = 500;
const REALTIME_RETRY_MS = 1_500;
const REALTIME_FULL_RESYNC_THRESHOLD = 40; // 대량 변경(수동 전체 동기화 등)은 전량 수렴이 더 싸다

// 검색/과거 날짜 진입으로 지연 로드한 윈도우 밖 거래 — 전량 수렴 시 유실되지 않게 보존한다.
const extraTradeIds = new Set<string>();

function noteRemoteChange(change: RemoteChange) {
  if (change.table === "handover_notes") realtimeNotesChanged = true;
  else if (change.tradeId) realtimeTradeIds.add(change.tradeId);
  else realtimeNeedsFullResync = true; // trade_id를 복원할 수 없는 이벤트는 전체 수렴으로
  scheduleRealtimeFlush(REALTIME_FLUSH_MS);
}

function scheduleRealtimeFlush(delay: number) {
  if (realtimeFlushTimer) clearTimeout(realtimeFlushTimer);
  realtimeFlushTimer = setTimeout(() => {
    realtimeFlushTimer = null;
    void flushRealtimeChanges();
  }, delay);
}

/** persist 완료 지점에서 호출 — pending 때문에 이월된 realtime 변경을 마저 반영한다. */
function maybeResumeRealtimeFlush() {
  if (!realtimeTradeIds.size && !realtimeNotesChanged && !realtimeNeedsFullResync) return;
  if (hasPendingPersist()) return;
  scheduleRealtimeFlush(REALTIME_FLUSH_MS);
}

function requeueRealtimeChanges(ids: string[], notesChanged: boolean, fullResync: boolean) {
  ids.forEach((id) => realtimeTradeIds.add(id));
  if (notesChanged) realtimeNotesChanged = true;
  if (fullResync) realtimeNeedsFullResync = true;
}

async function flushRealtimeChanges(): Promise<void> {
  if (realtimeFlushInFlight) return;
  if (!realtimeTradeIds.size && !realtimeNotesChanged && !realtimeNeedsFullResync) return;
  // 숨김 탭에서는 반영을 미룬다 — visibilitychange에서 재개(변경 큐는 유지되므로 유실 없음).
  if (typeof document !== "undefined" && document.hidden) return;
  // pending 중에는 드롭하지 않고 이월한다(예전엔 조용히 버려 타 기기 변경이 무기한 유실).
  if (hasPendingPersist()) {
    scheduleRealtimeFlush(REALTIME_RETRY_MS);
    return;
  }
  const mutationSeqAtFlush = localMutationSeq;
  const ids = [...realtimeTradeIds];
  realtimeTradeIds.clear();
  const notesChanged = realtimeNotesChanged;
  realtimeNotesChanged = false;
  const fullResync = realtimeNeedsFullResync || ids.length > REALTIME_FULL_RESYNC_THRESHOLD;
  realtimeNeedsFullResync = false;

  realtimeFlushInFlight = true;
  try {
    if (fullResync) {
      const [trades, notes] = await Promise.all([fetchAllTrades(), fetchNotes()]);
      if (!canApplyRemoteSnapshot(mutationSeqAtFlush)) {
        requeueRealtimeChanges(ids, notesChanged, true);
        scheduleRealtimeFlush(REALTIME_RETRY_MS);
        return;
      }
      const freshIds = new Set(trades.map((t) => t.tradeId));
      // 지연 로드된 윈도우 밖 거래는 스냅샷에 없어도 유지
      const carried = state.trades.filter((t) => extraTradeIds.has(t.tradeId) && !freshIds.has(t.tradeId));
      const mergedTrades = preservePhotosInSnapshot([...trades, ...carried]);
      set({ trades: mergedTrades, notes });
      await repairEmptyEquipmentTrades(mergedTrades, mutationSeqAtFlush);
      return;
    }
    const [changed, notes] = await Promise.all([
      ids.length ? fetchTradesByIds(ids) : Promise.resolve([]),
      notesChanged ? fetchNotes() : Promise.resolve(null),
    ]);
    if (!canApplyRemoteSnapshot(mutationSeqAtFlush)) {
      requeueRealtimeChanges(ids, notesChanged, false);
      scheduleRealtimeFlush(REALTIME_RETRY_MS);
      return;
    }
    const foundIds = new Set(changed.map((t) => t.tradeId));
    const deletedIds = new Set(ids.filter((id) => !foundIds.has(id)));
    let trades = mergeTradeChanges(state.trades, changed);
    if (deletedIds.size) trades = trades.filter((t) => !deletedIds.has(t.tradeId));
    set(notes ? { trades, notes } : { trades });
  } catch {
    requeueRealtimeChanges(ids, notesChanged, fullResync);
    scheduleRealtimeFlush(REALTIME_RETRY_MS);
  } finally {
    realtimeFlushInFlight = false;
  }
}

async function loadRemoteOnce(): Promise<void> {
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
    subscribeChanges(noteRemoteChange, () => {
      // realtime 재연결 — 끊긴 동안의 이벤트 유실 가능성은 전체 수렴으로 복구
      realtimeNeedsFullResync = true;
      scheduleRealtimeFlush(REALTIME_FLUSH_MS);
    });
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) return;
      // 숨김 중 쌓인 realtime 변경 즉시 반영 + 오래 자리 비웠으면 시트 변경도 당겨온다
      scheduleRealtimeFlush(0);
      if (Date.now() - lastPollAt > POLL_MS) void pollSheetChangesNow({ mode: "light", resetBackoff: false });
    });
  }
  // 시트→앱 자동 폴링(변경분만): 90초마다 timeline에서 예약 변경 감지.
  // 평소엔 좁은 윈도우(-7~+45일)로 가볍게, 4회에 1번(6분)만 전체 윈도우로 수렴한다.
  if (!pollTimer) {
    pollTimer = setInterval(() => {
      if (document.hidden) return;
      pollCount++;
      void pollSheetChangesNow({ mode: pollCount % 4 === 0 ? "full" : "light", resetBackoff: false });
    }, POLL_MS);
  }
}

function loadRemote(): Promise<void> {
  if (remoteLoadPromise) return remoteLoadPromise;
  const task = loadRemoteOnce();
  remoteLoadPromise = task;
  const clear = () => {
    if (remoteLoadPromise === task) remoteLoadPromise = null;
  };
  void task.then(clear, clear);
  return task;
}

/**
 * 시트 변경분 즉시 반영 — 등록/수정 직후 90초 폴링을 기다리지 않고 호출.
 * (확인요청 등록 완료 시 신규 거래가 오늘일정·검색에 바로 보이도록)
 * 기본값(mode:"full", resetBackoff:true)은 명시적 호출용 — 백그라운드 인터벌은
 * light 모드(좁은 timeline 윈도우 + 캐시 허용 읽기)로 GAS 부하를 줄인다.
 */
export async function pollSheetChangesNow(opts?: { mode?: "light" | "full"; resetBackoff?: boolean }): Promise<void> {
  if (!isSupabase || pollInFlight || hasPendingPersist()) return;
  const mode = opts?.mode ?? "full";
  if (opts?.resetBackoff ?? true) resetRepairBackoff();
  const mutationSeqAtPoll = localMutationSeq;
  pollInFlight = true;
  try {
    if (await repairEmptyEquipmentTrades(state.trades, mutationSeqAtPoll)) return;
    if (state.date && await repairDayDetails(state.date, mutationSeqAtPoll, { fresh: mode === "full" })) return;
    const changed = await pollTimelineChanges(
      state.trades,
      mode === "light" ? { fromDays: -7, toDays: 45 } : undefined,
    );
    if (!changed.length) return;
    if (!canApplyRemoteSnapshot(mutationSeqAtPoll)) return;
    set({ trades: mergeTradeChanges(state.trades, changed) });
    for (const t of changed) persistTrade(t).catch(() => {});
  } catch {
    /* noop */
  } finally {
    pollInFlight = false;
    lastPollAt = Date.now();
  }
}

/** 같은 거래의 전체행 upsert를 직렬화해 오래된 요청이 최신 상태 뒤에 끝나는 일을 막는다. */
function enqueueTradePersist(tradeId: string, fallback: Trade): Promise<Trade> {
  const previous = persistInFlight[tradeId];
  const task = (previous ?? Promise.resolve(fallback))
    .catch(() => fallback)
    .then(async () => {
      const latest = state.trades.find((t) => t.tradeId === tradeId) ?? fallback;
      await persistTrade(latest);
      return latest;
    });
  persistInFlight[tradeId] = task;
  const clear = () => {
    if (persistInFlight[tradeId] === task) delete persistInFlight[tradeId];
  };
  void task.then(clear, clear);
  return task;
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
      await enqueueTradePersist(tradeId, latest);
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
      maybeResumeRealtimeFlush();
    }
  }, 450);
}

/** 대기 timer를 취소하고 이미 시작된 저장 뒤에 최신 스냅샷을 즉시 내구 저장한다. */
async function flushTradePersist(tradeId: string): Promise<Trade> {
  const fallback = state.trades.find((t) => t.tradeId === tradeId);
  if (!fallback) throw new Error("저장할 거래를 찾을 수 없습니다");
  if (!isSupabase) return fallback;

  const generation = (persistGenerations[tradeId] ?? 0) + 1;
  persistGenerations[tradeId] = generation;
  pendingPersistTrades.add(tradeId);
  if (persistTimers[tradeId]) clearTimeout(persistTimers[tradeId]);
  delete persistTimers[tradeId];
  try {
    return await enqueueTradePersist(tradeId, fallback);
  } finally {
    if (persistGenerations[tradeId] === generation) {
      delete persistGenerations[tradeId];
      delete persistTimers[tradeId];
      pendingPersistTrades.delete(tradeId);
    }
    maybeResumeRealtimeFlush();
  }
}

/** 반납 수량 JSON만 거래 단위로 직렬 저장한다. 연속 체크 중에는 최신 스냅샷만 보낸다. */
function enqueueReturnCountsPersist(tradeId: string): Promise<Trade> {
  const fallback = state.trades.find((t) => t.tradeId === tradeId);
  if (!fallback) return Promise.reject(new Error("반납 수량을 저장할 거래를 찾을 수 없습니다"));
  const previous = persistInFlight[tradeId];
  const task = (previous ?? Promise.resolve(fallback))
    .catch(() => fallback)
    .then(async () => {
      const latest = state.trades.find((t) => t.tradeId === tradeId) ?? fallback;
      await persistReturnCounts(tradeId, latest.returnCounts ?? {});
      return latest;
    });
  persistInFlight[tradeId] = task;
  returnCountPersistInFlight[tradeId] = task;
  const clear = () => {
    if (persistInFlight[tradeId] === task) delete persistInFlight[tradeId];
    if (returnCountPersistInFlight[tradeId] === task) delete returnCountPersistInFlight[tradeId];
    if (!returnCountPersistTimers[tradeId] && !returnCountPersistInFlight[tradeId]) pendingReturnCountTrades.delete(tradeId);
    maybeResumeRealtimeFlush();
  };
  void task.then(clear, clear);
  return task;
}

function scheduleReturnCountsPersist(tradeId: string): void {
  pendingReturnCountTrades.add(tradeId);
  if (returnCountPersistTimers[tradeId]) clearTimeout(returnCountPersistTimers[tradeId]);
  returnCountPersistTimers[tradeId] = setTimeout(() => {
    delete returnCountPersistTimers[tradeId];
    void enqueueReturnCountsPersist(tradeId).catch((error) => {
      console.error("[supabase] 반납 수량 저장 실패", error);
      set({ toast: { id: ++toastSeq, text: "⚠️ 반납 수량 저장 실패 — 네트워크를 확인하고 다시 시도해주세요", kind: "error" } });
    });
  }, 120);
}

async function flushReturnCountsPersist(tradeId: string): Promise<Trade> {
  pendingReturnCountTrades.add(tradeId);
  if (returnCountPersistTimers[tradeId]) clearTimeout(returnCountPersistTimers[tradeId]);
  delete returnCountPersistTimers[tradeId];
  try {
    return await enqueueReturnCountsPersist(tradeId);
  } finally {
    if (!returnCountPersistTimers[tradeId] && !returnCountPersistInFlight[tradeId]) pendingReturnCountTrades.delete(tradeId);
  }
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
      maybeResumeRealtimeFlush();
    }
  }, 600);
}

// 운영 윈도우(60일) 밖 과거 날짜로 이동하면 그 날짜와 겹치는 거래만 Supabase에서 지연 로드한다.
const coveredOldDates = new Set<string>();
async function ensureDateCoverage(date: string): Promise<void> {
  if (date >= activeWindowStartYmd() || coveredOldDates.has(date)) return;
  coveredOldDates.add(date);
  try {
    const trades = await fetchTradesOverlappingDate(date);
    if (!trades.length) return;
    const known = new Set(state.trades.map((t) => t.tradeId));
    const fresh = trades.filter((t) => !known.has(t.tradeId));
    if (!fresh.length) return;
    fresh.forEach((t) => extraTradeIds.add(t.tradeId));
    set({ trades: [...state.trades, ...fresh] });
  } catch {
    coveredOldDates.delete(date); // 실패 시 다음 진입에서 재시도
  }
}

export function loadDay(date: string) {
  if (isSupabase) {
    if (state.date !== date) set({ date });
    if (!remoteLoaded) loadRemote();
    else {
      void ensureDateCoverage(date);
      repairDayDetails(date);
    }
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

function showTransientError(text: string, duration = 4_000) {
  const id = ++toastSeq;
  set({ toast: { id, text, kind: "error" } });
  if (typeof window === "undefined") return;
  window.setTimeout(() => {
    if (state.toast?.id === id) set({ toast: null });
  }, duration);
}

export function clearToast() {
  if (state.toast) set({ toast: null });
}

/** 원장 확정이 필요한 작업은 완료 전까지 저장 중 상태를 유지한다. */
function beginTradeSave(tradeId: string): number {
  const id = ++toastSeq;
  set({ savingTrades: { ...state.savingTrades, [tradeId]: true }, toast: { id, text: "저장 중…", kind: "saving" } });
  return id;
}

function finishTradeSave(tradeId: string, id: number, kind: "saved" | "error", text: string) {
  const saving = { ...state.savingTrades };
  delete saving[tradeId];
  set({ savingTrades: saving, toast: { id, text, kind } });
  maybeResumeRealtimeFlush();
  if (typeof window === "undefined") return;
  window.setTimeout(() => {
    if (state.toast?.id === id) set({ toast: null });
  }, kind === "error" ? 4_000 : 1_100);
}

/** 응답만 유실된 쓰기는 실패로 단정하지 않고 같은 목표 상태를 멱등 재시도한다.
 *  단, 무한 재시도는 savingTrades 락을 계속 쥐어 앱 전체 동기화를 막으므로
 *  상한(약 1.5분) 후 서버 확정값으로 수렴하고 락을 푼다. */
const SETUP_OUTCOME_MAX_ATTEMPTS = 12;

function queueSetupOutcomeRetry(
  tradeId: string,
  done: boolean,
  optimisticDoneAt: string | null,
  saveId: number,
  attempt = 1,
): void {
  if (typeof window === "undefined") return;
  if (setupOutcomeRetryTimers[tradeId]) window.clearTimeout(setupOutcomeRetryTimers[tradeId]);
  const delay = Math.min(800 * (2 ** (attempt - 1)), 10_000);
  setupOutcomeRetryTimers[tradeId] = window.setTimeout(async () => {
    delete setupOutcomeRetryTimers[tradeId];
    try {
      const res = await gasMutation("toggleSetup", { tid: tradeId, done });
      const doneAt = done ? String(res?.setupDoneAt || res?.doneAt || optimisticDoneAt) : null;
      mutateTrade(tradeId, (t) => ({ ...t, setupDone: done, setupDoneAt: doneAt }), false);
      finishTradeSave(tradeId, saveId, "saved", "저장됨");
    } catch (error) {
      // 최초 요청의 응답을 잃은 뒤에는 재시도 오류만으로 최초 미커밋을 증명할 수 없다.
      // Supabase 권한 필드가 목표값이면 완료하고, 아니면 같은 멱등 요청을 계속 재확인한다.
      try {
        const confirmed = await fetchSetupCompletion(tradeId);
        if (confirmed.done === done) {
          mutateTrade(tradeId, (t) => ({ ...t, setupDone: done, setupDoneAt: confirmed.doneAt }), false);
          finishTradeSave(tradeId, saveId, "saved", "저장됨");
          return;
        }
        if (attempt >= SETUP_OUTCOME_MAX_ATTEMPTS) {
          // 원장이 끝내 목표값을 확정하지 않음 — 서버 확정값으로 되돌리고 재시도 가능하게 락 해제
          mutateTrade(tradeId, (t) => ({ ...t, setupDone: confirmed.done, setupDoneAt: confirmed.doneAt }), false);
          finishTradeSave(tradeId, saveId, "error", "⚠️ 반출완료가 원장에 확정되지 않았습니다 — 다시 시도해주세요");
          return;
        }
      } catch (confirmError) {
        console.error("[supabase] 반출완료 결과 재확인 실패:", confirmError);
        if (attempt >= SETUP_OUTCOME_MAX_ATTEMPTS) {
          // 확인조차 불가(장기 오프라인 등) — 락만 풀고 표시 상태는 유지, 다음 폴링이 수렴시킨다
          finishTradeSave(tradeId, saveId, "error", "⚠️ 반출완료 결과를 확인하지 못했습니다 — 네트워크 확인 후 화면을 새로고침해주세요");
          return;
        }
      }
      console.error("[write-back] 반출완료 결과 미확정 재시도:", error);
      queueSetupOutcomeRetry(tradeId, done, optimisticDoneAt, saveId, attempt + 1);
    }
  }, delay);
}

function mutateTrade(tradeId: string, fn: (t: Trade) => Trade, persist = true) {
  markLocalMutation();
  let changed: Trade | undefined;
  const trades = state.trades.map((t) => (t.tradeId === tradeId ? (changed = fn(t)) : t));
  if (!isSupabase) cache[state.date] = { trades, notes: state.notes };
  set({ trades });
  if (changed && persist) schedulePersistTrade(changed);
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

  // 계약서 재생성은 백그라운드 워커(디바운스)에 맡긴다 — 인라인 재생성은 GAS 잠금을
  // 수 초~수십 초 쥐어 다른 체크/버튼을 실패시키고 제외 응답 자체도 느리게 했다.
  // 새 링크는 contractRegenPending 배지 → 폴링 merge로 곧 반영된다.
  gasMutation("removeEquip", {
    tid: tradeId,
    scheduleId,
    equipName: item.name,
    directRegenerate: false,
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
export type ToggleSetupResult = { ok: true; warning?: string } | { ok: false; error: string };

export type TradeDetailsInput = {
  customerName: string;
  customerPhone: string;
  company: string;
  checkoutDate: string;
  checkoutTime: string;
  returnDate: string;
  returnTime: string;
};

/** 고객정보와 예약 일시는 GAS 원장을 먼저 확정한 뒤 앱/Supabase에 반영한다. */
export async function updateTradeDetails(tradeId: string, input: TradeDetailsInput): Promise<{ ok: true } | { ok: false; error: string }> {
  if (isSupabase && !writeBackEnabled) {
    return { ok: false, error: `예약 편집 실패: ${writeBackDisabledReason}` };
  }
  const saveId = beginTradeSave(tradeId);
  try {
    const res = await gasMutationRetrying("updateTrade", { tid: tradeId, ...input });
    if (res?.skipped) throw new Error(writeBackDisabledReason);
    mutateTrade(tradeId, (trade) => ({
      ...trade,
      customerName: String(res?.customerName || input.customerName).trim(),
      customerPhone: String(res?.customerPhone ?? input.customerPhone).trim(),
      company: String(res?.company ?? input.company).trim(),
      checkoutAt: String(res?.checkoutAt || `${input.checkoutDate}T${input.checkoutTime}:00+09:00`),
      returnAt: String(res?.returnAt || `${input.returnDate}T${input.returnTime}:00+09:00`),
      contractUrl: String(res?.contractUrl || trade.contractUrl || "") || null,
      amount: numberFromMutation(res?.finalAmount) ?? trade.amount,
      contractRegenPending: !!res?.contractRegenPending,
    }));
    if (isSupabase) await flushTradePersist(tradeId);
    finishTradeSave(tradeId, saveId, "saved", "예약 수정 완료");
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    finishTradeSave(tradeId, saveId, "error", `⚠️ 예약 편집 실패 — ${message}`);
    return { ok: false, error: message };
  }
}

/** 취소는 거래 이력을 남기고 스케줄 점유만 제거한다. */
export async function cancelTrade(tradeId: string): Promise<{ ok: true; warning?: string } | { ok: false; error: string }> {
  if (isSupabase && !writeBackEnabled) {
    return { ok: false, error: `예약 취소 실패: ${writeBackDisabledReason}` };
  }
  const saveId = beginTradeSave(tradeId);
  try {
    const res = await gasMutationRetrying("updateContractStatus", { tid: tradeId, status: "취소" });
    if (res?.skipped) throw new Error(writeBackDisabledReason);
    let warning = "";
    if (isSupabase) {
      try {
        await cancelTradeRemote(tradeId);
      } catch (remoteError) {
        warning = "원장 취소는 완료됐지만 앱 일정 정리는 재시도 중입니다";
        console.error("[cancel] Supabase 취소 동기화 실패:", remoteError);
      }
    }
    mutateTrade(tradeId, (trade) => ({
      ...trade,
      contractStatus: "취소",
      contractUrl: null,
      contractRegenPending: false,
      returnDone: false,
      returnDoneAt: null,
      equipments: [],
    }));
    if (isSupabase) await flushTradePersist(tradeId);
    finishTradeSave(tradeId, saveId, warning ? "error" : "saved", warning ? `⚠️ ${warning}` : "예약 취소 완료");
    return warning ? { ok: true, warning } : { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    finishTradeSave(tradeId, saveId, "error", `⚠️ 예약 취소 실패 — ${message}`);
    return { ok: false, error: message };
  }
}

export async function toggleSetup(tradeId: string): Promise<ToggleSetupResult> {
  if (state.savingTrades[tradeId]) {
    const error = "반출 상태 변경이 이미 진행 중입니다";
    return { ok: false, error };
  }
  const current = state.trades.find((t) => t.tradeId === tradeId);
  if (!current) return { ok: false, error: "거래를 찾을 수 없습니다" };
  const done = !current.setupDone;
  const previousDone = current.setupDone;
  const previousDoneAt = current.setupDoneAt ?? null;
  if (isSupabase && !writeBackEnabled) {
    const error = `반출 상태 변경 실패: ${writeBackDisabledReason}`;
    set({ toast: { id: ++toastSeq, text: `⚠️ ${error}`, kind: "error" } });
    return { ok: false, error };
  }

  const saveId = beginTradeSave(tradeId);
  const optimisticDoneAt = done ? new Date().toISOString() : null;
  // 버튼은 즉시 완료 상태로 바꾼다. persist=false라 GAS 기준선보다 먼저 원격 저장되지는 않는다.
  mutateTrade(tradeId, (t) => ({ ...t, setupDone: done, setupDoneAt: optimisticDoneAt }), false);
  try {
    // 화면은 즉시 반응하지만, 내구 상태는 GAS가 기준선과 Supabase 완료값을 함께 확정한다.
    const res = await gasMutation("toggleSetup", { tid: tradeId, done });
    const doneAt = done ? String(res?.setupDoneAt || res?.doneAt || optimisticDoneAt) : null;
    mutateTrade(tradeId, (t) => ({ ...t, setupDone: done, setupDoneAt: doneAt }), false);
    finishTradeSave(tradeId, saveId, "saved", "저장됨");
    return { ok: true };
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    console.error("[write-back] toggleSetup 실패:", e);
    if (isGasOutcomeUnknownError(e)) {
      // GAS가 저장을 끝낸 뒤 응답만 40초 제한에 걸릴 수 있다. 결과 미확정은 완료 표시와
      // 저장 중 보호를 유지한 채 같은 목표 상태를 재시도하고, 절대 즉시 롤백하지 않는다.
      const warning = `반출완료는 표시됐고 서버 응답을 다시 확인 중입니다 — ${detail}`;
      set({ toast: { id: saveId, text: `⚠️ ${warning}`, kind: "saving" } });
      queueSetupOutcomeRetry(tradeId, done, optimisticDoneAt, saveId);
      return { ok: true, warning };
    }
    // GAS는 기준선과 Supabase 완료값을 모두 저장해야 성공을 반환하므로, 실패 때만 되돌린다.
    mutateTrade(tradeId, (t) => ({ ...t, setupDone: previousDone, setupDoneAt: previousDoneAt }), false);
    finishTradeSave(tradeId, saveId, "error", `⚠️ 반출 상태 변경 실패 — ${detail}`);
    return { ok: false, error: detail };
  }
}
export type ToggleReturnResult =
  | { ok: true; blockers: [] }
  | { ok: false; blockers: ReturnCompletionBlocker[]; error: string };

export async function toggleReturn(tradeId: string): Promise<ToggleReturnResult> {
  if (state.savingTrades[tradeId]) {
    return { ok: false, blockers: [], error: "반납 상태 변경이 이미 진행 중입니다" };
  }
  const current = state.trades.find((t) => t.tradeId === tradeId);
  if (!current) return { ok: false, blockers: [], error: "거래를 찾을 수 없습니다" };

  const on = !current.returnDone;
  const blockers = on ? returnCompletionBlockers(current) : [];
  if (blockers.length > 0) {
    const missing = blockers.reduce((sum, b) => sum + b.missing, 0);
    const over = blockers.reduce((sum, b) => sum + b.over, 0);
    const detail = missing > 0 ? `미확인 ${missing}개` : `초과 ${over}개`;
    const error = `반납완료 차단 — ${detail}. 품목별 수량을 확인해주세요.`;
    set({ toast: { id: ++toastSeq, text: `⚠️ ${error}`, kind: "error" } });
    return { ok: false, blockers, error };
  }

  // 실데이터에서는 원장(GAS)이 먼저 성공해야 앱/Supabase도 완료 상태로 바꾼다.
  // 원장 쓰기가 꺼져 있을 때 로컬만 닫히는 조용한 불일치를 만들지 않는다.
  if (isSupabase && !writeBackEnabled) {
    const error = `반납 상태 변경 실패: ${writeBackDisabledReason}`;
    set({ toast: { id: ++toastSeq, text: `⚠️ ${error}`, kind: "error" } });
    return { ok: false, blockers: [], error };
  }

  // 잠금 경합 재시도 동안 저장 중 스피너를 유지하고 중복 탭을 막는다.
  const saveId = beginTradeSave(tradeId);
  try {
    // 품목별 정상/파손/분실 상세가 먼저 내구 저장되어야 한다. 이것이 실패한 상태에서
    // 거래를 닫으면 GAS의 이진 체크만 남아 상세 사실이 사라질 수 있으므로 완료를 막는다.
    if (on && isSupabase) {
      const persisted = await flushReturnCountsPersist(tradeId);
      const refreshedBlockers = returnCompletionBlockers(persisted);
      if (refreshedBlockers.length > 0) {
        const missing = refreshedBlockers.reduce((sum, b) => sum + b.missing, 0);
        const over = refreshedBlockers.reduce((sum, b) => sum + b.over, 0);
        const detail = missing > 0 ? `미확인 ${missing}개` : `초과 ${over}개`;
        const error = `반납완료 차단 — ${detail}. 품목별 수량을 다시 확인해주세요.`;
        finishTradeSave(tradeId, saveId, "error", `⚠️ ${error}`);
        return { ok: false, blockers: refreshedBlockers, error };
      }
    }
    // 계약서 재생성 워커 등과의 잠금 경합은 짧은 재시도로 흡수한다(확정 거절은 즉시 실패).
    const res = await gasMutationRetrying("toggleReturn", { tid: tradeId, done: on });
    const restored = !on && res?.contractStatus ? res.contractStatus : "반출";
    mutateTrade(tradeId, (t) => ({
      ...t,
      returnDone: on,
      returnDoneAt: on ? new Date().toISOString() : null,
      contractStatus: on ? "반납완료" : restored,
    }));
    // GAS 완료 뒤의 최종 상태도 앞선 모든 저장 뒤에 즉시 직렬 저장한다.
    // 실패하면 성공으로 가장하지 않고 작업자에게 불일치를 드러낸다.
    if (isSupabase) await flushTradePersist(tradeId);
    finishTradeSave(tradeId, saveId, "saved", on ? "반납완료 저장됨" : "저장됨");
    return { ok: true, blockers: [] };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.error("[write-back] toggleReturn 실패:", e);
    finishTradeSave(tradeId, saveId, "error", `⚠️ 반납 상태 변경 실패 — ${error}`);
    return { ok: false, blockers: [], error };
  }
}

// ── 품목 체크 원장 쓰기 신뢰화 ──────────────────────────────────
// toggleItem은 파이어-앤-포겟이라 제외/현장추가(계약서 재생성)의 긴 GAS 잠금과 겹치면
// Lock timeout으로 죽고, 재시도가 없어 시트가 앱과 조용히 어긋났다.
// 품목 단위 목표 상태(최신 승자)로 직렬화하고 일시 오류만 백오프 재시도한다.
const ITEM_CHECK_RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 30_000];
const itemCheckTargets: Record<string, boolean | undefined> = {};
const itemCheckInFlight: Record<string, Promise<void> | undefined> = {};
const itemCheckRetryTimers: Record<string, ReturnType<typeof setTimeout> | undefined> = {};
const itemCheckAttempts: Record<string, number> = {};

/** 잠금 경합·네트워크 순단처럼 다시 보내면 성공할 오류만 재시도한다.
 *  기준선 차단/행 없음 같은 확정 거절은 즉시 사용자에게 알린다. */
function isRetryableLedgerError(error: unknown): boolean {
  if (isGasOutcomeUnknownError(error)) return true; // 네트워크/5xx/타임아웃
  const message = error instanceof Error ? error.message : String(error);
  return /lock|잠시 후 다시|처리 중/i.test(message);
}

/** 사용자 대기형 변이(반납완료·취소·예약편집)의 잠금 경합 흡수 —
 *  저장 스피너를 유지한 채 잠깐 물러났다 재시도한다. 확정 거절은 즉시 던진다. */
async function gasMutationRetrying(
  action: string,
  params: Record<string, string | number | boolean>,
  delays: number[] = [2_000, 5_000],
): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await gasMutation(action, params);
    } catch (error) {
      if (attempt >= delays.length || !isRetryableLedgerError(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
    }
  }
}

function queueItemCheckWrite(tradeId: string, scheduleId: string, done: boolean): void {
  if (!writeBackEnabled) return;
  const key = `${tradeId}|${scheduleId}`;
  itemCheckTargets[key] = done;
  itemCheckAttempts[key] = 0;
  // 새 목표가 들어오면 대기 중이던 재시도를 즉시 선점한다
  if (itemCheckRetryTimers[key]) {
    clearTimeout(itemCheckRetryTimers[key]);
    delete itemCheckRetryTimers[key];
  }
  void commitItemCheckWrite(tradeId, scheduleId, key);
}

async function commitItemCheckWrite(tradeId: string, scheduleId: string, key: string): Promise<void> {
  if (itemCheckInFlight[key] || itemCheckRetryTimers[key]) return;
  const target = itemCheckTargets[key];
  if (target === undefined) return;
  const task = (async () => {
    try {
      await gasMutation("toggleItem", { scheduleId, phase: "checkout", done: target });
      if (itemCheckTargets[key] === target) delete itemCheckTargets[key];
      delete itemCheckAttempts[key];
    } catch (error) {
      if (itemCheckTargets[key] !== target) return; // 새 목표가 이미 대기 — 그쪽 커밋이 이어간다
      const attempt = itemCheckAttempts[key] ?? 0;
      if (isRetryableLedgerError(error) && attempt < ITEM_CHECK_RETRY_DELAYS_MS.length) {
        itemCheckAttempts[key] = attempt + 1;
        itemCheckRetryTimers[key] = setTimeout(() => {
          delete itemCheckRetryTimers[key];
          void commitItemCheckWrite(tradeId, scheduleId, key);
        }, ITEM_CHECK_RETRY_DELAYS_MS[attempt]);
        return;
      }
      delete itemCheckTargets[key];
      delete itemCheckAttempts[key];
      console.error("[write-back] 품목 반출 체크 원장 반영 실패:", error);
      const message = error instanceof Error ? error.message : String(error);
      showTransientError(`⚠️ 품목 반출 체크 원장 반영 실패 — ${message}`, 6_000);
      if (typeof window !== "undefined") {
        window.setTimeout(() => void pollSheetChangesNow({ mode: "light", resetBackoff: false }), 3_000);
      }
    }
  })();
  itemCheckInFlight[key] = task;
  try {
    await task;
  } finally {
    if (itemCheckInFlight[key] === task) delete itemCheckInFlight[key];
    if (itemCheckTargets[key] !== undefined && !itemCheckRetryTimers[key]) {
      void commitItemCheckWrite(tradeId, scheduleId, key);
    }
  }
}

// ── 품목별 반출/반납 상태 ───────────────────────────────────────
export function setItemCheckout(tradeId: string, scheduleId: string, next: CheckoutState) {
  const currentTrade = state.trades.find((t) => t.tradeId === tradeId);
  const baselineStarted = !!currentTrade && isCheckoutBaselineLocked(currentTrade);
  if (baselineStarted) {
    set({ toast: { id: ++toastSeq, text: "⚠️ 반출 기준선이 고정되어 품목 포함 여부를 바꿀 수 없습니다", kind: "error" } });
    return;
  }
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
  if (final === "taken") queueItemCheckWrite(tradeId, scheduleId, true);
  else if (final === "pending") queueItemCheckWrite(tradeId, scheduleId, false);
  // 원장 쓰기가 꺼져 있으면 제외를 앱 상태로만 숨기지 않는다.
}
export async function setItemName(tradeId: string, scheduleId: string, name: string): Promise<boolean> {
  const clean = name.trim();
  if (!clean) return false;

  if (isSupabase && !writeBackEnabled) {
    showTransientError(`⚠️ 장비명 변경 실패: ${writeBackDisabledReason}`);
    return false;
  }

  try {
    const res = isSupabase
      ? await gasMutation("updateEquipName", { tid: tradeId, scheduleId, equipName: clean })
      : null;
    if (res?.unchanged) return true;
    const canonicalName = String(res?.equipName || clean).trim();
    const updates: { scheduleId: string; field?: string; newName?: string }[] =
      res?.updatedItems ?? [{ scheduleId, field: "equipment", newName: canonicalName }];
    const affectedIds = new Set(updates.map((item) => item.scheduleId).filter(Boolean));
    affectedIds.add(scheduleId);
    mutateTrade(tradeId, (t) => {
      const returnCounts = { ...(t.returnCounts ?? {}) };
      affectedIds.forEach((id) => delete returnCounts[id]);
      return {
        ...t,
        equipments: t.equipments.map((e) => {
          const update = updates.find((item) => item.scheduleId === e.scheduleId);
          if (!update) return e;
          const nextName = String(update.newName || canonicalName).trim();
          if (update.field === "setName") return { ...e, setName: nextName };
          return {
            ...e,
            name: nextName,
            setName: e.setName && e.setName.trim() === e.name.trim() ? nextName : e.setName,
            category: categoryOf(nextName) ?? e.category,
          };
        }),
        returnCounts,
        returnDone: false,
        returnDoneAt: null,
        contractStatus: t.contractStatus === "반납완료" ? (res?.contractStatus || "반출") : t.contractStatus,
      };
    });
    if (isSupabase) await flushTradePersist(tradeId);
    flashSave(tradeId);
    return true;
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    showTransientError(`⚠️ 장비명 변경 실패 — ${error}`);
    return false;
  }
}
/** GAS updateEquipQty 응답(updatedItems, 세트 비례 조정 포함)을 로컬 상태에 정본 반영한다. */
function applyEquipQtyResult(tradeId: string, scheduleId: string, safeQty: number, res: any): void {
  const updates: { scheduleId: string; newQty: number }[] = res?.updatedItems ?? [{ scheduleId, newQty: safeQty }];
  const affectedIds = new Set(updates.map((u) => u.scheduleId).filter(Boolean));
  affectedIds.add(scheduleId);
  mutateTrade(tradeId, (t) => {
    const byId = new Map(updates.map((u) => [u.scheduleId, Number(u.newQty) || 1]));
    const returnCounts = { ...(t.returnCounts ?? {}) };
    affectedIds.forEach((id) => delete returnCounts[id]);
    return {
      ...t,
      equipments: t.equipments.map((e) => {
        if (!byId.has(e.scheduleId)) return e;
        const nextQty = byId.get(e.scheduleId)!;
        // takenQty는 반출 순간의 불변 기준선이다. 예약 수량 수정이 과거 반출량을 줄이면 안 된다.
        return { ...e, qty: nextQty, takenQty: e.takenQty };
      }),
      returnCounts,
      returnDone: false,
      returnDoneAt: null,
      contractStatus: t.contractStatus === "반납완료" ? (res?.contractStatus || "반출") : t.contractStatus,
    };
  });
}

export async function setItemQty(tradeId: string, scheduleId: string, qty: number): Promise<boolean> {
  const safeQty = Math.max(1, Math.round(qty));
  if (isSupabase && !writeBackEnabled) {
    set({ toast: { id: ++toastSeq, text: `⚠️ 수량 변경 실패: ${writeBackDisabledReason}`, kind: "error" } });
    return false;
  }

  try {
    // 세트 헤더 수량 변경 시 GAS가 구성품 수량을 비례 조정하므로 원장을 먼저 확정한다.
    const res = isSupabase
      ? await gasMutation("updateEquipQty", { tid: tradeId, scheduleId, qty: safeQty })
      : null;
    if (res?.unchanged) return true;
    applyEquipQtyResult(tradeId, scheduleId, safeQty, res);
    if (isSupabase) await flushTradePersist(tradeId);
    flashSave(tradeId);
    return true;
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    set({ toast: { id: ++toastSeq, text: `⚠️ 수량 변경 실패 — ${error}`, kind: "error" } });
    return false;
  }
}

// ── 스테퍼용 낙관적 수량 변경 ────────────────────────────────────
// setItemQty는 원장 왕복(1~3초)을 먼저 기다려 스테퍼가 탭마다 수 초간 무반응이었고,
// 연타 시 stale 값 기반 경쟁으로 수량이 유실됐다. queueItemQty는 화면을 즉시 바꾸고
// 350ms 디바운스 후 최종값 1회만 원장에 확정하며, 같은 품목의 전송을 직렬화한다.
const qtyCommitTimers: Record<string, ReturnType<typeof setTimeout> | undefined> = {};
const qtyCommitInFlight: Record<string, Promise<void> | undefined> = {};
const qtyCommitTargets: Record<string, number | undefined> = {};
const QTY_COMMIT_DEBOUNCE_MS = 350;

export function queueItemQty(tradeId: string, scheduleId: string, qty: number): void {
  const safeQty = Math.max(1, Math.round(qty));
  if (isSupabase && !writeBackEnabled) {
    set({ toast: { id: ++toastSeq, text: `⚠️ 수량 변경 실패: ${writeBackDisabledReason}`, kind: "error" } });
    return;
  }
  // 화면 즉시 반영 (persist=false — 원장 확정 후 flushTradePersist가 저장)
  mutateTrade(tradeId, (t) => mapItem(t, scheduleId, (e) => ({ ...e, qty: safeQty })), false);
  if (!isSupabase) {
    flashSave(tradeId);
    return;
  }
  const key = `${tradeId}|${scheduleId}`;
  qtyCommitTargets[key] = safeQty;
  if (qtyCommitTimers[key]) clearTimeout(qtyCommitTimers[key]);
  qtyCommitTimers[key] = setTimeout(() => {
    delete qtyCommitTimers[key];
    void commitQueuedItemQty(tradeId, scheduleId, key);
  }, QTY_COMMIT_DEBOUNCE_MS);
}

async function commitQueuedItemQty(tradeId: string, scheduleId: string, key: string): Promise<void> {
  if (qtyCommitInFlight[key]) return; // 진행 중이면 완료 후 남은 target을 이어서 커밋
  const target = qtyCommitTargets[key];
  if (target === undefined) return;
  delete qtyCommitTargets[key];
  const saveId = beginTradeSave(tradeId);
  const task = (async () => {
    try {
      const res = await gasMutation("updateEquipQty", { tid: tradeId, scheduleId, qty: target });
      if (!res?.unchanged) applyEquipQtyResult(tradeId, scheduleId, target, res);
      await flushTradePersist(tradeId);
      finishTradeSave(tradeId, saveId, "saved", "저장됨");
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      console.error("[write-back] 수량 변경 실패:", e);
      finishTradeSave(tradeId, saveId, "error", `⚠️ 수량 변경 실패 — ${error}`);
      // 낙관 표시를 서버 정본으로 되돌린다(해당 거래만 재조회)
      try {
        const [serverTrade] = await fetchTradesByIds([tradeId]);
        if (serverTrade && !hasPendingPersist()) {
          set({ trades: mergeTradeChanges(state.trades, [serverTrade]) });
        }
      } catch {
        /* 롤백 실패 시 다음 폴링이 수렴시킨다 */
      }
    }
  })();
  qtyCommitInFlight[key] = task;
  try {
    await task;
  } finally {
    if (qtyCommitInFlight[key] === task) delete qtyCommitInFlight[key];
    // 커밋 중 새 목표값이 들어왔으면 이어서 전송(직렬화)
    if (qtyCommitTargets[key] !== undefined) void commitQueuedItemQty(tradeId, scheduleId, key);
  }
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

/** 현장추가 — 정산유형과 무관하게 모든 물리 반출을 스케줄상세/GAS에 기록한 뒤, 시트가 발급한
 *  실 scheduleId로 품목을 반영한다. 무상/미정은 0원으로 기록하되 반출 기준선에서는 빠지지 않는다.
 *  세트는 백엔드가 세트마스터로 구성품을 전개하므로 대표/단품만 보낸다.
 *  자유입력 품목은 rawNames로 그대로 시트에 기록됨(장비마스터 매칭 안 함). 가용 불가면 에러를 던진다. */
export async function addOnsiteItems(tradeId: string, entries: OnsiteEntry[], settlement: Settlement) {
  if (!isSupabase) {
    addOnsiteItemsLocal(tradeId, entries, settlement);
    return;
  }
  if (!writeBackEnabled) {
    throw new Error(`현장 추가 실패: ${writeBackDisabledReason}`);
  }

  // 세트 구성품은 백엔드가 세트마스터로 다시 전개하므로 대표행/단품만 전송(중복 방지)
  const payload = entries.filter((e) => !e.isComponent).map((e) => ({ name: e.name, qty: e.qty }));
  if (payload.length === 0) return;

  // 계약서 재생성은 백그라운드 워커에 위임 — 현장추가 응답에서 재생성 시간(수 초~수십 초)을
  // 제거하고 GAS 잠금 점유도 짧게 만든다. 새 링크는 pending 배지 → 폴링 merge로 반영.
  const res = await gasMutation("onsiteAddon", {
    tid: tradeId,
    entries: JSON.stringify(payload),
    rawNames: true,
    settlement_status: settlement,
    actorName: "오늘 일정 웹앱",
    directRegenerate: false,
  });

  // 실데이터에서 로컬 폴백은 물리 반출 기준선을 만들지 못하므로 실패-폐쇄한다.
  if (res?.skipped) {
    throw new Error(`현장 추가 실패: ${writeBackDisabledReason}`);
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
  if (isSupabase) {
    // 레거시 앱 전용 ONS 행도 원격 삭제가 실제 성공한 뒤에만 화면에서 없앤다.
    // taken_qty 기준선이 있으면 remote 계층이 삭제를 거부해 물리 반출 기록을 보존한다.
    void deleteScheduleItem(tradeId, scheduleId)
      .then(() => {
        mutateTrade(tradeId, (t) => ({ ...t, equipments: t.equipments.filter((e) => e.scheduleId !== scheduleId) }));
        flashSave(tradeId);
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        set({ toast: { id: ++toastSeq, text: `⚠️ 품목 삭제 차단 — ${message}`, kind: "error" } });
      });
    return;
  }
  mutateTrade(tradeId, (t) => ({ ...t, equipments: t.equipments.filter((e) => e.scheduleId !== scheduleId) }));
  flashSave(tradeId);
}

// ── 반납: 품목(scheduleId) 단위 카운트 + 시트 write-back ────────────
export async function setReturnCount(tradeId: string, scheduleId: string, patch: Partial<ReturnCount>): Promise<boolean> {
  let writeback: boolean | undefined;
  mutateTrade(tradeId, (t) => {
    const item = t.equipments.find((e) => e.scheduleId === scheduleId);
    const expected = item ? item.takenQty ?? item.qty : 0;
    const cur = t.returnCounts?.[scheduleId] ?? { good: 0, damaged: 0, lost: 0 };
    const next = { ...cur, ...patch };
    const wasIn = expected > 0 && cur.good + cur.damaged + cur.lost === expected;
    const isIn = expected > 0 && next.good + next.damaged + next.lost === expected;
    if (wasIn !== isIn) writeback = isIn; // 줄이 전부 처리됨 ↔ 해제 전환 시에만 시트 반영
    return { ...t, returnCounts: { ...t.returnCounts, [scheduleId]: next } };
  }, false);
  flashSave(tradeId);
  if (!isSupabase) return true;
  scheduleReturnCountsPersist(tradeId);
  if (writeback === undefined) return true;

  try {
    await flushReturnCountsPersist(tradeId);
    // 완료된 거래의 수량을 다시 줄인 경우에만 원장을 한 번 열어준다.
    // 일반 반납 체크는 Supabase 부분 저장만 수행하고 GAS 품목별 호출은 하지 않는다.
    const latest = state.trades.find((t) => t.tradeId === tradeId);
    if (writeback === false && (latest?.returnDone || latest?.contractStatus === "반납완료")) {
      if (!writeBackEnabled) throw new Error(writeBackDisabledReason);
      const res = await gasMutation("toggleReturn", { tid: tradeId, done: false });
      mutateTrade(tradeId, (t) => ({
        ...t,
        returnDone: false,
        returnDoneAt: null,
        contractStatus: res?.contractStatus || "반출",
      }));
    }
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[write-back] 반납 수량 저장 실패:", error);
    set({ toast: { id: ++toastSeq, text: `⚠️ 반납 수량 저장 실패 — ${message}`, kind: "error" } });
    return false;
  }
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
  gasWrite("updateTradeProof", { tid: tradeId, field: "depositStatus", value: status }, { tradeId, label: "입금 상태" });
}
export function setProofType(tradeId: string, proofType: string) {
  mutateTrade(tradeId, (t) => ({ ...t, proofType }));
  flashSave(tradeId);
  gasWrite("updateTradeProof", { tid: tradeId, field: "proofType", value: proofType }, { tradeId, label: "증빙 유형" });
}
export function setIssueStatus(tradeId: string, issueStatus: string) {
  mutateTrade(tradeId, (t) => ({ ...t, issueStatus }));
  flashSave(tradeId);
  gasWrite("updateTradeProof", { tid: tradeId, field: "issueStatus", value: issueStatus }, { tradeId, label: "발행 상태" });
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
  gasWrite("sendEstimate", { tid: tradeId }, { tradeId, label: "견적 발송" });
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
// 토스트만 바뀐 emit에 데이터 뷰 전체가 재렌더되지 않도록, useDashboard는
// date/trades/notes/savingTrades가 실제로 바뀔 때만 새 스냅샷 객체를 만든다.
let dashSnapshot: DashboardDay & { savingTrades: Record<string, boolean> } = {
  date: state.date,
  trades: state.trades,
  notes: state.notes,
  savingTrades: state.savingTrades,
};
function getDashSnapshot() {
  if (
    dashSnapshot.date !== state.date ||
    dashSnapshot.trades !== state.trades ||
    dashSnapshot.notes !== state.notes ||
    dashSnapshot.savingTrades !== state.savingTrades
  ) {
    dashSnapshot = { date: state.date, trades: state.trades, notes: state.notes, savingTrades: state.savingTrades };
  }
  return dashSnapshot;
}
export function useDashboard(): DashboardDay & { savingTrades: Record<string, boolean> } {
  return useSyncExternalStore(subscribe, getDashSnapshot, getDashSnapshot);
}
export function useToast() {
  return useSyncExternalStore(subscribe, () => state.toast, () => state.toast);
}

// 파이어-앤-포겟 원장 쓰기 실패를 화면에 알리고, 잠시 후 시트 상태와 자동 수렴시킨다.
setGasWriteFailureHandler((action, _error, context) => {
  const label = context?.label ?? action;
  showTransientError(`⚠️ ${label} 원장 반영 실패 — 시트와 다를 수 있어 잠시 후 자동 재확인합니다`, 5_000);
  if (typeof window !== "undefined") {
    window.setTimeout(() => void pollSheetChangesNow({ mode: "light", resetBackoff: false }), 3_000);
  }
});
