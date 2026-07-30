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
import { equipmentActualTakenQty } from "../domain/equipmentActual";
import { buildSeed } from "./seed";
import { isSupabase, supabase } from "../supabase/client";
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
  persistScheduleItemPatch,
  persistTradeFieldPatch,
  persistTrade,
  ReturnCompletionConflictError,
  searchTradesRemote,
  subscribeChanges,
  type RemoteChange,
} from "./remote";
import { GasMutationError, gasMutation, gasRead, isGasOutcomeUnknownError, setGasWriteFailureHandler, writeBackDisabledReason, writeBackEnabled } from "./writeback";
import {
  configurePhotoUploadQueue,
  discardPhotoUpload,
  enqueuePhotoUpload,
  isPhotoUploadJobFailed,
  listPhotoUploadJobs,
  onPhotoQueueChange,
  resumePhotoUploads,
  retryPhotoUpload,
  snapshotPhotoQueueSummary,
  type PhotoUploadJob,
} from "./photoUploadQueue";
import { pollTimelineChanges, repairDashboardDateDetails, repairDashboardSearchResults, resetRepairBackoff } from "./sync";

type RemoteStatus = "loading" | "ready" | "error";

interface State {
  date: string;
  trades: Trade[];
  notes: HandoverNote[];
  savingTrades: Record<string, boolean>;
  remoteStatus: RemoteStatus;
  toast: { id: number; text: string; kind: "saving" | "saved" | "error" } | null;
  /** 사진 업로드 큐 전역 요약 — 화면 윈도우 밖 거래의 실패 잡도 배지로 보이게 한다 */
  photoQueueSummary: { uploading: number; failed: number };
}

const cache: Record<string, { trades: Trade[]; notes: HandoverNote[] }> = {};
let state: State = {
  date: "",
  trades: [],
  notes: [],
  savingTrades: {},
  remoteStatus: isSupabase ? "loading" : "ready",
  toast: null,
  photoQueueSummary: { uploading: 0, failed: 0 },
};
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
const tradeFieldPersistTargets: Record<string, Record<string, string | number | boolean | null> | undefined> = {};
const tradeFieldPersistRetryTimers: Record<string, ReturnType<typeof setTimeout> | undefined> = {};
const tradeFieldPersistRetryAttempts: Record<string, number | undefined> = {};
const pendingPersistTrades = new Set<string>();
const setupOutcomeRetryTimers: Record<string, number | undefined> = {};
const returnCountPersistTimers: Record<string, ReturnType<typeof setTimeout> | undefined> = {};
const returnCountPersistInFlight: Record<string, Promise<Trade> | undefined> = {};
type ReturnCountPatch = Partial<ReturnCount> | null;
const returnCountPersistTargets: Record<string, Record<string, ReturnCountPatch> | undefined> = {};
const pendingReturnCountTrades = new Set<string>();
const returnCountSaveTokens: Record<string, number[] | undefined> = {};
const returnCountOutboxResumeTimers: Record<string, ReturnType<typeof setTimeout> | undefined> = {};
const returnCountPersistRetryAttempts: Record<string, number | undefined> = {};
let notesTimer: ReturnType<typeof setTimeout> | null = null;
let notesPersistGeneration = 0;
let notesPersistPending = false;
let pollTimer: ReturnType<typeof setInterval> | null = null;
const POLL_MS = 90_000;
let pollCount = 0;
let pollInFlight = false;
let lastPollAt = 0;
let localMutationSeq = 0;
let ledgerMutationSeq = 0;
const tradeMutationSeq: Record<string, number> = {};
let notesMutationSeq = 0;

type ContractMutationPayload = {
  result?: ContractMutationPayload;
  success?: boolean;
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

function markLocalMutation(tradeId?: string) {
  localMutationSeq++;
  if (tradeId) tradeMutationSeq[tradeId] = (tradeMutationSeq[tradeId] ?? 0) + 1;
}

function createLedgerMutationId(scope: string): string {
  ledgerMutationSeq++;
  const uuid = typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : `${Date.now().toString(36)}-${ledgerMutationSeq.toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${scope}:${uuid}`.replace(/[^A-Za-z0-9_.:-]/g, "").slice(0, 120);
}

function hasTradePending(tradeId: string): boolean {
  return pendingRemoveEquipmentTrades.has(tradeId) || hasTradePendingExcludingRemove_(tradeId);
}

function hasTradePendingExcludingRemove_(tradeId: string): boolean {
  return (
    pendingReturnCountTrades.has(tradeId) ||
    !!state.savingTrades[tradeId] ||
    Object.keys(itemCheckTargets).some((key) => key.startsWith(`${tradeId}|`)) ||
    Object.keys(qtyCommitTargets).some((key) => key.startsWith(`${tradeId}|`))
  );
}

/** 원격 snapshot이 로컬 보조필드 저장을 덮지 않게 하는 수렴용 blocker.
 * 사용자 명령 blocker와 분리해 메모/결제 보조 PATCH 재시도가 카드 전체를 막지 않는다. */
function hasTradeSyncPending(tradeId: string): boolean {
  return pendingPersistTrades.has(tradeId) || hasTradePending(tradeId);
}

function hasPendingPersist(): boolean {
  return (
    pendingPersistTrades.size > 0 ||
    pendingReturnCountTrades.size > 0 ||
    notesPersistPending ||
    Object.keys(state.savingTrades).length > 0 ||
    Object.keys(itemCheckTargets).length > 0 ||
    Object.keys(itemCheckInFlight).length > 0 ||
    Object.keys(itemCheckRetryTimers).length > 0 ||
    Object.keys(qtyCommitTargets).length > 0 ||
    Object.keys(qtyCommitInFlight).length > 0 ||
    Object.keys(qtyCommitTimers).length > 0 ||
    pendingRemoveEquipmentTrades.size > 0 ||
    Object.keys(itemMetadataPatchTargets).length > 0 ||
    Object.keys(itemMetadataPatchInFlight).length > 0 ||
    Object.keys(itemMetadataPatchRetryTimers).length > 0 ||
    Object.keys(tradeFieldPersistRetryTimers).length > 0
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

// ── 제외 확정 직후 좀비 부활 방지 ───────────────────────────────
// 제외 성공(GAS 시트 행 삭제) 뒤 Supabase removed_at 투영은 시간 트리거 워커가 맡아
// 수 초~수 분(백오프 시 최대 30분) 늦을 수 있다. 그 사이 realtime 에코/새로고침
// 스냅샷이 제외 품목을 체크리스트에 되살리지 않도록, ACK 시점에 단기 tombstone을
// 남기고 모든 스냅샷 적용 경로에서 걸러낸다.
const EXCLUDED_ITEM_TOMBSTONE_KEY = "heybilly:excluded-item-tombstones:v1";
const EXCLUDED_ITEM_TOMBSTONE_TTL_MS = 10 * 60 * 1000;
type ExcludedItemTombstone = { at: number; name?: string };

function readExcludedItemTombstones_(): Record<string, ExcludedItemTombstone> {
  if (typeof window === "undefined") return {};
  try {
    const parsed = JSON.parse(window.localStorage.getItem(EXCLUDED_ITEM_TOMBSTONE_KEY) || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const now = Date.now();
    const fresh: Record<string, ExcludedItemTombstone> = {};
    for (const [key, raw] of Object.entries(parsed as Record<string, unknown>)) {
      // 구버전 값(숫자)도 수용
      const entry: ExcludedItemTombstone =
        typeof raw === "number" ? { at: raw } : ((raw ?? {}) as ExcludedItemTombstone);
      if (Number(entry.at) && now - Number(entry.at) < EXCLUDED_ITEM_TOMBSTONE_TTL_MS) {
        fresh[key] = { at: Number(entry.at), name: entry.name ? String(entry.name) : undefined };
      }
    }
    return fresh;
  } catch {
    return {};
  }
}

function writeExcludedItemTombstones_(tombstones: Record<string, ExcludedItemTombstone>): void {
  if (typeof window === "undefined") return;
  try {
    if (Object.keys(tombstones).length) window.localStorage.setItem(EXCLUDED_ITEM_TOMBSTONE_KEY, JSON.stringify(tombstones));
    else window.localStorage.removeItem(EXCLUDED_ITEM_TOMBSTONE_KEY);
  } catch { /* noop */ }
}

function recordExcludedItemTombstone_(tradeId: string, scheduleId: string, equipName?: string): void {
  if (typeof window === "undefined") return;
  try {
    const tombstones = readExcludedItemTombstones_();
    tombstones[`${tradeId}|${scheduleId}`] = { at: Date.now(), name: equipName ? String(equipName) : undefined };
    writeExcludedItemTombstones_(tombstones);
  } catch { /* private mode: realtime 좀비는 워커 투영 후 자연 수렴 */ }
}

/** 추가가 확정한 스케줄ID의 tombstone을 해제한다 — GAS가 제외로 빈 번호를 재사용하면
 * 새 장비가 tombstone에 걸려 10분간 숨는 회귀를 막는다. */
function clearExcludedItemTombstones_(tradeId: string, scheduleIds: string[]): void {
  if (typeof window === "undefined" || !scheduleIds.length) return;
  try {
    const tombstones = readExcludedItemTombstones_();
    let changed = false;
    scheduleIds.forEach((scheduleId) => {
      const key = `${tradeId}|${String(scheduleId || "").trim()}`;
      if (tombstones[key]) {
        delete tombstones[key];
        changed = true;
      }
    });
    if (changed) writeExcludedItemTombstones_(tombstones);
  } catch { /* noop */ }
}

function dropRecentlyExcludedItems_(trade: Trade, tombstones: Record<string, ExcludedItemTombstone>): Trade {
  if (!Object.keys(tombstones).length) return trade;
  const filtered = trade.equipments.filter((item) => {
    const tomb = tombstones[`${trade.tradeId}|${item.scheduleId}`];
    if (!tomb) return true;
    // 이름이 다르면 제외했던 그 품목이 아니라 번호를 재사용한 새 장비다 — 숨기지 않는다
    if (tomb.name && String(item.name || "").trim() !== String(tomb.name).trim()) return true;
    return false;
  });
  return filtered.length === trade.equipments.length ? trade : { ...trade, equipments: filtered };
}

function preservePhotosInSnapshot(next: Trade[], previous = state.trades): Trade[] {
  const previousById = new Map(previous.map((t) => [t.tradeId, t]));
  const tombstones = readExcludedItemTombstones_();
  return attachResumedPhotoTiles_(
    next.map((t) => dropRecentlyExcludedItems_(preserveTradePhotos(t, previousById.get(t.tradeId)), tombstones)),
  );
}

function mergeTradeChanges(base: Trade[], changed: Trade[]): Trade[] {
  const baseById = new Map(base.map((t) => [t.tradeId, t]));
  const byId = new Map(changed.map((t) => [t.tradeId, t]));
  const tombstones = readExcludedItemTombstones_();
  const merged = base.map((t) => {
    const next = byId.get(t.tradeId);
    return next ? dropRecentlyExcludedItems_(preserveTradePhotos(next, t), tombstones) : t;
  });
  for (const t of changed) if (!baseById.has(t.tradeId)) merged.push(dropRecentlyExcludedItems_(t, tombstones));
  return attachResumedPhotoTiles_(merged);
}

async function applyDashboardRepairs(
  changed: Trade[],
  _mutationSeqAtStart: number,
  versionsAtStart: Record<string, number> = {},
): Promise<boolean> {
  if (!changed.length) return false;
  const applicable = changed.filter((trade) =>
    !hasTradeSyncPending(trade.tradeId) &&
    (tradeMutationSeq[trade.tradeId] ?? 0) === (versionsAtStart[trade.tradeId] ?? 0),
  );
  if (!applicable.length) return false;
  set({ trades: mergeTradeChanges(state.trades, applicable) });
  for (const t of applicable) void enqueueTradePersist(t.tradeId, t).catch(() => {});
  return true;
}

async function repairDayDetails(date: string, mutationSeqAtStart = localMutationSeq, opts?: { fresh?: boolean }): Promise<boolean> {
  if (!isSupabase) return false;
  const versionsAtStart = Object.fromEntries(state.trades.map((trade) => [trade.tradeId, tradeMutationSeq[trade.tradeId] ?? 0]));
  const changed = await repairDashboardDateDetails(state.trades, date, opts);
  return applyDashboardRepairs(changed, mutationSeqAtStart, versionsAtStart);
}

export async function repairSearchResults(query: string): Promise<void> {
  if (!isSupabase) return;
  const q = query.trim();
  if (q.length < 2) return;
  const mutationSeqAtSearch = localMutationSeq;
  const versionsAtSearch = Object.fromEntries(state.trades.map((trade) => [trade.tradeId, tradeMutationSeq[trade.tradeId] ?? 0]));
  // 운영 윈도우 밖 과거 거래도 검색되도록 Supabase에서 지연 로드(원장 검색 복구와 병렬)
  const [changed, remoteMatches] = await Promise.all([
    repairDashboardSearchResults(state.trades, q),
    searchTradesRemote(q).catch(() => [] as Trade[]),
  ]);
  if (remoteMatches.length) {
    const known = new Set(state.trades.map((t) => t.tradeId));
    const fresh = remoteMatches.filter((t) => !known.has(t.tradeId) && !hasTradeSyncPending(t.tradeId));
    if (fresh.length) {
      fresh.forEach((t) => extraTradeIds.add(t.tradeId));
      set({ trades: [...state.trades, ...fresh] });
    }
  }
  await applyDashboardRepairs(changed, mutationSeqAtSearch, versionsAtSearch);
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
  const allIds = [...realtimeTradeIds];
  const fullResync = realtimeNeedsFullResync || allIds.length > REALTIME_FULL_RESYNC_THRESHOLD;
  const mutationSeqAtFlush = localMutationSeq;
  const blockedIds = fullResync ? [] : allIds.filter((id) => hasTradeSyncPending(id));
  const safeIds = fullResync ? allIds : allIds.filter((id) => !hasTradeSyncPending(id));
  realtimeTradeIds.clear();
  blockedIds.forEach((id) => realtimeTradeIds.add(id));
  const notesChanged = realtimeNotesChanged && !notesPersistPending;
  if (notesChanged) realtimeNotesChanged = false;
  if (fullResync) realtimeNeedsFullResync = false;
  const versionAtFetch: Record<string, number> = {};
  (fullResync ? state.trades.map((trade) => trade.tradeId) : safeIds)
    .forEach((id) => { versionAtFetch[id] = tradeMutationSeq[id] ?? 0; });
  const notesVersionAtFetch = notesMutationSeq;

  if (!fullResync && safeIds.length === 0 && !notesChanged) {
    if (blockedIds.length || realtimeNotesChanged) scheduleRealtimeFlush(REALTIME_RETRY_MS);
    return;
  }

  realtimeFlushInFlight = true;
  try {
    if (fullResync) {
      const [trades, notes] = await Promise.all([fetchAllTrades(), fetchNotes()]);
      // 전체 수렴도 한 거래의 저장 때문에 모든 카드를 멈추지 않는다. fetch 중 바뀐 거래만
      // 현 로컬값으로 운반하고, 나머지 거래는 즉시 새 정본을 적용한다.
      const blockedNow = new Set(state.trades
        .filter((trade) =>
          hasTradeSyncPending(trade.tradeId) ||
          versionAtFetch[trade.tradeId] === undefined ||
          (tradeMutationSeq[trade.tradeId] ?? 0) !== versionAtFetch[trade.tradeId],
        )
        .map((trade) => trade.tradeId));
      blockedNow.forEach((id) => realtimeTradeIds.add(id));
      const applicable = trades.filter((trade) => !blockedNow.has(trade.tradeId));
      const applicableIds = new Set(applicable.map((trade) => trade.tradeId));
      let mergedTrades = mergeTradeChanges(state.trades, applicable);
      mergedTrades = mergedTrades.filter((trade) =>
        blockedNow.has(trade.tradeId) || applicableIds.has(trade.tradeId) || extraTradeIds.has(trade.tradeId),
      );
      mergedTrades = preservePhotosInSnapshot(mergedTrades);
      const notesSafe = !notesPersistPending && notesMutationSeq === notesVersionAtFetch;
      if (!notesSafe) realtimeNotesChanged = true;
      set(notesSafe ? { trades: mergedTrades, notes } : { trades: mergedTrades });
      if (state.date) await repairDayDetails(state.date, mutationSeqAtFlush, { fresh: false });
      return;
    }
    const [changed, notes] = await Promise.all([
      safeIds.length ? fetchTradesByIds(safeIds) : Promise.resolve([]),
      notesChanged ? fetchNotes() : Promise.resolve(null),
    ]);
    const staleIds = safeIds.filter((id) => hasTradeSyncPending(id) || (tradeMutationSeq[id] ?? 0) !== versionAtFetch[id]);
    staleIds.forEach((id) => realtimeTradeIds.add(id));
    const applyIds = safeIds.filter((id) => !staleIds.includes(id));
    const applySet = new Set(applyIds);
    const applicable = changed.filter((trade) => applySet.has(trade.tradeId));
    const foundIds = new Set(changed.map((t) => t.tradeId));
    const deletedIds = new Set(applyIds.filter((id) => !foundIds.has(id)));
    let trades = mergeTradeChanges(state.trades, applicable);
    if (deletedIds.size) trades = trades.filter((t) => !deletedIds.has(t.tradeId));
    const notesSafe = !!notes && !notesPersistPending && notesMutationSeq === notesVersionAtFetch;
    if (notes && !notesSafe) realtimeNotesChanged = true;
    if (applyIds.length || deletedIds.size || notesSafe) set(notesSafe ? { trades, notes } : { trades });
  } catch {
    requeueRealtimeChanges(safeIds, notesChanged, fullResync);
    scheduleRealtimeFlush(REALTIME_RETRY_MS);
  } finally {
    realtimeFlushInFlight = false;
    if (realtimeTradeIds.size || realtimeNotesChanged || realtimeNeedsFullResync) {
      scheduleRealtimeFlush(REALTIME_RETRY_MS);
    }
  }
}

async function loadRemoteOnce(): Promise<void> {
  let loadedThisAttempt = false;
  try {
    const [trades, notes] = await Promise.all([fetchAllTrades(), fetchNotes()]);
    const mergedTrades = preservePhotosInSnapshot(trades);
    remoteLoaded = true;
    loadedThisAttempt = true;
    set({ trades: mergedTrades, notes, remoteStatus: "ready" });
  } catch (e) {
    console.error("[supabase] load 실패", e);
    set({ remoteStatus: "error" });
  }
  if (loadedThisAttempt) {
    replayDurableMutationOutboxes();
    if (state.date) await repairDayDetails(state.date, localMutationSeq, { fresh: false });
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
  if (!remoteLoaded && state.remoteStatus !== "loading") set({ remoteStatus: "loading" });
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
  if (!isSupabase || pollInFlight) return;
  const mode = opts?.mode ?? "full";
  if (opts?.resetBackoff ?? true) resetRepairBackoff();
  const mutationSeqAtPoll = localMutationSeq;
  const versionAtPoll = { ...tradeMutationSeq };
  pollInFlight = true;
  try {
    if (state.date && await repairDayDetails(state.date, mutationSeqAtPoll, { fresh: mode === "full" })) return;
    const changed = await pollTimelineChanges(
      state.trades,
      mode === "light" ? { fromDays: -7, toDays: 45 } : undefined,
    );
    if (!changed.length) return;
    const applicable = changed.filter(
      (trade) => !hasTradeSyncPending(trade.tradeId) && (tradeMutationSeq[trade.tradeId] ?? 0) === (versionAtPoll[trade.tradeId] ?? 0),
    );
    changed.filter((trade) => !applicable.includes(trade)).forEach((trade) => realtimeTradeIds.add(trade.tradeId));
    if (!applicable.length) return;
    set({ trades: mergeTradeChanges(state.trades, applicable) });
    for (const t of applicable) void enqueueTradePersist(t.tradeId, t).catch(() => {});
  } catch {
    /* noop */
  } finally {
    pollInFlight = false;
    lastPollAt = Date.now();
  }
}

/** 같은 거래의 전체행 upsert를 직렬화해 오래된 요청이 최신 상태 뒤에 끝나는 일을 막는다. */
function enqueueTradePersist(tradeId: string, fallback: Trade): Promise<Trade> {
  pendingPersistTrades.add(tradeId);
  const previous = persistInFlight[tradeId];
  const task = (previous ?? Promise.resolve(fallback))
    .catch(() => fallback)
    .then(async () => {
      const latest = state.trades.find((t) => t.tradeId === tradeId) ?? fallback;
      // 자동 복구는 누락 행만 채운다. 기존 행을 덮거나 stale keep-set으로 삭제하지 않는다.
      // 반출 후 품목은 taken_qty 불변 기준선이 필수이므로 브라우저 snapshot으로
      // 신규 행을 만들지 않고 GAS가 시트·기존 기준선을 검증해 투영한다.
      if (writeBackEnabled && isCheckoutBaselineLocked(latest)) {
        await gasMutation("repairTradeProjection", { tid: tradeId });
      } else {
        await persistTrade(latest);
      }
      return latest;
    });
  persistInFlight[tradeId] = task;
  const clear = () => {
    if (persistInFlight[tradeId] === task) {
      delete persistInFlight[tradeId];
      if (!persistTimers[tradeId] && persistGenerations[tradeId] == null) pendingPersistTrades.delete(tradeId);
    }
    maybeResumeRealtimeFlush();
  };
  void task.then(clear, clear);
  return task;
}

// ── 거래 특이사항(note_*) 내구 outbox ───────────────────────────
// 노트는 450ms 디바운스 후 Supabase에 저장되는데, 전송 전 새로고침/탭 회수로 조용히
// 유실됐다(품목 메모의 ITEM_METADATA_OUTBOX와 비대칭). 최신 목표를 localStorage에
// 남겨 재시작 시 재적용한다. 오래된 목표가 다른 직원의 새 노트를 덮지 않도록 60분
// TTL을 두고, persist 성공 시에만 ACK한다.
const TRADE_NOTE_OUTBOX_KEY = "heybilly:trade-note-outbox:v1";
const TRADE_NOTE_OUTBOX_TTL_MS = 60 * 60 * 1000;
type TradeNoteOutboxEntry = { note_checkout?: string | null; note_checkin?: string | null; at: number };

function readTradeNoteOutbox_(): Record<string, TradeNoteOutboxEntry> {
  if (typeof window === "undefined") return {};
  try {
    const parsed = JSON.parse(window.localStorage.getItem(TRADE_NOTE_OUTBOX_KEY) || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const now = Date.now();
    const fresh: Record<string, TradeNoteOutboxEntry> = {};
    for (const [tradeId, raw] of Object.entries(parsed as Record<string, unknown>)) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const entry = raw as TradeNoteOutboxEntry;
      if (!Number(entry.at) || now - Number(entry.at) >= TRADE_NOTE_OUTBOX_TTL_MS) continue;
      if (!("note_checkout" in entry) && !("note_checkin" in entry)) continue;
      fresh[tradeId] = entry;
    }
    return fresh;
  } catch {
    return {};
  }
}

function writeTradeNoteOutbox_(outbox: Record<string, TradeNoteOutboxEntry>): void {
  if (typeof window === "undefined") return;
  try {
    if (Object.keys(outbox).length) window.localStorage.setItem(TRADE_NOTE_OUTBOX_KEY, JSON.stringify(outbox));
    else window.localStorage.removeItem(TRADE_NOTE_OUTBOX_KEY);
  } catch { /* private mode: 메모리 재시도는 계속 동작 */ }
}

function putTradeNoteOutboxPatch_(tradeId: string, fields: Omit<TradeNoteOutboxEntry, "at">): void {
  if (!Object.keys(fields).length) return;
  const outbox = readTradeNoteOutbox_();
  outbox[tradeId] = { ...(outbox[tradeId] ?? { at: 0 }), ...fields, at: Date.now() };
  writeTradeNoteOutbox_(outbox);
}

/** persist 성공한 patch의 노트 값과 outbox 목표가 같을 때만 지운다(전송 중 새 입력 보존). */
function acknowledgeTradeNoteOutbox_(tradeId: string, patch: Record<string, unknown>): void {
  if (!("note_checkout" in patch) && !("note_checkin" in patch)) return;
  const outbox = readTradeNoteOutbox_();
  const entry = outbox[tradeId];
  if (!entry) return;
  const next: TradeNoteOutboxEntry = { ...entry };
  (["note_checkout", "note_checkin"] as const).forEach((field) => {
    if (field in patch && field in next && (next[field] ?? null) === ((patch[field] as string | null) ?? null)) {
      delete next[field];
    }
  });
  if (!("note_checkout" in next) && !("note_checkin" in next)) delete outbox[tradeId];
  else outbox[tradeId] = next;
  writeTradeNoteOutbox_(outbox);
}

function tradeFieldPatch(before: Trade | undefined, after: Trade): Record<string, string | number | boolean | null> {
  if (!before) return {};
  const patch: Record<string, string | number | boolean | null> = {};
  const add = (changed: boolean, key: string, value: string | number | boolean | null) => {
    if (changed) patch[key] = value;
  };
  add(before.customerName !== after.customerName, "customer_name", after.customerName);
  add(before.customerPhone !== after.customerPhone, "customer_phone", after.customerPhone ?? null);
  add(before.company !== after.company, "company", after.company ?? null);
  add(before.checkoutAt !== after.checkoutAt, "checkout_at", after.checkoutAt);
  add(before.returnAt !== after.returnAt, "return_at", after.returnAt);
  add(before.discountType !== after.discountType, "discount_type", after.discountType ?? null);
  add(before.paymentMethod !== after.paymentMethod, "payment_method", after.paymentMethod ?? null);
  add(before.paymentWarning !== after.paymentWarning, "payment_warning", !!after.paymentWarning);
  add(before.depositStatus !== after.depositStatus, "deposit_status", after.depositStatus ?? null);
  add(before.proofType !== after.proofType, "proof_type", after.proofType ?? null);
  add(before.issueStatus !== after.issueStatus, "issue_status", after.issueStatus ?? null);
  add(before.billingCompany !== after.billingCompany, "billing_company", after.billingCompany ?? null);
  add(before.estimateSent !== after.estimateSent, "estimate_sent", !!after.estimateSent);
  add(before.noteCheckout !== after.noteCheckout, "note_checkout", after.noteCheckout ?? null);
  add(before.noteCheckin !== after.noteCheckin, "note_checkin", after.noteCheckin ?? null);
  return patch;
}

function enqueueTradeFieldPersist(tradeId: string, fallback: Trade): Promise<Trade> {
  pendingPersistTrades.add(tradeId);
  const previous = persistInFlight[tradeId];
  const task = (previous ?? Promise.resolve(fallback))
    .catch(() => fallback)
    .then(async () => {
      while (tradeFieldPersistTargets[tradeId] && Object.keys(tradeFieldPersistTargets[tradeId]!).length) {
        const patch = tradeFieldPersistTargets[tradeId]!;
        tradeFieldPersistTargets[tradeId] = {};
        try {
          await persistTradeFieldPatch(tradeId, patch);
          acknowledgeTradeNoteOutbox_(tradeId, patch);
        } catch (error) {
          tradeFieldPersistTargets[tradeId] = { ...patch, ...(tradeFieldPersistTargets[tradeId] ?? {}) };
          throw error;
        }
      }
      return state.trades.find((t) => t.tradeId === tradeId) ?? fallback;
    });
  persistInFlight[tradeId] = task;
  const clear = (succeeded: boolean) => {
    if (persistInFlight[tradeId] === task) {
      delete persistInFlight[tradeId];
      if (succeeded && !Object.keys(tradeFieldPersistTargets[tradeId] ?? {}).length) {
        delete tradeFieldPersistTargets[tradeId];
        delete tradeFieldPersistRetryAttempts[tradeId];
      } else if (!succeeded && Object.keys(tradeFieldPersistTargets[tradeId] ?? {}).length && !tradeFieldPersistRetryTimers[tradeId]) {
        const attempt = (tradeFieldPersistRetryAttempts[tradeId] ?? 0) + 1;
        tradeFieldPersistRetryAttempts[tradeId] = attempt;
        const delay = Math.min(30_000, 1_000 * 2 ** Math.min(attempt - 1, 5));
        tradeFieldPersistRetryTimers[tradeId] = setTimeout(() => {
          delete tradeFieldPersistRetryTimers[tradeId];
          const latest = state.trades.find((t) => t.tradeId === tradeId) ?? fallback;
          void enqueueTradeFieldPersist(tradeId, latest).catch(() => {});
        }, delay);
      }
      if (
        !persistTimers[tradeId] &&
        persistGenerations[tradeId] == null &&
        !persistInFlight[tradeId] &&
        !tradeFieldPersistRetryTimers[tradeId] &&
        !Object.keys(tradeFieldPersistTargets[tradeId] ?? {}).length
      ) pendingPersistTrades.delete(tradeId);
    }
    maybeResumeRealtimeFlush();
  };
  void task.then(() => clear(true), () => clear(false));
  return task;
}

function schedulePersistTrade(trade: Trade, before?: Trade) {
  if (!isSupabase) return;
  const tradeId = trade.tradeId;
  const patch = tradeFieldPatch(before, trade);
  if (!Object.keys(patch).length) return;
  tradeFieldPersistTargets[tradeId] = { ...(tradeFieldPersistTargets[tradeId] ?? {}), ...patch };
  // 특이사항은 전송 전 새로고침에도 살아남게 내구 outbox에 목표를 남긴다
  const noteFields: Omit<TradeNoteOutboxEntry, "at"> = {};
  if ("note_checkout" in patch) noteFields.note_checkout = (patch.note_checkout as string | null) ?? null;
  if ("note_checkin" in patch) noteFields.note_checkin = (patch.note_checkin as string | null) ?? null;
  if (Object.keys(noteFields).length) putTradeNoteOutboxPatch_(tradeId, noteFields);
  if (tradeFieldPersistRetryTimers[tradeId]) {
    clearTimeout(tradeFieldPersistRetryTimers[tradeId]);
    delete tradeFieldPersistRetryTimers[tradeId];
  }
  const generation = (persistGenerations[tradeId] ?? 0) + 1;
  persistGenerations[tradeId] = generation;
  pendingPersistTrades.add(tradeId);
  if (persistTimers[trade.tradeId]) clearTimeout(persistTimers[trade.tradeId]);
  persistTimers[trade.tradeId] = setTimeout(async () => {
    const latest = state.trades.find((t) => t.tradeId === tradeId) ?? trade;
    try {
      await enqueueTradeFieldPersist(tradeId, latest);
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
        if (
          !persistInFlight[tradeId] &&
          !tradeFieldPersistRetryTimers[tradeId] &&
          !Object.keys(tradeFieldPersistTargets[tradeId] ?? {}).length
        ) pendingPersistTrades.delete(tradeId);
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
    if (Object.keys(tradeFieldPersistTargets[tradeId] ?? {}).length) {
      return await enqueueTradeFieldPersist(tradeId, fallback);
    }
    if (persistInFlight[tradeId]) return await persistInFlight[tradeId]!;
    return fallback;
  } finally {
    if (persistGenerations[tradeId] === generation) {
      delete persistGenerations[tradeId];
      delete persistTimers[tradeId];
      if (
        !persistInFlight[tradeId] &&
        !tradeFieldPersistRetryTimers[tradeId] &&
        !Object.keys(tradeFieldPersistTargets[tradeId] ?? {}).length
      ) pendingPersistTrades.delete(tradeId);
    }
    maybeResumeRealtimeFlush();
  }
}

function hasReturnCountTargets(tradeId: string): boolean {
  return Object.keys(returnCountPersistTargets[tradeId] ?? {}).length > 0;
}

function beginReturnCountSave(tradeId: string): number {
  const token = beginTradeSave(tradeId);
  returnCountSaveTokens[tradeId] = [...(returnCountSaveTokens[tradeId] ?? []), token];
  return token;
}

function finishReturnCountSaves(tradeId: string, kind: "saved" | "error", text: string): void {
  const tokens = returnCountSaveTokens[tradeId] ?? [];
  delete returnCountSaveTokens[tradeId];
  tokens.forEach((token, index) => {
    finishTradeSave(tradeId, token, kind, index === tokens.length - 1 ? text : "");
  });
}

/** 오래된 미전송 batch 위에 더 최신 사용자의 subfield만 덮어 같은 품목의 다른 수량을 보존한다. */
function mergeReturnCountPatchBatches(
  older: Record<string, ReturnCountPatch>,
  newer: Record<string, ReturnCountPatch>,
): Record<string, ReturnCountPatch> {
  const merged: Record<string, ReturnCountPatch> = { ...older };
  for (const [scheduleId, patch] of Object.entries(newer)) {
    const previous = merged[scheduleId];
    merged[scheduleId] = patch == null
      ? null
      : previous && typeof previous === "object"
        ? { ...previous, ...patch }
        : { ...patch };
  }
  return merged;
}

const RETURN_COUNT_OUTBOX_KEY = "heybilly:return-count-outbox:v1";
const RETURN_COUNT_OUTBOX_VERSION = 2;
type ReturnCountOutboxEntry = {
  version: number;
  createdAt: number;
  observedReturnDone: boolean;
  observedReturnDoneAt: string | null;
  reopenMutationId: string;
  patches: Record<string, ReturnCountPatch>;
};
type ReturnCountOutbox = Record<string, ReturnCountOutboxEntry>;
type ReturnCountOutboxIntent = {
  createdAt: number;
  observedReturnDone: boolean;
  observedReturnDoneAt: string | null;
  reopenMutationId: string;
  replaceExisting?: boolean;
};
const returnCountOutboxMemory = new Map<string, ReturnCountOutboxEntry>();

function normalizeReturnCountOutboxEntry_(raw: unknown): ReturnCountOutboxEntry | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (
    Number(record.version) === RETURN_COUNT_OUTBOX_VERSION &&
    record.patches && typeof record.patches === "object" && !Array.isArray(record.patches)
  ) {
    return {
      version: RETURN_COUNT_OUTBOX_VERSION,
      createdAt: Math.max(0, Number(record.createdAt) || 0),
      observedReturnDone: record.observedReturnDone === true,
      observedReturnDoneAt: String(record.observedReturnDoneAt || "").trim() || null,
      reopenMutationId: String(record.reopenMutationId || "").trim(),
      patches: record.patches as Record<string, ReturnCountPatch>,
    };
  }
  // v1은 거래ID 아래에 patch map만 저장했다. 생성 시점과 당시 완료 상태를 증명할 수
  // 없으므로 완료 거래를 자동 재오픈할 때는 반드시 오래된 의도로 취급한다.
  return {
    version: 1,
    createdAt: 0,
    observedReturnDone: false,
    observedReturnDoneAt: null,
    reopenMutationId: "",
    patches: record as Record<string, ReturnCountPatch>,
  };
}

function readReturnCountOutbox(): ReturnCountOutbox {
  if (typeof window === "undefined") return {};
  try {
    const parsed = JSON.parse(window.localStorage.getItem(RETURN_COUNT_OUTBOX_KEY) || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const outbox: ReturnCountOutbox = {};
    for (const [tradeId, raw] of Object.entries(parsed as Record<string, unknown>)) {
      const entry = normalizeReturnCountOutboxEntry_(raw);
      if (entry && Object.keys(entry.patches).length) outbox[tradeId] = entry;
    }
    return outbox;
  } catch {
    return {};
  }
}

function writeReturnCountOutbox(outbox: ReturnCountOutbox): void {
  if (typeof window === "undefined") return;
  try {
    if (Object.keys(outbox).length) window.localStorage.setItem(RETURN_COUNT_OUTBOX_KEY, JSON.stringify(outbox));
    else window.localStorage.removeItem(RETURN_COUNT_OUTBOX_KEY);
  } catch {
    // localStorage가 막힌 환경에서도 기존 온라인 저장 경로는 계속 동작한다.
  }
}

function putReturnCountOutboxPatch(
  tradeId: string,
  scheduleId: string,
  patch: ReturnCountPatch,
  intent?: ReturnCountOutboxIntent,
): void {
  const outbox = readReturnCountOutbox();
  const existing = outbox[tradeId] ?? returnCountOutboxMemory.get(tradeId);
  const current = intent?.replaceExisting ? {} : { ...(existing?.patches ?? {}) };
  const previous = current[scheduleId];
  current[scheduleId] = patch == null
    ? null
    : previous && typeof previous === "object"
      ? { ...previous, ...patch }
      : { ...patch };
  const trade = state.trades.find((candidate) => candidate.tradeId === tradeId);
  const observedReturnDone = !!trade && (trade.returnDone || trade.contractStatus === "반납완료");
  const entry: ReturnCountOutboxEntry = {
    version: RETURN_COUNT_OUTBOX_VERSION,
    createdAt: intent?.createdAt ?? existing?.createdAt ?? Date.now(),
    observedReturnDone: intent?.observedReturnDone ?? existing?.observedReturnDone ?? observedReturnDone,
    observedReturnDoneAt: intent
      ? intent.observedReturnDoneAt
      : existing?.observedReturnDoneAt ??
        (observedReturnDone ? String(trade?.returnDoneAt || "").trim() || null : null),
    reopenMutationId: intent?.reopenMutationId ?? existing?.reopenMutationId ?? "",
    patches: current,
  };
  outbox[tradeId] = entry;
  returnCountOutboxMemory.set(tradeId, entry);
  writeReturnCountOutbox(outbox);
}

/** 성공한 subfield만 지운다. 전송 중 들어온 더 최신 값은 outbox에 남긴다. */
function acknowledgeReturnCountOutboxBatch(tradeId: string, batch: Record<string, ReturnCountPatch>): void {
  const outbox = readReturnCountOutbox();
  const entry = outbox[tradeId] ?? returnCountOutboxMemory.get(tradeId);
  if (!entry) return;
  const current = { ...entry.patches };
  for (const [scheduleId, sent] of Object.entries(batch)) {
    const latest = current[scheduleId];
    if (sent == null) {
      if (latest == null) delete current[scheduleId];
      continue;
    }
    if (!latest || typeof latest !== "object") continue;
    const remaining = { ...latest } as Partial<ReturnCount>;
    for (const [field, value] of Object.entries(sent)) {
      if ((latest as Record<string, unknown>)[field] === value) {
        delete (remaining as Record<string, unknown>)[field];
      }
    }
    if (Object.keys(remaining).length) current[scheduleId] = remaining;
    else delete current[scheduleId];
  }
  if (!Object.keys(current).length) {
    delete outbox[tradeId];
    returnCountOutboxMemory.delete(tradeId);
  } else {
    const nextEntry = { ...entry, version: RETURN_COUNT_OUTBOX_VERSION, patches: current };
    outbox[tradeId] = nextEntry;
    returnCountOutboxMemory.set(tradeId, nextEntry);
  }
  writeReturnCountOutbox(outbox);
}

/** 확정 거절된 subfield만 메모리 target에서도 제거한다. 더 최신 입력은 그대로 둔다. */
function acknowledgeReturnCountTargetBatch_(tradeId: string, batch: Record<string, ReturnCountPatch>): void {
  const current = returnCountPersistTargets[tradeId];
  if (!current) return;
  for (const [scheduleId, sent] of Object.entries(batch)) {
    const latest = current[scheduleId];
    if (sent == null) {
      if (latest == null) delete current[scheduleId];
      continue;
    }
    if (!latest || typeof latest !== "object") continue;
    const remaining = { ...latest } as Partial<ReturnCount>;
    for (const [field, value] of Object.entries(sent)) {
      if ((latest as Record<string, unknown>)[field] === value) {
        delete (remaining as Record<string, unknown>)[field];
      }
    }
    if (Object.keys(remaining).length) current[scheduleId] = remaining;
    else delete current[scheduleId];
  }
  if (!Object.keys(current).length) delete returnCountPersistTargets[tradeId];
}

/** 다른 직원의 반납완료 CAS가 먼저 이긴 경우에는 전송 중 생성된 더 최신 로컬 입력도
 * 자동 재오픈하지 않는다. 해당 거래의 보존 큐를 전부 폐기하고 서버 정본을 다시 받는다. */
function discardAllReturnCountTargets_(tradeId: string): void {
  delete returnCountPersistTargets[tradeId];
  delete returnCountPersistRetryAttempts[tradeId];
  if (returnCountPersistTimers[tradeId]) clearTimeout(returnCountPersistTimers[tradeId]);
  delete returnCountPersistTimers[tradeId];
  if (returnCountOutboxResumeTimers[tradeId]) clearTimeout(returnCountOutboxResumeTimers[tradeId]);
  delete returnCountOutboxResumeTimers[tradeId];
  const outbox = readReturnCountOutbox();
  if (outbox[tradeId]) {
    delete outbox[tradeId];
    writeReturnCountOutbox(outbox);
  }
  returnCountOutboxMemory.delete(tradeId);
}

/** 다른 기기에서 확정한 반납완료보다 오래된 오프라인 수량은 자동 재오픈 권한이 없다.
 * 완료 화면을 실제로 본 뒤 시작한 새 입력만 동일 완료 시각에 한해 재오픈할 수 있다. */
function isReturnCountOutboxSupersededByCompletion_(entry: ReturnCountOutboxEntry, trade: Trade): boolean {
  if (!(trade.returnDone || trade.contractStatus === "반납완료")) return false;
  const currentDoneAt = String(trade.returnDoneAt || "").trim();
  const completedAtMs = currentDoneAt ? Date.parse(currentDoneAt) : 0;
  if (completedAtMs > 0 && (!entry.createdAt || entry.createdAt <= completedAtMs)) return true;
  if (!entry.observedReturnDone) return true;
  const observedDoneAt = String(entry.observedReturnDoneAt || "").trim();
  if (currentDoneAt) {
    const observedAtMs = observedDoneAt ? Date.parse(observedDoneAt) : 0;
    const sameCompletion = completedAtMs > 0 && observedAtMs > 0
      ? completedAtMs === observedAtMs
      : observedDoneAt === currentDoneAt;
    if (!sameCompletion) return true;
  }
  if (!currentDoneAt && observedDoneAt) return true;
  return false;
}

function convergeAfterDiscardedReturnCountOutbox_(tradeId: string): void {
  discardAllReturnCountTargets_(tradeId);
  void fetchTradesByIds([tradeId]).then(([serverTrade]) => {
    if (serverTrade && !hasReturnCountTargets(tradeId)) {
      set({ trades: mergeTradeChanges(state.trades, [serverTrade]) });
    }
  }).catch(() => {});
}

function ensureReturnCountReopenMutationId_(tradeId: string, entry: ReturnCountOutboxEntry): string {
  if (entry.reopenMutationId) return entry.reopenMutationId;
  const reopenMutationId = createLedgerMutationId("return-reopen");
  const nextEntry = { ...entry, version: RETURN_COUNT_OUTBOX_VERSION, reopenMutationId };
  const outbox = readReturnCountOutbox();
  outbox[tradeId] = nextEntry;
  returnCountOutboxMemory.set(tradeId, nextEntry);
  writeReturnCountOutbox(outbox);
  return reopenMutationId;
}

async function reopenReturnForCountMutation(
  tradeId: string,
  expectedReturnDoneAt: string | null,
  mutationId: string,
): Promise<void> {
  if (!writeBackEnabled) throw new Error(writeBackDisabledReason);
  const res = await gasMutationRetrying("toggleReturn", {
    tid: tradeId,
    done: false,
    mutationId: mutationId || createLedgerMutationId("return-reopen"),
    enforceExpectedReturnDoneAt: true,
    expectedReturnDoneAt: String(expectedReturnDoneAt || ""),
  });
  const confirmedDone = typeof res?.returnDone === "boolean" ? res.returnDone : false;
  if (confirmedDone) throw new ReturnCompletionConflictError(tradeId);
  const contractStatus = String(res?.contractStatus || "반출") as Trade["contractStatus"];
  mutateTrade(tradeId, (t) => ({
    ...t,
    returnDone: false,
    returnDoneAt: null,
    contractStatus,
  }), false);
}

function resumeDurableReturnCountOutbox_(tradeId: string, attempt = 0): void {
  if (!hasReturnCountTargets(tradeId)) {
    if (returnCountOutboxResumeTimers[tradeId]) clearTimeout(returnCountOutboxResumeTimers[tradeId]);
    delete returnCountOutboxResumeTimers[tradeId];
    return;
  }
  const trade = state.trades.find((candidate) => candidate.tradeId === tradeId);
  if (!trade) return;
  const durableEntry = readReturnCountOutbox()[tradeId] ?? returnCountOutboxMemory.get(tradeId);
  if (
    (trade.returnDone || trade.contractStatus === "반납완료") &&
    (!durableEntry || isReturnCountOutboxSupersededByCompletion_(durableEntry, trade))
  ) {
    convergeAfterDiscardedReturnCountOutbox_(tradeId);
    set({
      toast: {
        id: ++toastSeq,
        text: "⚠️ 다른 직원의 반납완료가 더 최신이라 이전 오프라인 수량 입력을 폐기했습니다",
        kind: "error",
      },
    });
    return;
  }
  if (!trade.returnDone && trade.contractStatus !== "반납완료") {
    if (returnCountOutboxResumeTimers[tradeId]) clearTimeout(returnCountOutboxResumeTimers[tradeId]);
    delete returnCountOutboxResumeTimers[tradeId];
    armReturnCountsPersist(tradeId, 0);
    return;
  }
  if (activeTradeTransitions.has(tradeId)) {
    if (returnCountOutboxResumeTimers[tradeId]) clearTimeout(returnCountOutboxResumeTimers[tradeId]);
    returnCountOutboxResumeTimers[tradeId] = setTimeout(
      () => resumeDurableReturnCountOutbox_(tradeId, attempt + 1),
      Math.min(2_000 * 2 ** Math.min(attempt, 4), 30_000),
    );
    return;
  }
  const saveId = beginTradeTransition(tradeId);
  returnCountSaveTokens[tradeId] = [...(returnCountSaveTokens[tradeId] ?? []), saveId];
  const reopenMutationId = ensureReturnCountReopenMutationId_(tradeId, durableEntry!);
  void reopenReturnForCountMutation(
    tradeId,
    durableEntry!.observedReturnDoneAt,
    reopenMutationId,
  ).then(() => {
    delete returnCountOutboxResumeTimers[tradeId];
    armReturnCountsPersist(tradeId, 0);
  }).catch((error) => {
    const tokens = returnCountSaveTokens[tradeId] ?? [];
    returnCountSaveTokens[tradeId] = tokens.filter((token) => token !== saveId);
    const message = error instanceof Error ? error.message : String(error);
    finishTradeSave(tradeId, saveId, "error", `⚠️ 보존된 반납 수량 재개 실패 — ${message}`);
    if (isRetryableLedgerError(error)) {
      returnCountOutboxResumeTimers[tradeId] = setTimeout(
        () => resumeDurableReturnCountOutbox_(tradeId, attempt + 1),
        Math.min(2_000 * 2 ** Math.min(attempt, 4), 30_000),
      );
    } else {
      // 확정 거절은 다음 실행마다 같은 poison outbox를 재생하지 않는다. 보존 목표를 폐기하고
      // 서버 정본을 다시 읽어 카드가 실제 완료 상태로 수렴하게 한다.
      discardAllReturnCountTargets_(tradeId);
      void fetchTradesByIds([tradeId]).then(([serverTrade]) => {
        if (serverTrade && !hasReturnCountTargets(tradeId)) {
          set({ trades: mergeTradeChanges(state.trades, [serverTrade]) });
        }
      }).catch(() => {});
    }
  });
}

/** 반납 수량은 바뀐 scheduleId만 CAS 병합한다. 같은 거래의 일반 저장과 순서를 공유한다. */
function enqueueReturnCountsPersist(tradeId: string): Promise<Trade> {
  const fallback = state.trades.find((t) => t.tradeId === tradeId);
  if (!fallback) return Promise.reject(new Error("반납 수량을 저장할 거래를 찾을 수 없습니다"));
  const previous = persistInFlight[tradeId];
  const task = (previous ?? Promise.resolve(fallback))
    .catch(() => fallback)
    .then(async () => {
      while (hasReturnCountTargets(tradeId)) {
        const batch = returnCountPersistTargets[tradeId] ?? {};
        returnCountPersistTargets[tradeId] = {};
        try {
          await persistReturnCounts(tradeId, batch);
          acknowledgeReturnCountOutboxBatch(tradeId, batch);
        } catch (error) {
          if (error instanceof ReturnCompletionConflictError) {
            // 이 batch가 출발한 뒤 다른 직원이 완료한 것이므로, 전송 중 생긴 새 입력까지
            // 모두 폐기한다. 일부만 남기면 현 세션에서 고아가 됐다가 다음 실행에 완료 거래를
            // 예고 없이 다시 여는 더 위험한 순서 역전이 생긴다.
            discardAllReturnCountTargets_(tradeId);
            throw error;
          }
          // 전송 중 같은 품목을 다시 눌렀다면 최신 target이 이기고, 그 외 실패 batch는 복원한다.
          returnCountPersistTargets[tradeId] = mergeReturnCountPatchBatches(
            batch,
            returnCountPersistTargets[tradeId] ?? {},
          );
          throw error;
        }
      }
      delete returnCountPersistRetryAttempts[tradeId];
      finishReturnCountSaves(tradeId, "saved", "반납 수량 저장됨");
      return state.trades.find((t) => t.tradeId === tradeId) ?? fallback;
    });
  persistInFlight[tradeId] = task;
  returnCountPersistInFlight[tradeId] = task;
  const clear = () => {
    if (persistInFlight[tradeId] === task) delete persistInFlight[tradeId];
    if (returnCountPersistInFlight[tradeId] === task) delete returnCountPersistInFlight[tradeId];
    if (!returnCountPersistTimers[tradeId] && !returnCountPersistInFlight[tradeId] && !hasReturnCountTargets(tradeId)) {
      pendingReturnCountTrades.delete(tradeId);
    }
    maybeResumeRealtimeFlush();
  };
  void task.then(clear, clear);
  return task;
}

function scheduleReturnCountsRetry_(tradeId: string): void {
  if (!hasReturnCountTargets(tradeId)) return;
  const attempt = returnCountPersistRetryAttempts[tradeId] ?? 0;
  returnCountPersistRetryAttempts[tradeId] = attempt + 1;
  const delay = Math.min(1_500 * 2 ** Math.min(attempt, 5), 30_000);
  armReturnCountsPersist(tradeId, delay);
}

function armReturnCountsPersist(tradeId: string, delay: number): void {
  pendingReturnCountTrades.add(tradeId);
  if (returnCountPersistTimers[tradeId]) clearTimeout(returnCountPersistTimers[tradeId]);
  returnCountPersistTimers[tradeId] = setTimeout(() => {
    delete returnCountPersistTimers[tradeId];
    void enqueueReturnCountsPersist(tradeId).catch(async (error) => {
      console.error("[supabase] 반납 수량 저장 실패", error);
      if (error instanceof ReturnCompletionConflictError) {
        delete returnCountPersistRetryAttempts[tradeId];
        try {
          const [serverTrade] = await fetchTradesByIds([tradeId]);
          if (serverTrade && !hasReturnCountTargets(tradeId)) {
            set({ trades: mergeTradeChanges(state.trades, [serverTrade]) });
          }
        } catch {}
        set({ toast: { id: ++toastSeq, text: "⚠️ 다른 직원이 반납완료했습니다 — 최신 상태를 불러왔으니 다시 확인해주세요", kind: "error" } });
        finishReturnCountSaves(tradeId, "error", "⚠️ 다른 직원의 반납완료가 먼저 반영됐습니다");
        return;
      }
      const hadVisibleSave = (returnCountSaveTokens[tradeId]?.length ?? 0) > 0;
      finishReturnCountSaves(tradeId, "error", "⚠️ 반납 수량 저장 지연 — 자동 재시도 중");
      if (!hadVisibleSave) {
        set({ toast: { id: ++toastSeq, text: "⚠️ 반납 수량 저장 지연 — 자동 재시도 중", kind: "error" } });
      }
      scheduleReturnCountsRetry_(tradeId);
    });
  }, delay);
}

function scheduleReturnCountsPersist(tradeId: string, scheduleId?: string, count?: Partial<ReturnCount>): void {
  if (scheduleId && count) {
    // 새 사용자 입력은 오래 기다리던 재시도보다 우선한다.
    returnCountPersistRetryAttempts[tradeId] = 0;
    const currentTarget = returnCountPersistTargets[tradeId] ?? {};
    const previous = currentTarget[scheduleId];
    const nextPatch = previous && typeof previous === "object" ? { ...previous, ...count } : { ...count };
    putReturnCountOutboxPatch(tradeId, scheduleId, count);
    returnCountPersistTargets[tradeId] = {
      ...currentTarget,
      [scheduleId]: nextPatch,
    };
  }
  armReturnCountsPersist(tradeId, 120);
}

async function flushReturnCountsPersist(tradeId: string): Promise<Trade> {
  pendingReturnCountTrades.add(tradeId);
  if (returnCountPersistTimers[tradeId]) clearTimeout(returnCountPersistTimers[tradeId]);
  delete returnCountPersistTimers[tradeId];
  try {
    return await enqueueReturnCountsPersist(tradeId);
  } catch (error) {
    // 완료/수량변경의 즉시 drain도 실패 batch를 복원했으면 재시도 타이머를 반드시 건다.
    // 그렇지 않으면 pending 플래그만 영구히 남아 이 거래의 realtime/full-resync가 멈춘다.
    scheduleReturnCountsRetry_(tradeId);
    throw error;
  } finally {
    if (!returnCountPersistTimers[tradeId] && !returnCountPersistInFlight[tradeId] && !hasReturnCountTargets(tradeId)) {
      pendingReturnCountTrades.delete(tradeId);
    }
  }
}

/** 장비명/수량 변경으로 무효가 된 반납 상세 키도 전체 스냅샷 대신 같은 CAS 큐에서 제거한다. */
async function clearReturnCountsPersist(tradeId: string, scheduleIds: string[]): Promise<void> {
  const uniqueIds = [...new Set(scheduleIds.map((id) => String(id || "").trim()).filter(Boolean))];
  if (!isSupabase || !uniqueIds.length) return;
  const removals = Object.fromEntries(uniqueIds.map((id) => [id, null])) as Record<string, null>;
  uniqueIds.forEach((id) => putReturnCountOutboxPatch(tradeId, id, null));
  returnCountPersistTargets[tradeId] = {
    ...(returnCountPersistTargets[tradeId] ?? {}),
    ...removals,
  };
  await flushReturnCountsPersist(tradeId);
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
  state = {
    date,
    trades: d.trades,
    notes: d.notes,
    savingTrades: {},
    remoteStatus: "ready",
    toast: null,
    photoQueueSummary: state.photoQueueSummary,
  };
  emit();
}

function flashSave(tradeId?: string) {
  // 이 토스트는 즉시 반영 피드백일 뿐 실제 원장 작업 잠금이 아니다. 과거에는 420ms 타이머가
  // 뒤늦게 시작한 반출/반납완료의 savingTrades까지 지워 연속 탭이 동시에 서버로 나갔다.
  if (tradeId && state.savingTrades[tradeId]) return;
  const id = ++toastSeq;
  set({ toast: { id, text: "반영 중…", kind: "saving" } });
  if (typeof window === "undefined") return;
  window.setTimeout(() => {
    if (state.toast?.id !== id) return;
    set({ toast: { id, text: "반영됨", kind: "saved" } });
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
const activeTradeSaveTokens = new Map<string, Set<number>>();
const activeTradeTransitions = new Set<string>();
const tradeTransitionSaveIds = new Set<number>();

type CompletionMutationKind = "setup" | "return";
type CompletionMutationOutboxEntry = {
  kind: CompletionMutationKind;
  tradeId: string;
  target: boolean;
  mutationId: string;
  force?: boolean;
  /** 기준선 없음 확인을 근거로 한 force — 재전송에서도 서버가 정본 기준선을 재검증하게 한다 */
  autoForce?: boolean;
  optimisticDoneAt: string | null;
  createdAt: number;
  attempts: number;
};

const COMPLETION_MUTATION_OUTBOX_KEY = "heybilly:completion-mutation-outbox:v1";
// 서버 멱등 로그(30분)보다 먼저 재생을 끝낸다. 그 뒤에는 같은 옛 목표를 새 명령으로
// 되살리지 않고 정본 재조회만 수행한다.
const COMPLETION_MUTATION_OUTBOX_TTL_MS = 25 * 60 * 1000;
const completionMutationReplayTimers: Record<string, number | undefined> = {};
const completionMutationReplayInFlight = new Set<string>();

function completionMutationOutboxEntryKey(kind: CompletionMutationKind, tradeId: string): string {
  return `${kind}|${tradeId}`;
}

function readCompletionMutationOutbox(): Record<string, CompletionMutationOutboxEntry> {
  if (typeof window === "undefined") return {};
  try {
    const parsed = JSON.parse(window.localStorage.getItem(COMPLETION_MUTATION_OUTBOX_KEY) || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const safe: Record<string, CompletionMutationOutboxEntry> = {};
    for (const [key, raw] of Object.entries(parsed as Record<string, unknown>)) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const entry = raw as Partial<CompletionMutationOutboxEntry>;
      const kind = entry.kind === "setup" || entry.kind === "return" ? entry.kind : null;
      const tradeId = String(entry.tradeId || "").trim();
      const mutationId = String(entry.mutationId || "").trim();
      if (!kind || !tradeId || !mutationId || typeof entry.target !== "boolean") continue;
      safe[key] = {
        kind,
        tradeId,
        target: entry.target,
        mutationId,
        force: !!entry.force,
        autoForce: !!entry.autoForce,
        optimisticDoneAt: entry.optimisticDoneAt ? String(entry.optimisticDoneAt) : null,
        createdAt: Number(entry.createdAt || 0) || Date.now(),
        attempts: Math.max(0, Number(entry.attempts || 0) || 0),
      };
    }
    return safe;
  } catch {
    return {};
  }
}

function writeCompletionMutationOutbox(outbox: Record<string, CompletionMutationOutboxEntry>): void {
  if (typeof window === "undefined") return;
  try {
    if (Object.keys(outbox).length) {
      window.localStorage.setItem(COMPLETION_MUTATION_OUTBOX_KEY, JSON.stringify(outbox));
    } else {
      window.localStorage.removeItem(COMPLETION_MUTATION_OUTBOX_KEY);
    }
  } catch { /* private mode/quota: 현재 탭의 메모리 재시도는 계속 동작 */ }
}

function putCompletionMutationOutbox(entry: CompletionMutationOutboxEntry): void {
  const outbox = readCompletionMutationOutbox();
  outbox[completionMutationOutboxEntryKey(entry.kind, entry.tradeId)] = entry;
  writeCompletionMutationOutbox(outbox);
}

function acknowledgeCompletionMutationOutbox(
  kind: CompletionMutationKind,
  tradeId: string,
  mutationId: string,
): void {
  const key = completionMutationOutboxEntryKey(kind, tradeId);
  const outbox = readCompletionMutationOutbox();
  if (!outbox[key] || outbox[key].mutationId !== mutationId) return;
  delete outbox[key];
  writeCompletionMutationOutbox(outbox);
  if (completionMutationReplayTimers[key]) clearTimeout(completionMutationReplayTimers[key]);
  delete completionMutationReplayTimers[key];
}

function updateCompletionMutationOutboxAttempts(entry: CompletionMutationOutboxEntry, attempts: number): void {
  const key = completionMutationOutboxEntryKey(entry.kind, entry.tradeId);
  const outbox = readCompletionMutationOutbox();
  if (!outbox[key] || outbox[key].mutationId !== entry.mutationId) return;
  outbox[key] = { ...outbox[key], attempts };
  writeCompletionMutationOutbox(outbox);
}

function requireCompletionMutationResult_(
  res: unknown,
  field: "setupDone" | "returnDone",
): Record<string, unknown> {
  if (!res || typeof res !== "object" || Array.isArray(res) || typeof (res as Record<string, unknown>)[field] !== "boolean") {
    // HTTP 2xx/JSON만으로 실행 완료를 추정하지 않는다. 응답 스키마가 불완전하면 서버가
    // 커밋했을 수도 있으므로 결과미확정으로 분류해 같은 mutationId로 재확인한다.
    throw new GasMutationError(`GAS ${field} 확정 응답이 없습니다`, true, true);
  }
  return res as Record<string, unknown>;
}

function beginTradeSave(tradeId: string): number {
  const id = ++toastSeq;
  const tokens = activeTradeSaveTokens.get(tradeId) ?? new Set<number>();
  tokens.add(id);
  activeTradeSaveTokens.set(tradeId, tokens);
  set({ savingTrades: { ...state.savingTrades, [tradeId]: true }, toast: { id, text: "저장 중…", kind: "saving" } });
  return id;
}

function beginTradeTransition(tradeId: string): number {
  activeTradeTransitions.add(tradeId);
  const id = beginTradeSave(tradeId);
  tradeTransitionSaveIds.add(id);
  return id;
}

/** 완료 전환·장비 제외처럼 순서가 뒤집히면 위험한 짧은 구간만 카드 명령을 막는다.
 * 수량/품목의 백그라운드 재시도는 정본 수렴 blocker로만 남고 카드 전체를 영구 잠그지 않는다. */
export function isTradeMutationActive(tradeId: string): boolean {
  return activeTradeTransitions.has(tradeId) || pendingRemoveEquipmentTrades.has(tradeId);
}

function finishTradeSave(tradeId: string, id: number, kind: "saved" | "error", text: string) {
  if (tradeTransitionSaveIds.delete(id)) activeTradeTransitions.delete(tradeId);
  const tokens = activeTradeSaveTokens.get(tradeId);
  if (!tokens || !tokens.has(id)) return;
  tokens.delete(id);
  const saving = { ...state.savingTrades };
  if (tokens.size === 0) {
    activeTradeSaveTokens.delete(tradeId);
    delete saving[tradeId];
    set({ savingTrades: saving, toast: { id, text, kind } });
  } else {
    // 먼저 끝난 작업이 뒤에 남은 작업의 spinner/잠금을 해제하거나 성공 토스트로 덮지 않는다.
    set({ savingTrades: saving });
  }
  maybeResumeRealtimeFlush();
  if (tokens.size > 0) return;
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
  mutationId: string,
  attempt = 1,
): void {
  if (typeof window === "undefined") return;
  if (setupOutcomeRetryTimers[tradeId]) window.clearTimeout(setupOutcomeRetryTimers[tradeId]);
  const delay = Math.min(800 * (2 ** (attempt - 1)), 10_000);
  setupOutcomeRetryTimers[tradeId] = window.setTimeout(async () => {
    delete setupOutcomeRetryTimers[tradeId];
    try {
      const res = await gasMutation("toggleSetup", { tid: tradeId, done, mutationId });
      requireCompletionMutationResult_(res, "setupDone");
      const confirmedDone = typeof res?.setupDone === "boolean" ? res.setupDone : done;
      const doneAt = confirmedDone ? String(res?.setupDoneAt || res?.doneAt || optimisticDoneAt) : null;
      mutateTrade(tradeId, (t) => ({ ...t, setupDone: confirmedDone, setupDoneAt: doneAt }), false);
      acknowledgeCompletionMutationOutbox("setup", tradeId, mutationId);
      finishTradeSave(tradeId, saveId, "saved", "저장됨");
    } catch (error) {
      // 최초 요청의 응답을 잃은 뒤에는 재시도 오류만으로 최초 미커밋을 증명할 수 없다.
      // Supabase 권한 필드가 목표값이면 완료하고, 아니면 같은 멱등 요청을 계속 재확인한다.
      try {
        const confirmed = await fetchSetupCompletion(tradeId);
        if (confirmed.done === done) {
          mutateTrade(tradeId, (t) => ({ ...t, setupDone: done, setupDoneAt: confirmed.doneAt }), false);
          acknowledgeCompletionMutationOutbox("setup", tradeId, mutationId);
          finishTradeSave(tradeId, saveId, "saved", "저장됨");
          return;
        }
        if (attempt >= SETUP_OUTCOME_MAX_ATTEMPTS) {
          // 원장이 끝내 목표값을 확정하지 않음 — 서버 확정값으로 되돌리고 재시도 가능하게 락 해제
          mutateTrade(tradeId, (t) => ({ ...t, setupDone: confirmed.done, setupDoneAt: confirmed.doneAt }), false);
          acknowledgeCompletionMutationOutbox("setup", tradeId, mutationId);
          finishTradeSave(tradeId, saveId, "error", "⚠️ 반출완료가 원장에 확정되지 않았습니다 — 다시 시도해주세요");
          return;
        }
      } catch (confirmError) {
        console.error("[supabase] 반출완료 결과 재확인 실패:", confirmError);
        if (attempt >= SETUP_OUTCOME_MAX_ATTEMPTS) {
          // 확인조차 불가(장기 오프라인 등) — 카드 잠금은 풀되 영구 outbox는 남겨
          // 온라인 복귀/새로고침 뒤 같은 mutationId로 이어서 확정한다.
          finishTradeSave(tradeId, saveId, "error", "⚠️ 반출완료 결과를 확인하지 못했습니다 — 자동 재확인 중");
          scheduleCompletionMutationReplay_("setup", tradeId, 30_000);
          return;
        }
      }
      console.error("[write-back] 반출완료 결과 미확정 재시도:", error);
      queueSetupOutcomeRetry(tradeId, done, optimisticDoneAt, saveId, mutationId, attempt + 1);
    }
  }, delay);
}

function mutateTrade(tradeId: string, fn: (t: Trade) => Trade, persist = true) {
  markLocalMutation(tradeId);
  let changed: Trade | undefined;
  let before: Trade | undefined;
  const trades = state.trades.map((t) => {
    if (t.tradeId !== tradeId) return t;
    before = t;
    changed = fn(t);
    return changed;
  });
  if (!isSupabase) cache[state.date] = { trades, notes: state.notes };
  set({ trades });
  if (changed && persist) schedulePersistTrade(changed, before);
}
function mapItem(t: Trade, scheduleId: string, fn: (e: Trade["equipments"][number]) => Trade["equipments"][number]): Trade {
  return { ...t, equipments: t.equipments.map((e) => (e.scheduleId === scheduleId ? fn(e) : e)) };
}

type ItemMetadataPatch = Record<string, string | number | boolean | null>;
type ItemMetadataOutboxEntry = {
  tradeId: string;
  scheduleId: string;
  patch: ItemMetadataPatch;
  createdAt: number;
};
type ItemMetadataOutbox = Record<string, ItemMetadataOutboxEntry>;

const ITEM_METADATA_OUTBOX_KEY = "heybilly:item-metadata-outbox:v1";

function readItemMetadataOutbox_(): ItemMetadataOutbox {
  if (typeof window === "undefined") return {};
  try {
    const parsed = JSON.parse(window.localStorage.getItem(ITEM_METADATA_OUTBOX_KEY) || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const outbox: ItemMetadataOutbox = {};
    for (const [key, raw] of Object.entries(parsed as Record<string, unknown>)) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const entry = raw as Partial<ItemMetadataOutboxEntry>;
      const tradeId = String(entry.tradeId || "").trim();
      const scheduleId = String(entry.scheduleId || "").trim();
      const patch = entry.patch && typeof entry.patch === "object" && !Array.isArray(entry.patch)
        ? entry.patch as ItemMetadataPatch
        : {};
      if (!tradeId || !scheduleId || !Object.keys(patch).length) continue;
      outbox[key] = { tradeId, scheduleId, patch, createdAt: Math.max(0, Number(entry.createdAt) || 0) };
    }
    return outbox;
  } catch {
    return {};
  }
}

function writeItemMetadataOutbox_(outbox: ItemMetadataOutbox): void {
  if (typeof window === "undefined") return;
  try {
    if (Object.keys(outbox).length) window.localStorage.setItem(ITEM_METADATA_OUTBOX_KEY, JSON.stringify(outbox));
    else window.localStorage.removeItem(ITEM_METADATA_OUTBOX_KEY);
  } catch {
    // localStorage가 막혀도 현재 온라인 저장 경로는 계속 동작한다.
  }
}

function putItemMetadataOutboxPatch_(tradeId: string, scheduleId: string, patch: ItemMetadataPatch): void {
  if (!Object.keys(patch).length) return;
  const key = `${tradeId}|${scheduleId}`;
  const outbox = readItemMetadataOutbox_();
  const previous = outbox[key];
  outbox[key] = {
    tradeId,
    scheduleId,
    patch: { ...(previous?.patch ?? {}), ...patch },
    createdAt: previous?.createdAt || Date.now(),
  };
  writeItemMetadataOutbox_(outbox);
}

/** 전송 중 더 최신 입력이 들어왔으면 성공한 필드만 제거하고 최신 목표값은 보존한다. */
function acknowledgeItemMetadataOutboxPatch_(tradeId: string, scheduleId: string, saved: ItemMetadataPatch): void {
  const key = `${tradeId}|${scheduleId}`;
  const outbox = readItemMetadataOutbox_();
  const current = outbox[key];
  if (!current) return;
  const remaining = { ...current.patch };
  for (const [field, value] of Object.entries(saved)) {
    if (Object.is(remaining[field], value)) delete remaining[field];
  }
  if (Object.keys(remaining).length) outbox[key] = { ...current, patch: remaining };
  else delete outbox[key];
  writeItemMetadataOutbox_(outbox);
}

const itemMetadataPatchTargets: Record<string, ItemMetadataPatch | undefined> = {};
const itemMetadataPatchInFlight: Record<string, Promise<void> | undefined> = {};
const itemMetadataPatchRetryTimers: Record<string, ReturnType<typeof setTimeout> | undefined> = {};
const itemMetadataPatchRetryAttempts: Record<string, number | undefined> = {};

function hasItemMetadataPatchPending_(tradeId: string, scheduleId: string): boolean {
  const key = `${tradeId}|${scheduleId}`;
  return !!itemMetadataPatchTargets[key] || !!itemMetadataPatchInFlight[key] || !!itemMetadataPatchRetryTimers[key];
}

/** 앱 전용 품목 열은 품목별 병합 큐로 부분 저장해 다른 직원의 장비 snapshot을 덮지 않는다. */
function queueItemMetadataPatch(
  tradeId: string,
  scheduleId: string,
  patch: ItemMetadataPatch,
): void {
  if (!isSupabase) return;
  const key = `${tradeId}|${scheduleId}`;
  const isNewUserPatch = Object.keys(patch).length > 0;
  if (isNewUserPatch) putItemMetadataOutboxPatch_(tradeId, scheduleId, patch);
  itemMetadataPatchTargets[key] = { ...(itemMetadataPatchTargets[key] ?? {}), ...patch };
  if (isNewUserPatch) itemMetadataPatchRetryAttempts[key] = 0;
  if (itemMetadataPatchRetryTimers[key]) {
    clearTimeout(itemMetadataPatchRetryTimers[key]);
    delete itemMetadataPatchRetryTimers[key];
  }
  if (itemMetadataPatchInFlight[key]) return;
  const task = (async () => {
    while (itemMetadataPatchTargets[key]) {
      const target = itemMetadataPatchTargets[key]!;
      delete itemMetadataPatchTargets[key];
      try {
        await persistScheduleItemPatch(tradeId, scheduleId, target);
        acknowledgeItemMetadataOutboxPatch_(tradeId, scheduleId, target);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/품목 저장 대상이 없습니다/.test(message)) {
          // 다른 직원의 장비 제외가 먼저 끝난 terminal 상태다. 삭제된 행 patch를 영구
          // 재시도하면 그 거래의 realtime 수렴과 다음 카드 동작이 끝없이 막힌다.
          acknowledgeItemMetadataOutboxPatch_(tradeId, scheduleId, target);
          delete itemMetadataPatchTargets[key];
          delete itemMetadataPatchRetryAttempts[key];
          showTransientError("⚠️ 이미 제외된 품목의 보조 입력은 저장하지 않았습니다");
          void reconcileRemovedEquipmentCanonical_(tradeId);
          break;
        }
        itemMetadataPatchTargets[key] = { ...target, ...(itemMetadataPatchTargets[key] ?? {}) };
        const attempt = (itemMetadataPatchRetryAttempts[key] ?? 0) + 1;
        itemMetadataPatchRetryAttempts[key] = attempt;
        if (attempt === 1) showTransientError(`⚠️ 품목 저장 실패 — 자동 재시도 중: ${message}`);
        break;
      }
    }
  })();
  itemMetadataPatchInFlight[key] = task;
  void task.finally(() => {
    if (itemMetadataPatchInFlight[key] === task) {
      delete itemMetadataPatchInFlight[key];
      if (itemMetadataPatchTargets[key]) {
        const attempt = Math.max(1, itemMetadataPatchRetryAttempts[key] ?? 1);
        const delay = Math.min(30_000, 1_000 * 2 ** Math.min(attempt - 1, 5));
        itemMetadataPatchRetryTimers[key] = setTimeout(() => {
          delete itemMetadataPatchRetryTimers[key];
          queueItemMetadataPatch(tradeId, scheduleId, {});
        }, delay);
      } else delete itemMetadataPatchRetryAttempts[key];
    }
    maybeResumeRealtimeFlush();
  });
}

function replayItemMetadataOutbox_(initialDelay = 0): void {
  if (typeof window === "undefined" || !isSupabase) return;
  Object.values(readItemMetadataOutbox_()).forEach((entry, index) => {
    const key = `${entry.tradeId}|${entry.scheduleId}`;
    itemMetadataPatchTargets[key] = { ...entry.patch, ...(itemMetadataPatchTargets[key] ?? {}) };
    window.setTimeout(
      () => queueItemMetadataPatch(entry.tradeId, entry.scheduleId, {}),
      initialDelay + index * 120,
    );
  });
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
  }, false);
  flashSave(tradeId);
}

type RemoveEquipmentOutboxEntry = {
  tradeId: string;
  scheduleId: string;
  equipName: string;
  mutationId: string;
  createdAt: number;
  attempts: number;
};

const REMOVE_EQUIPMENT_OUTBOX_KEY = "heybilly:remove-equipment-outbox:v1";
const removeEquipmentReplayTimers: Record<string, number | undefined> = {};
const removeEquipmentReplayInFlight = new Set<string>();
const pendingRemoveEquipmentTrades = new Set<string>();
const removeEquipmentOutboxMemory = new Map<string, RemoveEquipmentOutboxEntry>();

function removeEquipmentOutboxKey_(tradeId: string, scheduleId: string): string {
  return `${tradeId}|${scheduleId}`;
}

function readRemoveEquipmentOutbox_(): Record<string, RemoveEquipmentOutboxEntry> {
  if (typeof window === "undefined") return {};
  try {
    const parsed = JSON.parse(window.localStorage.getItem(REMOVE_EQUIPMENT_OUTBOX_KEY) || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeRemoveEquipmentOutbox_(outbox: Record<string, RemoveEquipmentOutboxEntry>): void {
  if (typeof window === "undefined") return;
  try {
    if (Object.keys(outbox).length) window.localStorage.setItem(REMOVE_EQUIPMENT_OUTBOX_KEY, JSON.stringify(outbox));
    else window.localStorage.removeItem(REMOVE_EQUIPMENT_OUTBOX_KEY);
  } catch { /* 현재 탭의 재시도는 계속 동작 */ }
}

function putRemoveEquipmentOutbox_(entry: RemoveEquipmentOutboxEntry): void {
  const outbox = readRemoveEquipmentOutbox_();
  const key = removeEquipmentOutboxKey_(entry.tradeId, entry.scheduleId);
  outbox[key] = entry;
  removeEquipmentOutboxMemory.set(key, entry);
  writeRemoveEquipmentOutbox_(outbox);
  pendingRemoveEquipmentTrades.add(entry.tradeId);
}

function acknowledgeRemoveEquipmentOutbox_(entry: RemoveEquipmentOutboxEntry): void {
  const key = removeEquipmentOutboxKey_(entry.tradeId, entry.scheduleId);
  const outbox = readRemoveEquipmentOutbox_();
  const current = outbox[key] || removeEquipmentOutboxMemory.get(key);
  if (!current || current.mutationId !== entry.mutationId) return;
  delete outbox[key];
  if (removeEquipmentOutboxMemory.get(key)?.mutationId === entry.mutationId) {
    removeEquipmentOutboxMemory.delete(key);
  }
  writeRemoveEquipmentOutbox_(outbox);
  if (
    !Object.values(outbox).some((candidate) => candidate.tradeId === entry.tradeId) &&
    !Array.from(removeEquipmentOutboxMemory.values()).some((candidate) => candidate.tradeId === entry.tradeId)
  ) {
    pendingRemoveEquipmentTrades.delete(entry.tradeId);
  }
  if (removeEquipmentReplayTimers[key]) clearTimeout(removeEquipmentReplayTimers[key]);
  delete removeEquipmentReplayTimers[key];
}

function scheduleRemoveEquipmentReplay_(entry: RemoveEquipmentOutboxEntry, delay: number): void {
  if (typeof window === "undefined") return;
  const key = removeEquipmentOutboxKey_(entry.tradeId, entry.scheduleId);
  if (removeEquipmentReplayTimers[key]) clearTimeout(removeEquipmentReplayTimers[key]);
  removeEquipmentReplayTimers[key] = window.setTimeout(() => {
    delete removeEquipmentReplayTimers[key];
    const latest = readRemoveEquipmentOutbox_()[key] || removeEquipmentOutboxMemory.get(key);
    if (latest) void replayRemoveEquipmentMutation_(latest);
  }, delay);
}

async function reconcileRemovedEquipmentCanonical_(tradeId: string): Promise<void> {
  try {
    const [serverTrade] = await fetchTradesByIds([tradeId]);
    if (serverTrade && !isTradeMutationActive(tradeId)) {
      set({ trades: mergeTradeChanges(state.trades, [serverTrade]) });
    }
  } catch {
    if (typeof window !== "undefined") {
      window.setTimeout(() => void pollSheetChangesNow({ mode: "light", resetBackoff: false }), 2_000);
    }
  }
}

async function commitRemoveEquipmentMutation_(
  entry: RemoveEquipmentOutboxEntry,
  saveId: number,
  originalItem?: EquipmentItem,
): Promise<void> {
  const key = removeEquipmentOutboxKey_(entry.tradeId, entry.scheduleId);
  removeEquipmentReplayInFlight.add(key);
  try {
    const res = await gasMutationRetrying("removeEquip", {
      tid: entry.tradeId,
      scheduleId: entry.scheduleId,
      equipName: entry.equipName,
      mutationId: entry.mutationId,
      directRegenerate: false,
    });
    const confirmed = unwrapContractMutation(res);
    const confirmedIds = Array.isArray(confirmed.removedScheduleIds)
      ? confirmed.removedScheduleIds.map((id) => String(id || "").trim())
      : [];
    if (confirmed.success !== true || !confirmedIds.includes(entry.scheduleId)) {
      // fallback scheduleId는 UI 적용 편의일 뿐 서버 삭제 증거가 아니다. 불완전 2xx를
      // 성공으로 ACK하지 않고 동일 mutationId로 재확인한다.
      throw new GasMutationError("GAS 장비 제외 확정 응답이 없습니다", true, true);
    }
    applyContractMutationResult(entry.tradeId, res, [entry.scheduleId]);
    acknowledgeRemoveEquipmentOutbox_(entry);
    // removed_at 투영이 늦는 동안 realtime 에코/새로고침이 이 품목을 되살리지 않게 한다
    // (장비명을 함께 기록 — 번호가 재사용된 다른 장비는 숨기지 않는다)
    recordExcludedItemTombstone_(entry.tradeId, entry.scheduleId, entry.equipName);
    finishTradeSave(entry.tradeId, saveId, "saved", "장비 제외 저장됨");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[write-back] removeEquip 실패:", error);
    if (isRetryableLedgerError(error)) {
      const attempts = entry.attempts + 1;
      const latest = { ...entry, attempts };
      putRemoveEquipmentOutbox_(latest);
      finishTradeSave(entry.tradeId, saveId, "error", "⚠️ 장비 제외 저장 지연 — 자동 재확인 중");
      scheduleRemoveEquipmentReplay_(latest, Math.min(2_000 * 2 ** Math.min(attempts, 4), 30_000));
      return;
    }
    acknowledgeRemoveEquipmentOutbox_(entry);
    const canonicalAlreadyMissing = /행 없음|비어있음|already removed/i.test(message);
    if (originalItem && !canonicalAlreadyMissing) {
      restoreRemovedItem(entry.tradeId, originalItem, "장비 제외 실패: " + message);
    }
    finishTradeSave(entry.tradeId, saveId, "error", `⚠️ 장비 제외 실패 — ${message}`);
    if (!originalItem || canonicalAlreadyMissing) await reconcileRemovedEquipmentCanonical_(entry.tradeId);
  } finally {
    removeEquipmentReplayInFlight.delete(key);
  }
}

async function replayRemoveEquipmentMutation_(entry: RemoveEquipmentOutboxEntry): Promise<void> {
  const key = removeEquipmentOutboxKey_(entry.tradeId, entry.scheduleId);
  const latest = readRemoveEquipmentOutbox_()[key] || removeEquipmentOutboxMemory.get(key);
  if (!latest || latest.mutationId !== entry.mutationId || removeEquipmentReplayInFlight.has(key)) return;
  if (Date.now() - latest.createdAt >= COMPLETION_MUTATION_OUTBOX_TTL_MS) {
    acknowledgeRemoveEquipmentOutbox_(latest);
    await reconcileRemovedEquipmentCanonical_(latest.tradeId);
    showTransientError("⚠️ 장비 제외 자동 확인 시간이 지나 최신 원장 상태를 불러왔습니다");
    return;
  }
  if (
    activeTradeTransitions.has(latest.tradeId) ||
    hasTradePendingExcludingRemove_(latest.tradeId) ||
    hasItemMetadataPatchPending_(latest.tradeId, latest.scheduleId)
  ) {
    scheduleRemoveEquipmentReplay_(latest, 2_000);
    return;
  }
  const trade = state.trades.find((candidate) => candidate.tradeId === latest.tradeId);
  if (!trade) {
    scheduleRemoveEquipmentReplay_(latest, 10_000);
    return;
  }
  const saveId = beginTradeTransition(latest.tradeId);
  mutateTrade(latest.tradeId, (candidate) => ({
    ...candidate,
    equipments: candidate.equipments.filter((item) => item.scheduleId !== latest.scheduleId),
    contractRegenPending: true,
  }), false);
  await commitRemoveEquipmentMutation_(latest, saveId);
}

function replayRemoveEquipmentOutbox_(initialDelay = 0): void {
  if (typeof window === "undefined" || !isSupabase || !writeBackEnabled) return;
  const merged = new Map<string, RemoveEquipmentOutboxEntry>(removeEquipmentOutboxMemory);
  Object.entries(readRemoveEquipmentOutbox_()).forEach(([key, entry]) => merged.set(key, entry));
  let index = 0;
  merged.forEach((entry) => {
    removeEquipmentOutboxMemory.set(removeEquipmentOutboxKey_(entry.tradeId, entry.scheduleId), entry);
    pendingRemoveEquipmentTrades.add(entry.tradeId);
    scheduleRemoveEquipmentReplay_(entry, initialDelay + index++ * 350);
  });
}

function removeEquipmentAndRegenerateContract(tradeId: string, item: EquipmentItem) {
  if (activeTradeTransitions.has(tradeId) || pendingRemoveEquipmentTrades.has(tradeId)) {
    showTransientError("⚠️ 이 거래의 다른 변경을 저장 중입니다. 잠시 후 다시 시도해주세요");
    return;
  }
  const saveId = beginTradeTransition(tradeId);
  const scheduleId = item.scheduleId;
  const entry: RemoveEquipmentOutboxEntry = {
    tradeId,
    scheduleId,
    equipName: item.name,
    mutationId: createLedgerMutationId("remove"),
    createdAt: Date.now(),
    attempts: 0,
  };
  putRemoveEquipmentOutbox_(entry);
  mutateTrade(tradeId, (t) => ({
    ...t,
    equipments: t.equipments.filter((e) => e.scheduleId !== scheduleId),
    contractRegenPending: true,
  }), false);
  flashSave(tradeId);

  // 계약서 재생성은 백그라운드 워커(디바운스)에 맡긴다 — 인라인 재생성은 GAS 잠금을
  // 수 초~수십 초 쥐어 다른 체크/버튼을 실패시키고 제외 응답 자체도 느리게 했다.
  // 새 링크는 contractRegenPending 배지 → 폴링 merge로 곧 반영된다.
  void commitRemoveEquipmentMutation_(entry, saveId, item);
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
  /** 편집 시작 시점 스냅샷(JSON) — 서버 CAS로 다른 직원의 선행 수정 덮어쓰기를 막는다 */
  expected?: string;
};

/** 고객정보와 예약 일시는 GAS 원장을 먼저 확정한 뒤 앱/Supabase에 반영한다. */
export async function updateTradeDetails(tradeId: string, input: TradeDetailsInput): Promise<{ ok: true; warning?: string } | { ok: false; error: string }> {
  if (activeTradeTransitions.has(tradeId) || hasTradePending(tradeId)) {
    return { ok: false, error: "이 거래의 다른 변경을 저장 중입니다. 잠시 후 다시 시도해주세요" };
  }
  if (isSupabase && !writeBackEnabled) {
    return { ok: false, error: `예약 편집 실패: ${writeBackDisabledReason}` };
  }
  const saveId = beginTradeTransition(tradeId);
  let ledgerCommitted = false;
  try {
    const res = await gasMutationRetrying("updateTrade", { tid: tradeId, ...input });
    if (res?.skipped) throw new Error(writeBackDisabledReason);
    ledgerCommitted = true;
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
    if (ledgerCommitted) {
      finishTradeSave(tradeId, saveId, "error", "⚠️ 원장 수정은 완료됐고 앱 동기화를 자동 재시도 중입니다");
      return { ok: true, warning: message };
    }
    finishTradeSave(tradeId, saveId, "error", `⚠️ 예약 편집 실패 — ${message}`);
    return { ok: false, error: message };
  }
}

/** 취소는 거래 이력을 남기고 스케줄 점유만 제거한다. */
export async function cancelTrade(tradeId: string): Promise<{ ok: true; warning?: string } | { ok: false; error: string }> {
  if (activeTradeTransitions.has(tradeId) || hasTradePending(tradeId)) {
    return { ok: false, error: "이 거래의 다른 변경을 저장 중입니다. 잠시 후 다시 시도해주세요" };
  }
  if (isSupabase && !writeBackEnabled) {
    return { ok: false, error: `예약 취소 실패: ${writeBackDisabledReason}` };
  }
  const current = state.trades.find((trade) => trade.tradeId === tradeId);
  if (current && isCheckoutBaselineLocked(current)) {
    return { ok: false, error: "이미 반출된 거래는 취소할 수 없습니다. 반납 절차로 마감해주세요" };
  }
  const saveId = beginTradeTransition(tradeId);
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
  if (activeTradeTransitions.has(tradeId) || pendingRemoveEquipmentTrades.has(tradeId)) {
    const error = pendingRemoveEquipmentTrades.has(tradeId)
      ? "장비 제외를 원장에 확정 중입니다. 완료 후 반출처리해주세요"
      : "반출 상태 변경이 이미 진행 중입니다";
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

  const saveId = beginTradeTransition(tradeId);
  const mutationId = createLedgerMutationId("setup");
  const optimisticDoneAt = done ? new Date().toISOString() : null;
  let setupRequestStarted = false;
  putCompletionMutationOutbox({
    kind: "setup",
    tradeId,
    target: done,
    mutationId,
    optimisticDoneAt,
    createdAt: Date.now(),
    attempts: 0,
  });
  // 버튼은 즉시 완료 상태로 바꾼다. persist=false라 GAS 기준선보다 먼저 원격 저장되지는 않는다.
  mutateTrade(tradeId, (t) => ({ ...t, setupDone: done, setupDoneAt: optimisticDoneAt }), false);
  try {
    if (done) {
      // 품목 체크·수량 스테퍼의 debounce/latest-target을 모두 먼저 확정한다. 사용자가 마지막
      // 품목을 누른 직후 완료를 눌러도 기준선 고정 명령이 앞질러 갈 수 없다.
      await Promise.all([
        flushItemCheckWritesForTrade(tradeId),
        flushQueuedItemQtyForTrade(tradeId),
      ]);
    }
    // 화면은 즉시 반응하지만, 내구 상태는 GAS가 기준선과 Supabase 완료값을 함께 확정한다.
    setupRequestStarted = true;
    const res = await gasMutation("toggleSetup", { tid: tradeId, done, mutationId });
    requireCompletionMutationResult_(res, "setupDone");
    const confirmedDone = typeof res?.setupDone === "boolean" ? res.setupDone : done;
    const doneAt = confirmedDone ? String(res?.setupDoneAt || res?.doneAt || optimisticDoneAt) : null;
    mutateTrade(tradeId, (t) => ({ ...t, setupDone: confirmedDone, setupDoneAt: doneAt }), false);
    acknowledgeCompletionMutationOutbox("setup", tradeId, mutationId);
    finishTradeSave(tradeId, saveId, "saved", "저장됨");
    return { ok: true };
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    console.error("[write-back] toggleSetup 실패:", e);
    if (setupRequestStarted && isGasOutcomeUnknownError(e)) {
      // GAS가 저장을 끝낸 뒤 응답만 40초 제한에 걸릴 수 있다. 결과 미확정은 완료 표시와
      // 저장 중 보호를 유지한 채 같은 목표 상태를 재시도하고, 절대 즉시 롤백하지 않는다.
      const warning = `반출완료는 표시됐고 서버 응답을 다시 확인 중입니다 — ${detail}`;
      set({ toast: { id: saveId, text: `⚠️ ${warning}`, kind: "saving" } });
      queueSetupOutcomeRetry(tradeId, done, optimisticDoneAt, saveId, mutationId);
      return { ok: true, warning };
    }
    if (setupRequestStarted && isRetryableLedgerError(e)) {
      // 잠금/lease 경합(BUSY)이 인라인 재시도 한도를 넘긴 경우 — 실패가 아니라 지연이다.
      // 낙관 표시와 outbox를 유지하고 내구 재생으로 넘긴다. (기존: 즉시 롤백 →
      // 몇 초 뒤 완료 표시가 풀려 직원이 이미 자리를 뜬 경우 기록이 사라졌다.)
      finishTradeSave(tradeId, saveId, "error", "⚠️ 반출완료 저장 지연 — 자동 재시도 중");
      scheduleCompletionMutationReplay_("setup", tradeId, 3_000);
      return { ok: true, warning: detail };
    }
    // GAS는 기준선과 Supabase 완료값을 모두 저장해야 성공을 반환하므로, 실패 때만 되돌린다.
    acknowledgeCompletionMutationOutbox("setup", tradeId, mutationId);
    mutateTrade(tradeId, (t) => ({ ...t, setupDone: previousDone, setupDoneAt: previousDoneAt }), false);
    finishTradeSave(tradeId, saveId, "error", `⚠️ 반출 상태 변경 실패 — ${detail}`);
    return { ok: false, error: detail };
  }
}
export type ToggleReturnResult =
  | { ok: true; blockers: []; warning?: string }
  | { ok: false; blockers: ReturnCompletionBlocker[]; error: string; needsBaselineConfirm?: boolean };

export async function toggleReturn(tradeId: string, opts?: { force?: boolean }): Promise<ToggleReturnResult> {
  if (activeTradeTransitions.has(tradeId) || pendingRemoveEquipmentTrades.has(tradeId)) {
    return {
      ok: false,
      blockers: [],
      error: pendingRemoveEquipmentTrades.has(tradeId)
        ? "장비 제외를 원장에 확정 중입니다. 완료 후 반납처리해주세요"
        : "반납 상태 변경이 이미 진행 중입니다",
    };
  }
  const current = state.trades.find((t) => t.tradeId === tradeId);
  if (!current) return { ok: false, blockers: [], error: "거래를 찾을 수 없습니다" };

  const on = !current.returnDone;
  // 반출완료를 누르지 못했거나 과거 데이터라 taken_qty 기준선이 없는 거래도 현장에서
  // 반납완료할 수 있어야 한다 — 단, 조용한 자동 우회가 아니라 작업자 확인을 거친다.
  // (과거: 기준선 없음 → 확인 다이얼로그 없이 force 자동 전송 → 서버의 모든 반납
  //  검증이 우회되어 수량 검수 없이 거래가 닫혔다.)
  const hasCheckoutBaseline = current.equipments.some(
    (item) => Number(item.takenQty ?? 0) > 0 || item.actualTakenQty != null,
  );
  if (on && !hasCheckoutBaseline && !opts?.force) {
    return {
      ok: false,
      blockers: [],
      error: "반출 기준선(수량 검수 기록)이 없는 거래입니다 — 확인 후 반납완료해주세요",
      needsBaselineConfirm: true,
    };
  }
  const force = !!opts?.force;
  const blockers = on && !force ? returnCompletionBlockers(current) : [];
  if (blockers.length > 0) {
    // 강제 차단하지 않는다 — 호출부(카드)가 미확인 내역을 보여주고 작업자 확인 후
    // force로 재호출한다. 카드는 완료 전까지 계속 살아있으므로 묻힘 방지는 가시성(알림)이 담당.
    const missing = blockers.reduce((sum, b) => sum + b.missing, 0);
    const over = blockers.reduce((sum, b) => sum + b.over, 0);
    const detail = missing > 0 ? `미확인 ${missing}개` : `초과 ${over}개`;
    const error = `반납 미확인 품목 — ${detail}`;
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
  const saveId = beginTradeTransition(tradeId);
  const mutationId = createLedgerMutationId("return");
  const previous = {
    returnDone: current.returnDone,
    returnDoneAt: current.returnDoneAt ?? null,
    contractStatus: current.contractStatus,
  };
  const optimisticReturnDoneAt = on ? new Date().toISOString() : null;
  let returnRequestStarted = false;
  putCompletionMutationOutbox({
    kind: "return",
    tradeId,
    target: on,
    mutationId,
    force,
    autoForce: force && !hasCheckoutBaseline,
    optimisticDoneAt: optimisticReturnDoneAt,
    createdAt: Date.now(),
    attempts: 0,
  });
  // 버튼은 즉시 완료 상태로 바뀐다(반출완료와 같은 낙관 패턴). 원장 확정은 뒤에서 진행하고,
  // 명확한 거절일 때만 되돌린다. persist=false — GAS 확정 전에 원격 저장하지 않는다.
  mutateTrade(tradeId, (t) => ({
    ...t,
    returnDone: on,
    returnDoneAt: optimisticReturnDoneAt,
    contractStatus: on ? "반납완료" : "반출",
  }), false);
  try {
    // 장비 수량 스테퍼의 350ms target이 반납완료 뒤늦게 실행되어 완료 거래를 다시 여는
    // 순서 역전을 막는다. transition guard가 이 drain 이후 새 수량 입력도 차단한다.
    if (isSupabase) await flushQueuedItemQtyForTrade(tradeId);
    // 품목별 정상/파손/분실 상세가 먼저 내구 저장되어야 한다. 이것이 실패한 상태에서
    // 거래를 닫으면 GAS의 이진 체크만 남아 상세 사실이 사라질 수 있으므로 완료 전에 저장한다.
    if (on && isSupabase) {
      const persisted = await flushReturnCountsPersist(tradeId);
      if (!force) {
        const refreshedBlockers = returnCompletionBlockers(persisted);
        if (refreshedBlockers.length > 0) {
          const missing = refreshedBlockers.reduce((sum, b) => sum + b.missing, 0);
          const over = refreshedBlockers.reduce((sum, b) => sum + b.over, 0);
          const detail = missing > 0 ? `미확인 ${missing}개` : `초과 ${over}개`;
          const error = `반납 미확인 품목 — ${detail}`;
          mutateTrade(tradeId, (t) =>
            t.contractStatus === "취소" || t.returnDone !== on ? t : { ...t, ...previous },
          false);
          acknowledgeCompletionMutationOutbox("return", tradeId, mutationId);
          finishTradeSave(tradeId, saveId, "error", `⚠️ ${error}`);
          return { ok: false, blockers: refreshedBlockers, error };
        }
      }
    }
    // 계약서 재생성 워커 등과의 잠금 경합은 짧은 재시도로 흡수한다(확정 거절은 즉시 실패).
    returnRequestStarted = true;
    const res = await gasMutationRetrying("toggleReturn", {
      tid: tradeId,
      done: on,
      mutationId,
      ...(force ? { force: 1 } : {}),
      // 기준선 없음을 근거로 한 force는 서버가 Supabase 정본을 재검증한다(낡은 화면 방지)
      ...(force && !hasCheckoutBaseline ? { autoForce: 1 } : {}),
    });
    requireCompletionMutationResult_(res, "returnDone");
    const confirmedDone = typeof res?.returnDone === "boolean" ? res.returnDone : on;
    const contractStatus = String(res?.contractStatus || (confirmedDone ? "반납완료" : "반출")) as Trade["contractStatus"];
    const doneAt = confirmedDone ? String(res?.returnDoneAt || res?.doneAt || optimisticReturnDoneAt || "") : null;
    mutateTrade(tradeId, (t) => ({
      ...t,
      returnDone: confirmedDone,
      returnDoneAt: doneAt,
      contractStatus: res.contractStatus || contractStatus,
    }), false);
    acknowledgeCompletionMutationOutbox("return", tradeId, mutationId);
    finishTradeSave(
      tradeId,
      saveId,
      "saved",
      confirmedDone ? (force ? "반납완료 처리됨 — 미확인 내역은 기록에 남아있어요" : "반납완료 저장됨") : "저장됨",
    );
    return { ok: true, blockers: [] };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.error("[write-back] toggleReturn 실패:", e);
    if (returnRequestStarted && isGasOutcomeUnknownError(e)) {
      // 응답만 유실됐을 수 있다 — 표시를 되돌리지 않고 같은 목표 상태를 백그라운드 재확인한다.
      set({ toast: { id: saveId, text: "⚠️ 반납완료는 표시됐고 서버 응답을 다시 확인 중입니다", kind: "saving" } });
      queueReturnOutcomeRetry(tradeId, on, force, optimisticReturnDoneAt, saveId, mutationId, 1, force && !hasCheckoutBaseline);
      return { ok: true, blockers: [] };
    }
    if (returnRequestStarted && isRetryableLedgerError(e)) {
      // 잠금/lease 경합(BUSY)이 인라인 재시도 한도를 넘긴 경우 — 실패가 아니라 지연이다.
      // 낙관 표시와 outbox를 유지하고 내구 재생으로 넘긴다. (기존: 즉시 롤백 →
      // 완료된 줄 알고 자리를 뜬 직원의 반납 기록이 사라졌다.)
      finishTradeSave(tradeId, saveId, "error", "⚠️ 반납완료 저장 지연 — 자동 재시도 중");
      scheduleCompletionMutationReplay_("return", tradeId, 3_000);
      return { ok: true, blockers: [] };
    }
    // 명확한 거절 — 즉시 표시를 원래 상태로 되돌린다.
    acknowledgeCompletionMutationOutbox("return", tradeId, mutationId);
    mutateTrade(tradeId, (t) =>
      t.contractStatus === "취소" || t.returnDone !== on ? t : { ...t, ...previous },
    false);
    finishTradeSave(tradeId, saveId, "error", `⚠️ 반납 상태 변경 실패 — ${error}`);
    return { ok: false, blockers: [], error };
  }
}

/** 응답 유실된 반납완료를 멱등 재시도로 확정한다(반출완료 queueSetupOutcomeRetry와 동일 패턴). */
const RETURN_OUTCOME_MAX_ATTEMPTS = 8;
const returnOutcomeRetryTimers: Record<string, number | undefined> = {};

function queueReturnOutcomeRetry(
  tradeId: string,
  on: boolean,
  force: boolean,
  optimisticDoneAt: string | null,
  saveId: number,
  mutationId: string,
  attempt = 1,
  autoForce = false,
): void {
  if (typeof window === "undefined") return;
  if (returnOutcomeRetryTimers[tradeId]) window.clearTimeout(returnOutcomeRetryTimers[tradeId]);
  const delay = Math.min(1_000 * 2 ** (attempt - 1), 15_000);
  returnOutcomeRetryTimers[tradeId] = window.setTimeout(async () => {
    delete returnOutcomeRetryTimers[tradeId];
    try {
      const res = await gasMutation("toggleReturn", {
        tid: tradeId,
        done: on,
        mutationId,
        ...(force ? { force: 1 } : {}),
        ...(force && autoForce ? { autoForce: 1 } : {}),
      });
      requireCompletionMutationResult_(res, "returnDone");
      const confirmedDone = typeof res?.returnDone === "boolean" ? res.returnDone : on;
      const contractStatus = String(res?.contractStatus || (confirmedDone ? "반납완료" : "반출")) as Trade["contractStatus"];
      const doneAt = confirmedDone ? String(res?.returnDoneAt || res?.doneAt || optimisticDoneAt || "") : null;
      mutateTrade(tradeId, (t) => ({ ...t, returnDone: confirmedDone, returnDoneAt: doneAt, contractStatus }), false);
      acknowledgeCompletionMutationOutbox("return", tradeId, mutationId);
      finishTradeSave(tradeId, saveId, "saved", confirmedDone ? "반납완료 저장됨" : "저장됨");
    } catch (error) {
      if (attempt < RETURN_OUTCOME_MAX_ATTEMPTS && isRetryableLedgerError(error)) {
        queueReturnOutcomeRetry(tradeId, on, force, optimisticDoneAt, saveId, mutationId, attempt + 1, autoForce);
        return;
      }
      console.error("[write-back] 반납완료 결과 미확정:", error);
      if (!isRetryableLedgerError(error)) {
        // 명확한 거절만 outbox에서 제거한다. 원격 정본을 다시 읽어 낙관 표시도 수렴시킨다.
        acknowledgeCompletionMutationOutbox("return", tradeId, mutationId);
        finishTradeSave(tradeId, saveId, "error", "⚠️ 반납완료가 원장에서 거절됐습니다 — 최신 상태를 불러옵니다");
        void reconcileCompletionMutationCanonical_(tradeId);
        return;
      }
      // 최초 요청이 커밋된 뒤 응답만 유실됐을 가능성이 끝까지 남는다. 이전 로컬 값으로
      // 맹목 롤백하지 않고 영구 outbox로 같은 ID를 계속 재확인한다.
      finishTradeSave(tradeId, saveId, "error", "⚠️ 반납완료 원장 응답을 확인하지 못했습니다 — 자동 재확인 중");
      scheduleCompletionMutationReplay_("return", tradeId, 30_000);
    }
  }, delay);
}

// ── 품목 체크 원장 쓰기 신뢰화 ──────────────────────────────────
// toggleItem은 파이어-앤-포겟이라 제외/현장추가(계약서 재생성)의 긴 GAS 잠금과 겹치면
// Lock timeout으로 죽고, 재시도가 없어 시트가 앱과 조용히 어긋났다.
// 품목 단위 목표 상태(최신 승자)로 직렬화하고 일시 오류만 백오프 재시도한다.
const ITEM_CHECK_RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 30_000];
const itemCheckTargets: Record<string, boolean | undefined> = {};
const itemCheckMutationIds: Record<string, string | undefined> = {};
const itemCheckInFlight: Record<string, Promise<void> | undefined> = {};
const itemCheckRetryTimers: Record<string, ReturnType<typeof setTimeout> | undefined> = {};
const itemCheckAttempts: Record<string, number> = {};
const itemCheckTerminalErrors: Record<string, Error | undefined> = {};
const itemCheckConfirmedValues: Record<string, boolean | undefined> = {};
const itemCheckReconcileTimers: Record<string, ReturnType<typeof setTimeout> | undefined> = {};
const itemCheckReconcileGenerations: Record<string, number> = {};
const itemCheckBatchTimers: Record<string, ReturnType<typeof setTimeout> | undefined> = {};
const itemCheckTradeInFlight: Record<string, Promise<void> | undefined> = {};
const ITEM_CHECK_BATCH_DEBOUNCE_MS = 150;
const ITEM_CHECK_OUTBOX_KEY = "heybilly:item-check-outbox:v1";

type ItemCheckOutboxEntry = {
  tradeId: string;
  scheduleId: string;
  done: boolean;
  mutationId: string;
};

function readItemCheckOutbox(): Record<string, ItemCheckOutboxEntry> {
  if (typeof window === "undefined") return {};
  try {
    const parsed = JSON.parse(window.localStorage.getItem(ITEM_CHECK_OUTBOX_KEY) || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeItemCheckOutbox(outbox: Record<string, ItemCheckOutboxEntry>): void {
  if (typeof window === "undefined") return;
  try {
    if (Object.keys(outbox).length) window.localStorage.setItem(ITEM_CHECK_OUTBOX_KEY, JSON.stringify(outbox));
    else window.localStorage.removeItem(ITEM_CHECK_OUTBOX_KEY);
  } catch { /* localStorage quota/private mode: in-memory queue still works */ }
}

function putItemCheckOutboxTarget(key: string, entry: ItemCheckOutboxEntry): void {
  const outbox = readItemCheckOutbox();
  outbox[key] = entry;
  writeItemCheckOutbox(outbox);
}

function acknowledgeItemCheckOutboxTarget(key: string, done: boolean, mutationId: string): void {
  const outbox = readItemCheckOutbox();
  const current = outbox[key];
  if (!current || current.done !== done || current.mutationId !== mutationId) return;
  delete outbox[key];
  writeItemCheckOutbox(outbox);
}

function armItemCheckBatch(tradeId: string, delay = ITEM_CHECK_BATCH_DEBOUNCE_MS): void {
  if (itemCheckBatchTimers[tradeId]) clearTimeout(itemCheckBatchTimers[tradeId]);
  itemCheckBatchTimers[tradeId] = setTimeout(() => {
    delete itemCheckBatchTimers[tradeId];
    void commitItemCheckBatch(tradeId);
  }, delay);
}

/** 잠금 경합·네트워크 순단처럼 다시 보내면 성공할 오류만 재시도한다.
 *  기준선 차단/행 없음 같은 확정 거절은 즉시 사용자에게 알린다. */
function isRetryableLedgerError(error: unknown): boolean {
  if (isGasOutcomeUnknownError(error)) return true; // 네트워크/5xx/타임아웃
  if (error && typeof error === "object" && "retryable" in error && (error as { retryable?: boolean }).retryable) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /lock|잠시 후 다시|처리 중|network|failed to fetch|timeout|timed out|fetch 실패/i.test(message);
}

/** 사용자 대기형 변이(반납완료·취소·예약편집)의 잠금 경합 흡수 —
 *  저장 스피너를 유지한 채 잠깐 물러났다 재시도한다. 확정 거절은 즉시 던진다. */
async function gasMutationRetrying(
  action: string,
  params: Record<string, string | number | boolean>,
): Promise<any> {
  return gasMutation(action, params);
}

function queueItemCheckWrite(tradeId: string, scheduleId: string, done: boolean, previousDone: boolean): void {
  if (!isSupabase) return;
  const key = `${tradeId}|${scheduleId}`;
  itemCheckReconcileGenerations[key] = (itemCheckReconcileGenerations[key] ?? 0) + 1;
  if (itemCheckReconcileTimers[key]) {
    clearTimeout(itemCheckReconcileTimers[key]);
    delete itemCheckReconcileTimers[key];
  }
  if (itemCheckConfirmedValues[key] === undefined) itemCheckConfirmedValues[key] = previousDone;
  itemCheckTargets[key] = done;
  itemCheckMutationIds[key] = createLedgerMutationId("item");
  putItemCheckOutboxTarget(key, {
    tradeId,
    scheduleId,
    done,
    mutationId: itemCheckMutationIds[key]!,
  });
  itemCheckAttempts[key] = 0;
  delete itemCheckTerminalErrors[key];
  // 새 목표가 들어오면 대기 중이던 재시도를 즉시 선점한다
  if (itemCheckRetryTimers[key]) {
    clearTimeout(itemCheckRetryTimers[key]);
    delete itemCheckRetryTimers[key];
  }
  armItemCheckBatch(tradeId);
}

async function commitItemCheckWrite(tradeId: string, _scheduleId: string, _key: string): Promise<void> {
  if (itemCheckBatchTimers[tradeId]) {
    clearTimeout(itemCheckBatchTimers[tradeId]);
    delete itemCheckBatchTimers[tradeId];
  }
  await commitItemCheckBatch(tradeId);
}

async function commitItemCheckBatch(tradeId: string): Promise<void> {
  const existing = itemCheckTradeInFlight[tradeId];
  if (existing) return existing;
  const prefix = `${tradeId}|`;
  const snapshots = Object.keys(itemCheckTargets)
    .filter((key) => key.startsWith(prefix) && itemCheckTargets[key] !== undefined && !itemCheckRetryTimers[key])
    .map((key) => ({
      key,
      scheduleId: key.slice(prefix.length),
      target: itemCheckTargets[key]!,
      mutationId: itemCheckMutationIds[key] || createLedgerMutationId("item"),
    }));
  if (!snapshots.length) return;

  const task = (async () => {
    let batchError: unknown = null;
    let resultsById = new Map<string, any>();
    try {
      if (!writeBackEnabled) throw new Error(writeBackDisabledReason);
      const res = await gasMutation("toggleItems", {
        tid: tradeId,
        items: JSON.stringify(snapshots.map(({ scheduleId, target, mutationId }) => ({
          scheduleId,
          done: target,
          mutationId,
        }))),
      });
      if (!Array.isArray(res?.results)) throw new Error("GAS 품목 체크 배치 결과가 없습니다");
      resultsById = new Map(res.results.map((result: any) => [String(result?.scheduleId || ""), result]));
    } catch (error) {
      batchError = error;
    }

    for (const snapshot of snapshots) {
      const { key, scheduleId, target, mutationId } = snapshot;
      const result = resultsById.get(scheduleId);
      let error: unknown = batchError;
      if (!error && (!result || result.ok !== true)) {
        const resultError = new Error(String(result?.error || "품목 체크 배치 결과 누락")) as Error & {
          retryable?: boolean;
          outcomeUnknown?: boolean;
        };
        resultError.outcomeUnknown = result?.outcomeUnknown === true;
        resultError.retryable = resultError.outcomeUnknown || result?.retryable === true;
        error = resultError;
      }
      if (!error) {
        const confirmed = typeof result?.checked === "boolean" ? result.checked : target;
        itemCheckConfirmedValues[key] = confirmed;
        acknowledgeItemCheckOutboxTarget(key, target, mutationId);
        if (itemCheckTargets[key] === target && itemCheckMutationIds[key] === mutationId) {
          mutateTrade(tradeId, (t) => mapItem(t, scheduleId, (e) => ({
            ...e,
            checkoutState: confirmed ? "taken" : "pending",
          })), false);
          delete itemCheckTargets[key];
          delete itemCheckMutationIds[key];
          delete itemCheckConfirmedValues[key];
        }
        delete itemCheckAttempts[key];
        delete itemCheckTerminalErrors[key];
        continue;
      }

      // 전송 중 같은 품목을 다시 눌렀다면 옛 요청 오류는 최신 목표와 무관하다.
      if (itemCheckTargets[key] !== target || itemCheckMutationIds[key] !== mutationId) continue;
      const attempt = itemCheckAttempts[key] ?? 0;
      if (isRetryableLedgerError(error)) {
        itemCheckAttempts[key] = attempt + 1;
        const retryDelay = ITEM_CHECK_RETRY_DELAYS_MS[Math.min(attempt, ITEM_CHECK_RETRY_DELAYS_MS.length - 1)] ?? 30_000;
        itemCheckRetryTimers[key] = setTimeout(() => {
          delete itemCheckRetryTimers[key];
          void commitItemCheckBatch(tradeId);
        }, retryDelay);
        if (attempt === ITEM_CHECK_RETRY_DELAYS_MS.length) {
          showTransientError("⚠️ 네트워크가 불안정해 품목 체크를 계속 자동 재시도 중입니다", 6_000);
        }
        continue;
      }

      delete itemCheckTargets[key];
      delete itemCheckMutationIds[key];
      delete itemCheckAttempts[key];
      acknowledgeItemCheckOutboxTarget(key, target, mutationId);
      const message = error instanceof Error ? error.message : String(error);
      const terminalError = error instanceof Error ? error : new Error(message);
      console.error("[write-back] 품목 반출 체크 원장 반영 실패:", error);
      showTransientError(`⚠️ 품목 반출 체크 원장 반영 실패 — ${message}`, 6_000);
      const reconciled = await reconcileItemCheckCanonical(tradeId, scheduleId, key);
      if (!reconciled && itemCheckTargets[key] === undefined) {
        itemCheckTerminalErrors[key] = terminalError;
        scheduleItemCheckCanonicalReconcile(
          tradeId, scheduleId, key, 0, itemCheckReconcileGenerations[key] ?? 0,
        );
      }
    }
  })();

  itemCheckTradeInFlight[tradeId] = task;
  snapshots.forEach(({ key }) => { itemCheckInFlight[key] = task; });
  try {
    await task;
  } finally {
    if (itemCheckTradeInFlight[tradeId] === task) delete itemCheckTradeInFlight[tradeId];
    snapshots.forEach(({ key }) => {
      if (itemCheckInFlight[key] === task) delete itemCheckInFlight[key];
    });
    if (Object.keys(itemCheckTargets).some((key) => key.startsWith(prefix) && !itemCheckRetryTimers[key])) {
      armItemCheckBatch(tradeId, 0);
    }
    maybeResumeRealtimeFlush();
  }
}

async function reconcileItemCheckCanonical(tradeId: string, scheduleId: string, key: string): Promise<boolean> {
  if (itemCheckTargets[key] !== undefined) return false;
  try {
    const [serverTrade] = await fetchTradesByIds([tradeId]);
    const serverItem = serverTrade?.equipments.find((item) => item.scheduleId === scheduleId);
    const canonical = serverItem
      ? serverItem.checkoutState === "taken"
      : itemCheckConfirmedValues[key];
    if (canonical === undefined || itemCheckTargets[key] !== undefined) return false;
    mutateTrade(tradeId, (trade) => mapItem(trade, scheduleId, (item) => ({
      ...item,
      checkoutState: canonical ? "taken" : "pending",
    })), false);
    delete itemCheckTerminalErrors[key];
    delete itemCheckConfirmedValues[key];
    return true;
  } catch {
    return false;
  }
}

function scheduleItemCheckCanonicalReconcile(
  tradeId: string,
  scheduleId: string,
  key: string,
  attempt: number,
  generation: number,
): void {
  const delays = [3_000, 10_000, 30_000];
  if (attempt >= delays.length || typeof window === "undefined") return;
  itemCheckReconcileTimers[key] = setTimeout(async () => {
    delete itemCheckReconcileTimers[key];
    if (itemCheckReconcileGenerations[key] !== generation) return;
    if (itemCheckTargets[key] !== undefined) {
      if (!itemCheckInFlight[key] && !itemCheckRetryTimers[key]) {
        void commitItemCheckWrite(tradeId, scheduleId, key);
      }
      return;
    }
    if (await reconcileItemCheckCanonical(tradeId, scheduleId, key)) return;
    scheduleItemCheckCanonicalReconcile(tradeId, scheduleId, key, attempt + 1, generation);
  }, delays[attempt]);
}

/** 반출완료는 debounce/재시도 중인 품목 목표까지 모두 확정된 뒤에만 기준선을 고정한다. */
async function flushItemCheckWritesForTrade(tradeId: string): Promise<void> {
  const prefix = `${tradeId}|`;
  for (;;) {
    const failed = Object.entries(itemCheckTerminalErrors).find(([key, error]) => key.startsWith(prefix) && !!error);
    if (failed?.[1]) throw failed[1];

    const keys = Object.keys(itemCheckTargets).filter((key) => key.startsWith(prefix));
    if (itemCheckBatchTimers[tradeId]) {
      clearTimeout(itemCheckBatchTimers[tradeId]);
      delete itemCheckBatchTimers[tradeId];
    }
    for (const key of keys) {
      if (itemCheckRetryTimers[key]) {
        clearTimeout(itemCheckRetryTimers[key]);
        delete itemCheckRetryTimers[key];
      }
    }
    if (keys.length && !itemCheckTradeInFlight[tradeId]) void commitItemCheckBatch(tradeId);
    const inFlight = itemCheckTradeInFlight[tradeId] ? [itemCheckTradeInFlight[tradeId]!] : [];
    if (!keys.length && !inFlight.length) return;
    if (inFlight.length) await Promise.all(inFlight);
    else await Promise.resolve();
    const delayedRetry = Object.entries(itemCheckRetryTimers)
      .find(([key, timer]) => key.startsWith(prefix) && !!timer);
    if (delayedRetry) {
      throw new Error("품목 체크 원장 저장을 자동 재시도 중입니다. 잠시 후 반출완료를 다시 눌러주세요");
    }
  }
}

// ── 품목별 반출/반납 상태 ───────────────────────────────────────
export function setItemCheckout(tradeId: string, scheduleId: string, next: CheckoutState) {
  if (activeTradeTransitions.has(tradeId)) {
    // 반출완료는 화면에 즉시 반영되고 품목 버튼도 같은 렌더에서 잠긴다. 렌더 직전의
    // 오래된 클릭 이벤트가 도착해도 다른 화면까지 덮는 전역 오류 토스트는 띄우지 않는다.
    return;
  }
  const currentTrade = state.trades.find((t) => t.tradeId === tradeId);
  const baselineStarted = !!currentTrade && isCheckoutBaselineLocked(currentTrade);
  if (baselineStarted) {
    set({
      toast: {
        id: ++toastSeq,
        text: next === "excluded"
          ? "⚠️ 이미 반출된 품목은 제외할 수 없습니다. 반납 의무가 유지됩니다"
          : "⚠️ 반출 당시 실제 포함 품목 기록은 바꿀 수 없습니다",
        kind: "error",
      },
    });
    return;
  }
  let final: CheckoutState | undefined;
  let previousCheckoutState: CheckoutState | undefined;
  let isSynthetic = false;
  let targetItem: EquipmentItem | undefined;
  mutateTrade(tradeId, (t) =>
    mapItem(t, scheduleId, (e) => {
      previousCheckoutState = e.checkoutState;
      final = e.checkoutState === next ? "pending" : next;
      isSynthetic = !!e.synthetic;
      targetItem = e;
      return { ...e, checkoutState: final };
    }), false,
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
  if (final === "taken") queueItemCheckWrite(tradeId, scheduleId, true, previousCheckoutState === "taken");
  else if (final === "pending") queueItemCheckWrite(tradeId, scheduleId, false, previousCheckoutState === "taken");
  // 원장 쓰기가 꺼져 있으면 제외를 앱 상태로만 숨기지 않는다.
}
export async function setItemName(tradeId: string, scheduleId: string, name: string): Promise<boolean> {
  const clean = name.trim();
  if (!clean) return false;
  if (activeTradeTransitions.has(tradeId) || hasTradePending(tradeId)) {
    showTransientError("⚠️ 이 거래의 다른 변경을 저장 중입니다. 잠시 후 다시 시도해주세요");
    return false;
  }

  if (isSupabase && !writeBackEnabled) {
    showTransientError(`⚠️ 장비명 변경 실패: ${writeBackDisabledReason}`);
    return false;
  }

  let ledgerCommitted = false;
  const saveId = isSupabase ? beginTradeTransition(tradeId) : 0;
  try {
    const res = isSupabase
      ? await gasMutation("updateEquipName", { tid: tradeId, scheduleId, equipName: clean })
      : null;
    if (res?.unchanged) {
      if (isSupabase) finishTradeSave(tradeId, saveId, "saved", "변경 없음");
      return true;
    }
    ledgerCommitted = isSupabase;
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
    if (isSupabase) {
      await clearReturnCountsPersist(tradeId, [...affectedIds]);
      await flushTradePersist(tradeId);
    }
    if (isSupabase) finishTradeSave(tradeId, saveId, "saved", "장비명 저장됨");
    else flashSave(tradeId);
    return true;
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    if (ledgerCommitted) {
      const latest = state.trades.find((t) => t.tradeId === tradeId);
      if (latest) schedulePersistTrade(latest);
      finishTradeSave(tradeId, saveId, "error", `⚠️ 장비명은 원장에 저장됐고 앱 화면 동기화를 재시도 중입니다 — ${error}`);
      return true;
    }
    if (isSupabase) finishTradeSave(tradeId, saveId, "error", `⚠️ 장비명 변경 실패 — ${error}`);
    else showTransientError(`⚠️ 장비명 변경 실패 — ${error}`);
    return false;
  }
}
/** GAS updateEquipQty 응답(updatedItems, 세트 비례 조정 포함)을 로컬 상태에 정본 반영한다. */
function applyEquipQtyResult(tradeId: string, scheduleId: string, safeQty: number, res: any): string[] {
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
  return [...affectedIds];
}

export async function setItemQty(tradeId: string, scheduleId: string, qty: number): Promise<boolean> {
  const safeQty = Math.max(1, Math.round(qty));
  if (activeTradeTransitions.has(tradeId) || hasTradePending(tradeId)) {
    showTransientError("⚠️ 이 거래의 다른 변경을 저장 중입니다. 잠시 후 다시 시도해주세요");
    return false;
  }
  if (isSupabase && !writeBackEnabled) {
    set({ toast: { id: ++toastSeq, text: `⚠️ 수량 변경 실패: ${writeBackDisabledReason}`, kind: "error" } });
    return false;
  }

  let ledgerCommitted = false;
  const saveId = isSupabase ? beginTradeTransition(tradeId) : 0;
  try {
    // 세트 헤더 수량 변경 시 GAS가 구성품 수량을 비례 조정하므로 원장을 먼저 확정한다.
    const res = isSupabase
      ? await gasMutation("updateEquipQty", { tid: tradeId, scheduleId, qty: safeQty })
      : null;
    if (res?.unchanged) {
      if (isSupabase) finishTradeSave(tradeId, saveId, "saved", "변경 없음");
      return true;
    }
    ledgerCommitted = isSupabase;
    const affectedIds = applyEquipQtyResult(tradeId, scheduleId, safeQty, res);
    if (isSupabase) {
      await clearReturnCountsPersist(tradeId, affectedIds);
      await flushTradePersist(tradeId);
    }
    if (isSupabase) finishTradeSave(tradeId, saveId, "saved", "수량 저장됨");
    else flashSave(tradeId);
    return true;
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    if (ledgerCommitted) {
      const latest = state.trades.find((t) => t.tradeId === tradeId);
      if (latest) schedulePersistTrade(latest);
      finishTradeSave(tradeId, saveId, "error", `⚠️ 수량은 원장에 저장됐고 앱 화면 동기화를 재시도 중입니다 — ${error}`);
      return true;
    }
    if (isSupabase) finishTradeSave(tradeId, saveId, "error", `⚠️ 수량 변경 실패 — ${error}`);
    else set({ toast: { id: ++toastSeq, text: `⚠️ 수량 변경 실패 — ${error}`, kind: "error" } });
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
const qtyCommitFailures: Record<string, Error | undefined> = {};
const qtyConfirmedValues: Record<string, number | undefined> = {};
const qtyReconcileTimers: Record<string, ReturnType<typeof setTimeout> | undefined> = {};
const qtyReconcileGenerations: Record<string, number> = {};
const qtyCommitRetryTimers: Record<string, ReturnType<typeof setTimeout> | undefined> = {};
const qtyCommitRetryAttempts: Record<string, number | undefined> = {};
const QTY_COMMIT_DEBOUNCE_MS = 350;
const QTY_COMMIT_RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 30_000];
const QTY_OUTBOX_KEY = "heybilly:item-qty-outbox:v1";

function readQtyOutbox(): Record<string, number> {
  if (typeof window === "undefined") return {};
  try {
    const parsed = JSON.parse(window.localStorage.getItem(QTY_OUTBOX_KEY) || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function putQtyOutboxTarget(key: string, qty: number): void {
  if (typeof window === "undefined") return;
  const outbox = readQtyOutbox();
  outbox[key] = qty;
  try { window.localStorage.setItem(QTY_OUTBOX_KEY, JSON.stringify(outbox)); } catch { /* noop */ }
}

function acknowledgeQtyOutboxTarget(key: string, qty: number): void {
  if (typeof window === "undefined") return;
  const outbox = readQtyOutbox();
  if (outbox[key] !== qty) return;
  delete outbox[key];
  try {
    if (Object.keys(outbox).length) window.localStorage.setItem(QTY_OUTBOX_KEY, JSON.stringify(outbox));
    else window.localStorage.removeItem(QTY_OUTBOX_KEY);
  } catch { /* noop */ }
}

export function queueItemQty(tradeId: string, scheduleId: string, qty: number): void {
  if (activeTradeTransitions.has(tradeId)) {
    showTransientError("⚠️ 완료 상태를 확정 중입니다. 저장이 끝난 뒤 수량을 바꿔주세요");
    return;
  }
  const safeQty = Math.max(1, Math.round(qty));
  if (isSupabase && !writeBackEnabled) {
    set({ toast: { id: ++toastSeq, text: `⚠️ 수량 변경 실패: ${writeBackDisabledReason}`, kind: "error" } });
    return;
  }
  const key = `${tradeId}|${scheduleId}`;
  qtyReconcileGenerations[key] = (qtyReconcileGenerations[key] ?? 0) + 1;
  if (qtyReconcileTimers[key]) {
    clearTimeout(qtyReconcileTimers[key]);
    delete qtyReconcileTimers[key];
  }
  const previousQty = state.trades.find((trade) => trade.tradeId === tradeId)
    ?.equipments.find((item) => item.scheduleId === scheduleId)?.qty;
  if (qtyConfirmedValues[key] === undefined && previousQty !== undefined) {
    qtyConfirmedValues[key] = previousQty;
  }
  // 화면 즉시 반영 (persist=false — 원장 확정 후 flushTradePersist가 저장)
  mutateTrade(tradeId, (t) => mapItem(t, scheduleId, (e) => ({ ...e, qty: safeQty })), false);
  if (!isSupabase) {
    flashSave(tradeId);
    return;
  }
  // debounce/tap 종료보다 먼저 목표값을 내구 기록한다. 모바일 백그라운드 종료나
  // 새로고침 뒤에도 loadRemoteOnce가 같은 최종값을 재생한다.
  putQtyOutboxTarget(key, safeQty);
  qtyCommitTargets[key] = safeQty;
  qtyCommitRetryAttempts[key] = 0;
  delete qtyCommitFailures[key];
  if (qtyCommitRetryTimers[key]) {
    clearTimeout(qtyCommitRetryTimers[key]);
    delete qtyCommitRetryTimers[key];
  }
  if (qtyCommitTimers[key]) clearTimeout(qtyCommitTimers[key]);
  qtyCommitTimers[key] = setTimeout(() => {
    delete qtyCommitTimers[key];
    void commitQueuedItemQty(tradeId, scheduleId, key);
  }, QTY_COMMIT_DEBOUNCE_MS);
}

function armQtyCommitRetry_(tradeId: string, scheduleId: string, key: string): void {
  if (qtyCommitRetryTimers[key]) clearTimeout(qtyCommitRetryTimers[key]);
  const attempt = qtyCommitRetryAttempts[key] ?? 0;
  qtyCommitRetryAttempts[key] = attempt + 1;
  const delay = QTY_COMMIT_RETRY_DELAYS_MS[Math.min(attempt, QTY_COMMIT_RETRY_DELAYS_MS.length - 1)] ?? 30_000;
  qtyCommitRetryTimers[key] = setTimeout(() => {
    delete qtyCommitRetryTimers[key];
    delete qtyCommitFailures[key];
    void commitQueuedItemQty(tradeId, scheduleId, key);
  }, delay);
}

async function commitQueuedItemQty(tradeId: string, scheduleId: string, key: string): Promise<void> {
  if (qtyCommitInFlight[key]) return; // 진행 중이면 완료 후 남은 target을 이어서 커밋
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    // 오프라인엔 실패 토스트 쌍을 만들지 않고 조용히 대기 — online 복귀/다음 재시도가 이어간다
    if (qtyCommitTimers[key]) clearTimeout(qtyCommitTimers[key]);
    qtyCommitTimers[key] = setTimeout(() => {
      delete qtyCommitTimers[key];
      void commitQueuedItemQty(tradeId, scheduleId, key);
    }, 15_000);
    return;
  }
  const target = qtyCommitTargets[key];
  if (target === undefined) return;
  delete qtyCommitTargets[key];
  const saveId = beginTradeSave(tradeId);
  const task = (async () => {
    let ledgerCommitted = false;
    try {
      const res = await gasMutation("updateEquipQty", { tid: tradeId, scheduleId, qty: target });
      ledgerCommitted = true;
      acknowledgeQtyOutboxTarget(key, target);
      qtyConfirmedValues[key] = Number(res?.qty ?? target) || target;
      if (qtyCommitTargets[key] !== undefined) {
        // 전송 중 더 최신 스테퍼 값이 들어왔다. 옛 응답을 로컬/DB에 투영해 3→2→3으로
        // 깜빡이지 않고, 바로 뒤의 최신 target 커밋이 최종 Sheet 응답을 적용한다.
        delete qtyCommitFailures[key];
        finishTradeSave(tradeId, saveId, "saved", "다음 수량 저장 중…");
        return;
      }
      const affectedIds = res?.unchanged ? [] : applyEquipQtyResult(tradeId, scheduleId, target, res);
      await clearReturnCountsPersist(tradeId, affectedIds);
      await flushTradePersist(tradeId);
      delete qtyCommitFailures[key];
      delete qtyCommitRetryAttempts[key];
      if (qtyCommitRetryTimers[key]) {
        clearTimeout(qtyCommitRetryTimers[key]);
        delete qtyCommitRetryTimers[key];
      }
      delete qtyConfirmedValues[key];
      finishTradeSave(tradeId, saveId, "saved", "저장됨");
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      if (ledgerCommitted) {
        delete qtyCommitFailures[key];
        delete qtyConfirmedValues[key];
        const latest = state.trades.find((t) => t.tradeId === tradeId);
        if (latest) schedulePersistTrade(latest);
        console.error("[supabase] 수량 원장 확정 후 앱 투영 재시도:", e);
        finishTradeSave(tradeId, saveId, "error", "⚠️ 수량은 원장에 저장됐고 앱 화면 동기화를 재시도 중입니다");
        return;
      }
      const terminalError = e instanceof Error ? e : new Error(error);
      console.error("[write-back] 수량 변경 실패:", e);
      if (qtyCommitTargets[key] !== undefined) {
        // 전송 중 더 최신 목표가 들어왔다. set 연산이라 최신 값이 이전 결과를 덮어 정본이 된다.
        finishTradeSave(tradeId, saveId, "saved", "최신 수량 저장 중…");
        return;
      }
      if (isRetryableLedgerError(e)) {
        // updateEquipQty는 절대값 set이라 같은 목표를 다시 보내도 안전하다. 응답 유실/일시 장애는
        // 사용자 목표와 outbox를 버리지 않고 거래별 백오프로 계속 수렴시킨다.
        qtyCommitTargets[key] = target;
        qtyCommitFailures[key] = terminalError;
        armQtyCommitRetry_(tradeId, scheduleId, key);
        finishTradeSave(tradeId, saveId, "error", `⚠️ 수량 저장 지연 — 자동 재시도 중 (${error})`);
        return;
      }
      finishTradeSave(tradeId, saveId, "error", `⚠️ 수량 변경 실패 — ${error}`);
      acknowledgeQtyOutboxTarget(key, target);
      delete qtyCommitRetryAttempts[key];
      // own in-flight 때문에 전역 hasPendingPersist()는 항상 true다. 해당 품목만 정본으로
      // 직접 되돌리고, 응답 미확정이면 백그라운드 재조회 동안만 완료 전환을 막는다.
      const reconciled = await reconcileItemQtyCanonical(tradeId, scheduleId, key);
      if (!reconciled && qtyCommitTargets[key] === undefined) {
        qtyCommitFailures[key] = terminalError;
        scheduleItemQtyCanonicalReconcile(
          tradeId, scheduleId, key, 0, qtyReconcileGenerations[key] ?? 0,
        );
      }
    }
  })();
  qtyCommitInFlight[key] = task;
  try {
    await task;
  } finally {
    if (qtyCommitInFlight[key] === task) delete qtyCommitInFlight[key];
    // 커밋 중 새 목표값이 들어왔으면 이어서 전송(직렬화)
    if (qtyCommitTargets[key] !== undefined && !qtyCommitRetryTimers[key]) {
      void commitQueuedItemQty(tradeId, scheduleId, key);
    }
  }
}

async function reconcileItemQtyCanonical(tradeId: string, scheduleId: string, key: string): Promise<boolean> {
  if (qtyCommitTargets[key] !== undefined) return false;
  try {
    const [serverTrade] = await fetchTradesByIds([tradeId]);
    const serverQty = serverTrade?.equipments.find((item) => item.scheduleId === scheduleId)?.qty;
    const canonical = serverQty ?? qtyConfirmedValues[key];
    if (canonical === undefined || qtyCommitTargets[key] !== undefined) return false;
    mutateTrade(tradeId, (trade) => mapItem(trade, scheduleId, (item) => ({ ...item, qty: canonical })), false);
    delete qtyCommitFailures[key];
    delete qtyConfirmedValues[key];
    return true;
  } catch {
    return false;
  }
}

function scheduleItemQtyCanonicalReconcile(
  tradeId: string,
  scheduleId: string,
  key: string,
  attempt: number,
  generation: number,
): void {
  const delays = [3_000, 10_000, 30_000];
  if (attempt >= delays.length || typeof window === "undefined") return;
  qtyReconcileTimers[key] = setTimeout(async () => {
    delete qtyReconcileTimers[key];
    if (qtyReconcileGenerations[key] !== generation) return;
    if (qtyCommitTargets[key] !== undefined) {
      if (!qtyCommitInFlight[key] && !qtyCommitTimers[key]) {
        void commitQueuedItemQty(tradeId, scheduleId, key);
      }
      return;
    }
    if (await reconcileItemQtyCanonical(tradeId, scheduleId, key)) return;
    scheduleItemQtyCanonicalReconcile(tradeId, scheduleId, key, attempt + 1, generation);
  }, delays[attempt]);
}

async function reconcileCompletionMutationCanonical_(tradeId: string): Promise<void> {
  try {
    // fetch 중 들어온 낙관 편집(현장정산·메모 등)을 서버 스냅샷이 되돌리지 않도록
    // 다른 모든 스냅샷 적용 경로와 같은 mutation-seq 게이트를 적용한다.
    const seqAtStart = tradeMutationSeq[tradeId] ?? 0;
    const [serverTrade] = await fetchTradesByIds([tradeId]);
    if (!serverTrade || isTradeMutationActive(tradeId)) return;
    if ((tradeMutationSeq[tradeId] ?? 0) !== seqAtStart || hasTradeSyncPending(tradeId)) {
      // 그 사이 로컬 변경 발생 — realtime 재조회 경로가 최신 상태로 다시 수렴한다
      noteRemoteChange({ table: "trades", tradeId });
      return;
    }
    set({ trades: mergeTradeChanges(state.trades, [serverTrade]) });
  } catch {
    if (typeof window !== "undefined") {
      window.setTimeout(() => void pollSheetChangesNow({ mode: "light", resetBackoff: false }), 2_000);
    }
  }
}

function scheduleCompletionMutationReplay_(
  kind: CompletionMutationKind,
  tradeId: string,
  delay: number,
): void {
  if (typeof window === "undefined") return;
  const key = completionMutationOutboxEntryKey(kind, tradeId);
  if (completionMutationReplayTimers[key]) clearTimeout(completionMutationReplayTimers[key]);
  completionMutationReplayTimers[key] = window.setTimeout(() => {
    delete completionMutationReplayTimers[key];
    const entry = readCompletionMutationOutbox()[key];
    if (entry) void replayCompletionMutationEntry_(entry);
  }, delay);
}

async function replayCompletionMutationEntry_(entry: CompletionMutationOutboxEntry): Promise<void> {
  const key = completionMutationOutboxEntryKey(entry.kind, entry.tradeId);
  const latest = readCompletionMutationOutbox()[key];
  if (!latest || latest.mutationId !== entry.mutationId || completionMutationReplayInFlight.has(key)) return;

  if (Date.now() - latest.createdAt >= COMPLETION_MUTATION_OUTBOX_TTL_MS) {
    // 30분 서버 멱등 로그가 사라지기 전에 옛 명령을 폐기하고 정본만 읽는다. 이 경계 뒤
    // 재전송은 다른 직원이 만든 최신 상태를 과거 목표로 되돌릴 수 있다.
    acknowledgeCompletionMutationOutbox(latest.kind, latest.tradeId, latest.mutationId);
    await reconcileCompletionMutationCanonical_(latest.tradeId);
    showTransientError(`⚠️ ${latest.kind === "setup" ? "반출" : "반납"}완료 자동 확인 시간이 지나 최신 원장 상태를 불러왔습니다`);
    return;
  }

  if (activeTradeTransitions.has(latest.tradeId) || hasTradePending(latest.tradeId)) {
    scheduleCompletionMutationReplay_(latest.kind, latest.tradeId, 2_000);
    return;
  }
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    // 오프라인엔 시도(=실패 토스트 쌍)를 만들지 않고 조용히 대기한다.
    // online 이벤트 리스너가 복귀 즉시 재생을 다시 무장한다.
    scheduleCompletionMutationReplay_(latest.kind, latest.tradeId, 15_000);
    return;
  }
  const current = state.trades.find((trade) => trade.tradeId === latest.tradeId);
  if (!current) {
    scheduleCompletionMutationReplay_(latest.kind, latest.tradeId, 10_000);
    return;
  }

  const saveId = beginTradeTransition(latest.tradeId);
  completionMutationReplayInFlight.add(key);
  if (latest.kind === "setup") {
    mutateTrade(latest.tradeId, (trade) => ({
      ...trade,
      setupDone: latest.target,
      setupDoneAt: latest.target ? latest.optimisticDoneAt : null,
    }), false);
  } else {
    mutateTrade(latest.tradeId, (trade) => ({
      ...trade,
      returnDone: latest.target,
      returnDoneAt: latest.target ? latest.optimisticDoneAt : null,
      contractStatus: latest.target ? "반납완료" : "반출",
    }), false);
  }

  try {
    const res = latest.kind === "setup"
      ? await gasMutation("toggleSetup", {
          tid: latest.tradeId,
          done: latest.target,
          mutationId: latest.mutationId,
        })
      : await gasMutation("toggleReturn", {
          tid: latest.tradeId,
          done: latest.target,
          mutationId: latest.mutationId,
          ...(latest.force ? { force: 1 } : {}),
          // 기준선 없음 근거의 force는 재생에서도 서버 정본 재검증을 거친다
          ...(latest.force && latest.autoForce ? { autoForce: 1 } : {}),
        });
    requireCompletionMutationResult_(res, latest.kind === "setup" ? "setupDone" : "returnDone");
    if (latest.kind === "setup") {
      const confirmedDone = typeof res?.setupDone === "boolean" ? res.setupDone : latest.target;
      const doneAt = confirmedDone
        ? String(res?.setupDoneAt || res?.doneAt || latest.optimisticDoneAt || "")
        : null;
      mutateTrade(latest.tradeId, (trade) => ({ ...trade, setupDone: confirmedDone, setupDoneAt: doneAt }), false);
    } else {
      const confirmedDone = typeof res?.returnDone === "boolean" ? res.returnDone : latest.target;
      const doneAt = confirmedDone
        ? String(res?.returnDoneAt || res?.doneAt || latest.optimisticDoneAt || "")
        : null;
      mutateTrade(latest.tradeId, (trade) => ({
        ...trade,
        returnDone: confirmedDone,
        returnDoneAt: doneAt,
        contractStatus: String(res?.contractStatus || (confirmedDone ? "반납완료" : "반출")) as Trade["contractStatus"],
      }), false);
    }
    acknowledgeCompletionMutationOutbox(latest.kind, latest.tradeId, latest.mutationId);
    finishTradeSave(latest.tradeId, saveId, "saved", latest.kind === "setup" ? "반출완료 저장됨" : "반납완료 저장됨");
  } catch (error) {
    if (!isRetryableLedgerError(error)) {
      acknowledgeCompletionMutationOutbox(latest.kind, latest.tradeId, latest.mutationId);
      finishTradeSave(latest.tradeId, saveId, "error", `⚠️ ${latest.kind === "setup" ? "반출" : "반납"}완료가 원장에서 거절됐습니다`);
      await reconcileCompletionMutationCanonical_(latest.tradeId);
      return;
    }
    const attempts = latest.attempts + 1;
    updateCompletionMutationOutboxAttempts(latest, attempts);
    finishTradeSave(latest.tradeId, saveId, "error", `⚠️ ${latest.kind === "setup" ? "반출" : "반납"}완료 저장 지연 — 자동 재시도 중`);
    scheduleCompletionMutationReplay_(
      latest.kind,
      latest.tradeId,
      Math.min(2_000 * 2 ** Math.min(attempts, 4), 30_000),
    );
  } finally {
    completionMutationReplayInFlight.delete(key);
  }
}

function replayCompletionMutationOutboxes_(initialDelay = 0): void {
  if (typeof window === "undefined" || !isSupabase || !writeBackEnabled) return;
  Object.values(readCompletionMutationOutbox()).forEach((entry, index) => {
    scheduleCompletionMutationReplay_(entry.kind, entry.tradeId, initialDelay + index * 350);
  });
}

let durableMutationOutboxesReplayed = false;
const DURABLE_REPLAY_START_MS = 1_500;

function nextDurableReplayDelay_(index: number): number {
  // 여러 탭/기기가 동시에 다시 켜져도 같은 millisecond에 GAS를 두드리지 않는다.
  return DURABLE_REPLAY_START_MS + index * 350 + Math.round(Math.random() * 250);
}

/** 새로고침/모바일 종료 전에 서버에 못 간 최종 목표값을 원격 로드 뒤 정확히 한 번 재생한다. */
function replayDurableMutationOutboxes(): void {
  if (durableMutationOutboxesReplayed || typeof window === "undefined" || !isSupabase) return;
  durableMutationOutboxesReplayed = true;
  ensureDurableMutationOnlineResume_();
  const returnOutbox = readReturnCountOutbox();
  const qtyOutbox = readQtyOutbox();
  const itemCheckOutbox = readItemCheckOutbox();
  const noteOutbox = readTradeNoteOutbox_();
  const returnTradesToArm = new Set<string>();
  const qtyKeysToArm: Array<{ tradeId: string; scheduleId: string; key: string }> = [];
  const itemCheckTradesToArm = new Set<string>();
  const noteTradesToArm = new Set<string>();
  const discardedReturnTradeIds = new Set<string>();
  let replayIndex = 0;
  const nextReplayDelay = () => nextDurableReplayDelay_(replayIndex++);
  let changed = false;

  Object.entries(returnOutbox).forEach(([tradeId, entry]) => {
    returnCountOutboxMemory.set(tradeId, entry);
  });

  const trades = state.trades.map((trade) => {
    let nextTrade = trade;
    const returnEntry = returnOutbox[trade.tradeId];
    if (returnEntry && isReturnCountOutboxSupersededByCompletion_(returnEntry, trade)) {
      convergeAfterDiscardedReturnCountOutbox_(trade.tradeId);
      discardedReturnTradeIds.add(trade.tradeId);
    }
    const returnTargets = discardedReturnTradeIds.has(trade.tradeId) ? null : returnEntry?.patches;
    if (returnTargets && Object.keys(returnTargets).length) {
      returnCountPersistTargets[trade.tradeId] = mergeReturnCountPatchBatches(
        returnCountPersistTargets[trade.tradeId] ?? {},
        returnTargets,
      );
      const returnCounts = { ...(nextTrade.returnCounts ?? {}) };
      for (const [scheduleId, patch] of Object.entries(returnTargets)) {
        if (patch == null) delete returnCounts[scheduleId];
        else returnCounts[scheduleId] = { ...(returnCounts[scheduleId] ?? { good: 0, damaged: 0, lost: 0 }), ...patch };
      }
      nextTrade = { ...nextTrade, returnCounts };
      returnTradesToArm.add(trade.tradeId);
      changed = true;
    }

    for (const [key, rawQty] of Object.entries(qtyOutbox)) {
      if (!key.startsWith(`${trade.tradeId}|`)) continue;
      const scheduleId = key.slice(trade.tradeId.length + 1);
      const item = nextTrade.equipments.find((candidate) => candidate.scheduleId === scheduleId);
      if (!item) {
        // 거래는 로드됐는데 품목이 없다 = 그 사이 제외/삭제됨. 목표를 terminal 처리해
        // 영구 잔존과 (스케줄ID 재사용 시) 다른 장비로의 옛 목표 재생을 막는다.
        acknowledgeQtyOutboxTarget(key, Math.max(1, Math.round(Number(rawQty) || 1)));
        continue;
      }
      const qty = Math.max(1, Math.round(Number(rawQty) || 1));
      if (qtyConfirmedValues[key] === undefined) qtyConfirmedValues[key] = item.qty;
      qtyCommitTargets[key] = qty;
      qtyCommitRetryAttempts[key] = 0;
      delete qtyCommitFailures[key];
      nextTrade = mapItem(nextTrade, scheduleId, (candidate) => ({ ...candidate, qty }));
      qtyKeysToArm.push({ tradeId: trade.tradeId, scheduleId, key });
      changed = true;
    }

    const noteEntry = noteOutbox[trade.tradeId];
    if (noteEntry) {
      // 전송 전 새로고침으로 유실된 특이사항 목표를 재적용하고 persist를 재무장한다.
      // 서버가 이미 같은 값이면(다른 탭이 저장 완료) 조용히 ACK만 한다.
      const notePatch: Record<string, string | null> = {};
      if ("note_checkout" in noteEntry && (nextTrade.noteCheckout ?? null) !== (noteEntry.note_checkout ?? null)) {
        notePatch.note_checkout = noteEntry.note_checkout ?? null;
      }
      if ("note_checkin" in noteEntry && (nextTrade.noteCheckin ?? null) !== (noteEntry.note_checkin ?? null)) {
        notePatch.note_checkin = noteEntry.note_checkin ?? null;
      }
      if (Object.keys(notePatch).length) {
        nextTrade = {
          ...nextTrade,
          ...("note_checkout" in notePatch ? { noteCheckout: notePatch.note_checkout ?? undefined } : {}),
          ...("note_checkin" in notePatch ? { noteCheckin: notePatch.note_checkin ?? undefined } : {}),
        };
        tradeFieldPersistTargets[trade.tradeId] = { ...(tradeFieldPersistTargets[trade.tradeId] ?? {}), ...notePatch };
        pendingPersistTrades.add(trade.tradeId);
        noteTradesToArm.add(trade.tradeId);
        changed = true;
      } else {
        acknowledgeTradeNoteOutbox_(trade.tradeId, noteEntry as unknown as Record<string, unknown>);
      }
    }

    for (const [key, entry] of Object.entries(itemCheckOutbox)) {
      if (entry.tradeId !== trade.tradeId || !key.startsWith(`${trade.tradeId}|`)) continue;
      const item = nextTrade.equipments.find((candidate) => candidate.scheduleId === entry.scheduleId);
      if (!item) {
        // 제외/삭제된 품목의 체크 목표는 terminal 처리 (영구 잔존·ID 재사용 재생 방지)
        acknowledgeItemCheckOutboxTarget(key, entry.done, entry.mutationId);
        continue;
      }
      if (itemCheckConfirmedValues[key] === undefined) {
        itemCheckConfirmedValues[key] = item.checkoutState === "taken";
      }
      itemCheckTargets[key] = entry.done;
      itemCheckMutationIds[key] = entry.mutationId || createLedgerMutationId("item");
      itemCheckAttempts[key] = 0;
      nextTrade = mapItem(nextTrade, entry.scheduleId, (candidate) => ({
        ...candidate,
        checkoutState: entry.done ? "taken" : "pending",
      }));
      itemCheckTradesToArm.add(trade.tradeId);
      changed = true;
    }
    return nextTrade;
  });

  if (changed) set({ trades });
  if (discardedReturnTradeIds.size) {
    set({
      toast: {
        id: ++toastSeq,
        text: "⚠️ 다른 직원의 반납완료보다 오래된 오프라인 수량 입력은 적용하지 않았습니다",
        kind: "error",
      },
    });
  }
  returnTradesToArm.forEach((tradeId) => {
    window.setTimeout(() => resumeDurableReturnCountOutbox_(tradeId), nextReplayDelay());
  });
  itemCheckTradesToArm.forEach((tradeId) => armItemCheckBatch(tradeId, nextReplayDelay()));
  noteTradesToArm.forEach((tradeId) => {
    window.setTimeout(() => {
      const latest = state.trades.find((t) => t.tradeId === tradeId);
      if (latest) void enqueueTradeFieldPersist(tradeId, latest).catch(() => {});
    }, nextReplayDelay());
  });
  qtyKeysToArm.forEach(({ tradeId, scheduleId, key }) => {
    if (qtyCommitTimers[key]) clearTimeout(qtyCommitTimers[key]);
    qtyCommitTimers[key] = setTimeout(() => {
      delete qtyCommitTimers[key];
      void commitQueuedItemQty(tradeId, scheduleId, key);
    }, nextReplayDelay());
  });
  // 완료 버튼도 사용자 의도를 영구 보존한다. 위 품목/수량 outbox를 먼저 arm해 완료가
  // 마지막 품목 저장을 앞질러 기준선을 고정하지 않게 한다.
  replayItemMetadataOutbox_(nextReplayDelay());
  replayCompletionMutationOutboxes_(nextReplayDelay());
  replayRemoveEquipmentOutbox_(nextReplayDelay());
}

let durableMutationOnlineResumeRegistered = false;

/** 오프라인에서 보존한 카드 입력은 브라우저가 온라인이 되는 즉시 재개한다. */
function ensureDurableMutationOnlineResume_(): void {
  if (durableMutationOnlineResumeRegistered || typeof window === "undefined") return;
  durableMutationOnlineResumeRegistered = true;
  window.addEventListener("online", () => {
    const returnTradeIds = Object.keys(returnCountPersistTargets)
      .filter((tradeId) => hasReturnCountTargets(tradeId));
    returnTradeIds.forEach((tradeId) => {
      if (returnCountPersistTimers[tradeId]) clearTimeout(returnCountPersistTimers[tradeId]);
      delete returnCountPersistTimers[tradeId];
      if (returnCountOutboxResumeTimers[tradeId]) clearTimeout(returnCountOutboxResumeTimers[tradeId]);
      delete returnCountOutboxResumeTimers[tradeId];
      returnCountPersistRetryAttempts[tradeId] = 0;
      const trade = state.trades.find((candidate) => candidate.tradeId === tradeId);
      if (trade?.returnDone || trade?.contractStatus === "반납완료") resumeDurableReturnCountOutbox_(tradeId);
      else armReturnCountsPersist(tradeId, 0);
    });

    const qtyKeys = Object.keys(qtyCommitTargets).filter((key) => qtyCommitTargets[key] !== undefined);
    qtyKeys.forEach((key) => {
      if (qtyCommitRetryTimers[key]) clearTimeout(qtyCommitRetryTimers[key]);
      delete qtyCommitRetryTimers[key];
      delete qtyCommitFailures[key];
      qtyCommitRetryAttempts[key] = 0;
      const separator = key.indexOf("|");
      if (separator < 1) return;
      void commitQueuedItemQty(key.slice(0, separator), key.slice(separator + 1), key);
    });

    const itemCheckTrades = new Set<string>();
    Object.keys(itemCheckTargets).forEach((key) => {
      if (itemCheckTargets[key] === undefined) return;
      if (itemCheckRetryTimers[key]) clearTimeout(itemCheckRetryTimers[key]);
      delete itemCheckRetryTimers[key];
      itemCheckAttempts[key] = 0;
      const separator = key.indexOf("|");
      if (separator > 0) itemCheckTrades.add(key.slice(0, separator));
    });
    itemCheckTrades.forEach((tradeId) => armItemCheckBatch(tradeId, 0));

    replayItemMetadataOutbox_();

    Object.keys(completionMutationReplayTimers).forEach((key) => {
      clearTimeout(completionMutationReplayTimers[key]);
      delete completionMutationReplayTimers[key];
    });
    replayCompletionMutationOutboxes_();

    Object.keys(removeEquipmentReplayTimers).forEach((key) => {
      clearTimeout(removeEquipmentReplayTimers[key]);
      delete removeEquipmentReplayTimers[key];
    });
    replayRemoveEquipmentOutbox_();
  });
}

/** 수량 스테퍼의 350ms debounce도 반출완료보다 먼저 drain한다. */
async function flushQueuedItemQtyForTrade(tradeId: string): Promise<void> {
  const prefix = `${tradeId}|`;
  for (;;) {
    const failed = Object.entries(qtyCommitFailures).find(([key, error]) => key.startsWith(prefix) && !!error);
    if (failed?.[1]) throw failed[1];

    const keys = Object.keys(qtyCommitTargets).filter((key) => key.startsWith(prefix));
    for (const key of keys) {
      if (qtyCommitTimers[key]) {
        clearTimeout(qtyCommitTimers[key]);
        delete qtyCommitTimers[key];
      }
      if (!qtyCommitInFlight[key]) {
        const scheduleId = key.slice(prefix.length);
        void commitQueuedItemQty(tradeId, scheduleId, key);
      }
    }
    const inFlight = Object.entries(qtyCommitInFlight)
      .filter(([key, task]) => key.startsWith(prefix) && !!task)
      .map(([, task]) => task as Promise<void>);
    if (!keys.length && !inFlight.length) return;
    if (inFlight.length) await Promise.all(inFlight);
    else await Promise.resolve();
  }
}
// 품목 메모는 적은 시점(phase)별로 저장한다. 반대쪽 카드에는 출처 태그와 함께 그대로 노출되므로
// 예전처럼 양쪽 필드에 미러링하지 않는다 (미러링하면 반출/반납 구분이 사라짐).
export function setItemMemo(tradeId: string, scheduleId: string, phase: Phase, text: string) {
  const memo = text.trim();
  mutateTrade(tradeId, (t) =>
    mapItem(t, scheduleId, (e) =>
      phase === "checkout" ? { ...e, memoCheckout: memo } : { ...e, memoCheckin: memo },
    ), false,
  );
  queueItemMetadataPatch(tradeId, scheduleId, phase === "checkout" ? { memo_checkout: memo } : { memo_checkin: memo });
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
const onsiteIdempotencyKeys: Record<string, string | undefined> = {};

function onsiteIdempotencyStorageKey(signature: string): string {
  let hash = 2166136261;
  for (let i = 0; i < signature.length; i += 1) {
    hash ^= signature.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `heybilly:onsite:${(hash >>> 0).toString(36)}`;
}

function getOnsiteIdempotencyKey(signature: string): { id: string; storageKey: string } {
  const storageKey = onsiteIdempotencyStorageKey(signature);
  let id = onsiteIdempotencyKeys[storageKey];
  if (!id && typeof window !== "undefined") {
    try { id = window.localStorage.getItem(storageKey) || undefined; } catch { /* noop */ }
  }
  if (!id) id = createLedgerMutationId("onsite");
  onsiteIdempotencyKeys[storageKey] = id;
  if (typeof window !== "undefined") {
    try { window.localStorage.setItem(storageKey, id); } catch { /* noop */ }
  }
  return { id, storageKey };
}

function clearOnsiteIdempotencyKey(storageKey: string): void {
  delete onsiteIdempotencyKeys[storageKey];
  if (typeof window !== "undefined") {
    try { window.localStorage.removeItem(storageKey); } catch { /* noop */ }
  }
}

type GasOnsiteItem = {
  scheduleId?: string;
  name?: string;
  qty?: number;
  setName?: string;
  isHeader?: boolean;
  isComponent?: boolean;
};

function mapGasOnsiteItems_(
  added: GasOnsiteItem[],
  entries: OnsiteEntry[],
  settlement: Settlement,
): EquipmentItem[] {
  const offByName = new Map(entries.map((entry) => [entry.name.trim(), !!entry.offCatalog]));
  return added.map((item): EquipmentItem => {
    const name = String(item.name ?? "").trim();
    return {
      scheduleId: String(item.scheduleId ?? "").trim(),
      name,
      qty: Number(item.qty) || 1,
      setName: item.setName || undefined,
      isSetHeader: item.isHeader || undefined,
      isComponent: item.isComponent || undefined,
      category: categoryOf(name) ?? undefined,
      offCatalog: offByName.get(name) || undefined,
      emphasize: ONSITE_EMPH.test(name) || undefined,
      onsite: true,
      settlement,
      checkoutState: "taken",
      returnState: "pending",
    };
  }).filter((item) => item.scheduleId && item.name);
}

function applyGasOnsiteItems_(
  tradeId: string,
  items: EquipmentItem[],
  options?: { amount?: number | null; contractUrl?: string; contractRegenPending?: boolean },
): void {
  const ids = new Set(items.map((item) => item.scheduleId));
  // GAS가 제외로 빈 스케줄 번호를 재사용했을 수 있다 — 확정된 추가 품목은 제외
  // tombstone에서 즉시 해제해 스냅샷 병합이 새 장비를 숨기지 않게 한다
  clearExcludedItemTombstones_(tradeId, Array.from(ids));
  mutateTrade(tradeId, (trade) => ({
    ...trade,
    equipments: [...trade.equipments.filter((item) => !ids.has(item.scheduleId)), ...items],
    amount: options?.amount ?? trade.amount,
    contractUrl: options?.contractUrl || trade.contractUrl || null,
    contractRegenPending: options?.contractRegenPending ?? trade.contractRegenPending,
  }), false);
}

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
  const onsiteMutation = getOnsiteIdempotencyKey(JSON.stringify({ tradeId, payload, settlement }));
  if (activeTradeTransitions.has(tradeId) || hasTradePending(tradeId)) {
    throw new Error("이 거래의 다른 변경을 저장 중입니다. 잠시 후 다시 시도해주세요");
  }
  const saveId = beginTradeTransition(tradeId);

  try {
    // 계약서 재생성은 백그라운드 워커에 위임 — 현장추가 응답에서 재생성 시간(수 초~수십 초)을
    // 제거하고 GAS 잠금 점유도 짧게 만든다. 새 링크는 pending 배지 → 폴링 merge로 반영.
    const res = await gasMutation("onsiteAddon", {
    tid: tradeId,
    entries: JSON.stringify(payload),
    rawNames: true,
    settlement_status: settlement,
    actorName: "오늘 일정 웹앱",
    idempotencyKey: onsiteMutation.id,
    directRegenerate: false,
  });

  // 실데이터에서 로컬 폴백은 물리 반출 기준선을 만들지 못하므로 실패-폐쇄한다.
  if (res?.skipped) {
    throw new Error(`현장 추가 실패: ${writeBackDisabledReason}`);
  }

  const out = res?.result ?? res ?? {};
  if (out?.duplicate || res?.duplicate) {
    const expectedIds = ((out?.addedScheduleIds ?? res?.addedScheduleIds ?? []) as string[])
      .map((id) => String(id || "").trim()).filter(Boolean);
    const recoveredItems = mapGasOnsiteItems_(
      (out?.addedItems ?? res?.addedItems ?? []) as GasOnsiteItem[],
      entries,
      settlement,
    );
    if (recoveredItems.length > 0 && expectedIds.every((id) => recoveredItems.some((item) => item.scheduleId === id))) {
      // GAS의 멱등 응답은 원본 시트행을 직접 검증한 결과다. Supabase 구조 투영은 비동기이므로
      // 여기서 단 한 번 조회해 아직 없다는 이유로 정상 요청을 실패 처리하지 않는다.
      applyGasOnsiteItems_(tradeId, recoveredItems, { contractRegenPending: true });
    } else {
      const [serverTrade] = await fetchTradesByIds([tradeId]);
      const actualIds = new Set(serverTrade?.equipments.map((item) => item.scheduleId) ?? []);
      if (!serverTrade || !expectedIds.length || !expectedIds.every((id) => actualIds.has(id))) {
        throw new Error("현장 추가 중복 요청의 시트 반영 품목을 확인하지 못했습니다");
      }
      set({ trades: mergeTradeChanges(state.trades, [serverTrade]) });
    }
    clearOnsiteIdempotencyKey(onsiteMutation.storageKey);
    finishTradeSave(tradeId, saveId, "saved", "현장 추가 저장 확인됨");
    return;
  }
  const mutationResult = unwrapContractMutation(res);
  const url = contractUrlFromMutation(mutationResult);
  const amount = amountFromMutation(mutationResult);
  const added = (out.addedItems ?? []) as GasOnsiteItem[];
  if (added.length === 0) {
    throw new Error(out.error || "현장 추가가 스케줄상세에 반영되지 않았습니다");
  }

  // 시트가 발급한 실 scheduleId로 즉시 반영하고, 비동기 구조 투영/계약 재생성 결과는 폴링으로 수렴한다.
  const newItems = mapGasOnsiteItems_(added, entries, settlement);
  applyGasOnsiteItems_(tradeId, newItems, {
    amount,
    contractUrl: url,
    contractRegenPending: !!mutationResult.contractRegenPending && !url,
  });
    clearOnsiteIdempotencyKey(onsiteMutation.storageKey);
    finishTradeSave(tradeId, saveId, "saved", "현장 추가 저장됨");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    finishTradeSave(tradeId, saveId, "error", `⚠️ 현장 추가 실패 — ${message}`);
    throw error;
  }
}
export function setOnsiteSettlement(tradeId: string, scheduleId: string, settlement: Settlement) {
  mutateTrade(tradeId, (t) => mapItem(t, scheduleId, (e) => ({ ...e, settlement })), false);
  queueItemMetadataPatch(tradeId, scheduleId, { settlement });
  flashSave(tradeId);
}
export function removeItem(tradeId: string, scheduleId: string) {
  const trade = state.trades.find((t) => t.tradeId === tradeId);
  const item = trade?.equipments.find((e) => e.scheduleId === scheduleId);
  if (trade && isCheckoutBaselineLocked(trade)) {
    set({
      toast: {
        id: ++toastSeq,
        text: "⚠️ 이미 반출된 품목은 삭제할 수 없습니다. 반납 처리 후 기록을 보존해주세요",
        kind: "error",
      },
    });
    return;
  }
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
  if (activeTradeTransitions.has(tradeId)) {
    showTransientError("⚠️ 반납 상태를 확정 중입니다. 저장이 끝난 뒤 수량을 바꿔주세요");
    return false;
  }
  if (isSupabase && !writeBackEnabled) {
    set({ toast: { id: ++toastSeq, text: `⚠️ 반납 수량 저장 실패 — ${writeBackDisabledReason}`, kind: "error" } });
    return false;
  }
  let writeback: boolean | undefined;
  const durablePatch: Partial<ReturnCount> = { ...patch };
  if ((patch.good != null || patch.damaged != null || patch.lost != null) && patch.reportedMissing == null) {
    // undefined는 JSON/localStorage 직렬화에서 사라져 재시작 후 예전 누락값이 부활한다.
    // 0을 명시적 clear sentinel로 내구 저장하고 화면 상태만 undefined로 정규화한다.
    durablePatch.reportedMissing = 0;
  }
  const before = state.trades.find((t) => t.tradeId === tradeId);
  if (!before) return false;
  const beforeItem = before.equipments.find((item) => item.scheduleId === scheduleId);
  const previousCount: ReturnCount = before.returnCounts?.[scheduleId] ?? { good: 0, damaged: 0, lost: 0 };
  const nextCount: ReturnCount = { ...previousCount, ...patch };
  if ((patch.good != null || patch.damaged != null || patch.lost != null) && patch.reportedMissing == null) {
    nextCount.reportedMissing = undefined;
  }
  const countUnchanged =
    previousCount.good === nextCount.good &&
    previousCount.damaged === nextCount.damaged &&
    previousCount.lost === nextCount.lost &&
    Number(previousCount.reportedMissing || 0) === Number(nextCount.reportedMissing || 0) &&
    String(previousCount.memo ?? "") === String(nextCount.memo ?? "");
  // 최소값에서 −를 누르거나 같은 메모가 blur된 것은 저장도, 완료 거래 재오픈도 하지 않는다.
  if (countUnchanged) return true;

  const expected = beforeItem ? equipmentActualTakenQty(beforeItem) : 0;
  const wasIn = expected > 0 && previousCount.good + previousCount.damaged + previousCount.lost === expected;
  const isIn = expected > 0 && nextCount.good + nextCount.damaged + nextCount.lost === expected;
  if (wasIn !== isIn) writeback = isIn;
  const wasReturnComplete = !!before && (before.returnDone || before.contractStatus === "반납완료");
  const reopenMutationId = wasReturnComplete ? createLedgerMutationId("return-reopen") : "";
  // 완료 화면에서 시작한 명시적 새 편집은 이전 오프라인 잔여 큐와 섞지 않는다. 이 입력의
  // 완료 시각을 outbox에 남겨, 재시작 후에도 같은 완료에 대한 편집만 재오픈하도록 한다.
  if (wasReturnComplete) discardAllReturnCountTargets_(tradeId);
  mutateTrade(tradeId, (t) => {
    return { ...t, returnCounts: { ...t.returnCounts, [scheduleId]: nextCount } };
  }, false);
  if (!isSupabase) {
    flashSave(tradeId);
    return true;
  }
  const returnCountSaveId = wasReturnComplete ? beginTradeTransition(tradeId) : beginReturnCountSave(tradeId);
  if (wasReturnComplete) {
    returnCountSaveTokens[tradeId] = [...(returnCountSaveTokens[tradeId] ?? []), returnCountSaveId];
  }
  // 완료 거래 재오픈보다 먼저 사용자 의도를 내구 기록한다. 모바일 종료가 GAS 재오픈
  // 직후 발생해도 다음 실행이 같은 수량 변경을 이어서 저장한다.
  putReturnCountOutboxPatch(tradeId, scheduleId, durablePatch, {
    createdAt: Date.now(),
    observedReturnDone: wasReturnComplete,
    observedReturnDoneAt: wasReturnComplete ? String(before.returnDoneAt || "").trim() || null : null,
    reopenMutationId,
    replaceExisting: wasReturnComplete,
  });
  if (wasReturnComplete) {
    returnCountPersistTargets[tradeId] = mergeReturnCountPatchBatches(
      returnCountPersistTargets[tradeId] ?? {},
      { [scheduleId]: durablePatch },
    );
  }
  if (wasReturnComplete) {
    try {
      // 완료 거래는 상세 JSON보다 먼저 GAS 정본과 Supabase 완료 플래그를 함께 연다.
      await reopenReturnForCountMutation(
        tradeId,
        String(before.returnDoneAt || "").trim() || null,
        reopenMutationId,
      );
    } catch (error) {
      const retryable = isRetryableLedgerError(error);
      if (!retryable) {
        mutateTrade(tradeId, (t) => ({
          ...t,
          returnCounts: { ...t.returnCounts, [scheduleId]: previousCount },
        }), false);
      }
      const message = error instanceof Error ? error.message : String(error);
      const tokens = returnCountSaveTokens[tradeId] ?? [];
      returnCountSaveTokens[tradeId] = tokens.filter((token) => token !== returnCountSaveId);
      if (!retryable) {
        acknowledgeReturnCountOutboxBatch(tradeId, { [scheduleId]: durablePatch });
        acknowledgeReturnCountTargetBatch_(tradeId, { [scheduleId]: durablePatch });
        if (error instanceof ReturnCompletionConflictError) {
          convergeAfterDiscardedReturnCountOutbox_(tradeId);
        }
      } else {
        if (returnCountOutboxResumeTimers[tradeId]) clearTimeout(returnCountOutboxResumeTimers[tradeId]);
        returnCountOutboxResumeTimers[tradeId] = setTimeout(
          () => resumeDurableReturnCountOutbox_(tradeId, 1),
          2_000,
        );
      }
      finishTradeSave(tradeId, returnCountSaveId, "error", `⚠️ 반납 수량 수정 실패 — ${message}`);
      set({ toast: { id: ++toastSeq, text: `⚠️ 반납 수량 수정 실패 — ${message}`, kind: "error" } });
      return false;
    }
  }
  scheduleReturnCountsPersist(tradeId, scheduleId, durablePatch);
  // 일반 체크는 120ms 병합 큐에 맡긴다. 이미 닫힌 거래를 다시 여는 전환만 즉시 drain한다.
  if (writeback !== false) return true;

  try {
    await flushReturnCountsPersist(tradeId);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[write-back] 반납 수량 저장 실패:", error);
    set({ toast: { id: ++toastSeq, text: `⚠️ 반납 수량 저장 실패 — ${message}`, kind: "error" } });
    return false;
  }
}

// ── 결제·정산 (개고생2.0 회계로 write-back 대상) ────────────────
export async function setPaymentMethod(tradeId: string, method: string): Promise<boolean> {
  const previous = state.trades.find((trade) => trade.tradeId === tradeId);
  if (!previous) return false;
  if (activeTradeTransitions.has(tradeId) || hasTradePending(tradeId)) {
    showTransientError("⚠️ 이 거래의 앞선 변경을 저장 중입니다. 저장 후 다시 선택해주세요");
    return false;
  }
  if (isSupabase && !writeBackEnabled) {
    showTransientError(`⚠️ 결제수단 저장 실패: ${writeBackDisabledReason}`);
    return false;
  }
  mutateTrade(tradeId, (t) => ({ ...t, paymentMethod: method }), false);
  if (!isSupabase) {
    flashSave(tradeId);
    return true;
  }
  const saveId = beginTradeSave(tradeId);
  try {
    const res = await gasMutationRetrying("updatePayment", { tid: tradeId, method });
    const result = res?.result || res || {};
    if (result.success !== true || result.wroteSheet !== true) {
      throw new Error(String(result.warning || "거래내역 결제수단 저장을 확인하지 못했습니다"));
    }
    const sideEffects = result.sideEffects;
    mutateTrade(tradeId, (t) => ({
      ...t,
      paymentMethod: String(result.method ?? method),
      ...(sideEffects?.applied ? {
        proofType: sideEffects.columns.K || t.proofType,
        issueStatus: sideEffects.columns.L || t.issueStatus,
        depositStatus: sideEffects.columns.M || t.depositStatus,
        paymentWarning: sideEffects.columns.M ? /미|대기|예정/.test(sideEffects.columns.M) : t.paymentWarning,
      } : {}),
    }), false);
    const latest = state.trades.find((trade) => trade.tradeId === tradeId);
    if (latest) schedulePersistTrade(latest, previous);
    finishTradeSave(tradeId, saveId, "saved", "결제수단 저장됨");
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    mutateTrade(tradeId, (trade) => ({
      ...trade,
      paymentMethod: previous.paymentMethod,
      proofType: previous.proofType,
      issueStatus: previous.issueStatus,
      depositStatus: previous.depositStatus,
      paymentWarning: previous.paymentWarning,
    }), false);
    finishTradeSave(tradeId, saveId, "error", `⚠️ 결제수단 저장 실패 — ${message}`);
    return false;
  }
}
type TradeProofField = "depositStatus" | "proofType" | "issueStatus";

async function setTradeProofField_(tradeId: string, field: TradeProofField, value: string): Promise<boolean> {
  const previous = state.trades.find((trade) => trade.tradeId === tradeId);
  if (!previous) return false;
  if (String(previous[field] ?? "") === value) return true;
  if (activeTradeTransitions.has(tradeId) || hasTradePending(tradeId)) {
    showTransientError("⚠️ 이 거래의 앞선 변경을 저장 중입니다. 저장 후 다시 선택해주세요");
    return false;
  }
  if (isSupabase && !writeBackEnabled) {
    showTransientError(`⚠️ 결제·증빙 저장 실패: ${writeBackDisabledReason}`);
    return false;
  }
  mutateTrade(tradeId, (trade) => ({
    ...trade,
    [field]: value,
    ...(field === "depositStatus" ? { paymentWarning: /미|대기|예정/.test(value) } : {}),
  }), false);
  if (!isSupabase) {
    flashSave(tradeId);
    return true;
  }

  const saveId = beginTradeSave(tradeId);
  try {
    const res = await gasMutationRetrying("updateTradeProof", { tid: tradeId, field, value });
    const result = res?.result || res || {};
    if (result.success !== true || result.field !== field) {
      throw new Error(String(result.warning || "거래내역 결제·증빙 저장을 확인하지 못했습니다"));
    }
    const canonical = String(result.value ?? value);
    mutateTrade(tradeId, (trade) => ({
      ...trade,
      [field]: canonical,
      ...(field === "depositStatus" ? { paymentWarning: /미|대기|예정/.test(canonical) } : {}),
    }), false);
    const latest = state.trades.find((trade) => trade.tradeId === tradeId);
    if (latest) schedulePersistTrade(latest, previous);
    finishTradeSave(tradeId, saveId, "saved", "결제·증빙 저장됨");
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    mutateTrade(tradeId, (trade) => ({
      ...trade,
      [field]: previous[field],
      ...(field === "depositStatus" ? { paymentWarning: previous.paymentWarning } : {}),
    }), false);
    finishTradeSave(tradeId, saveId, "error", `⚠️ 결제·증빙 저장 실패 — ${message}`);
    return false;
  }
}

export function setDepositStatus(tradeId: string, status: string): Promise<boolean> {
  return setTradeProofField_(tradeId, "depositStatus", status);
}
export function setProofType(tradeId: string, proofType: string): Promise<boolean> {
  return setTradeProofField_(tradeId, "proofType", proofType);
}
export function setIssueStatus(tradeId: string, issueStatus: string): Promise<boolean> {
  return setTradeProofField_(tradeId, "issueStatus", issueStatus);
}

/** 문자/증빙처럼 재호출 자체가 중복 실행인 액션은 명시적인 양의 성공 증거만 인정한다. */
function isPositiveExternalActionResult_(result: Record<string, unknown>): boolean {
  return result.success === true || String(result.status || "").trim().toUpperCase() === "OK";
}

export async function requestProofIssue(tradeId: string) {
  const previous = state.trades.find((trade) => trade.tradeId === tradeId);
  if (!previous) throw new Error("거래를 찾을 수 없습니다");
  if (activeTradeTransitions.has(tradeId) || hasTradePending(tradeId)) {
    throw new Error("이 거래의 앞선 변경을 저장 중입니다. 저장 후 다시 발행해주세요");
  }
  if (isSupabase && !writeBackEnabled) throw new Error(writeBackDisabledReason);
  if (!isSupabase) throw new Error("실데이터 모드에서만 증빙을 발행할 수 있습니다");

  // 실제 외부 발행 전에 Supabase를 '발행요청'으로 확정하지 않는다. 응답 유실 시 자동
  // 재발행도 금지하고, 거래내역 정본 확인으로만 결과를 수렴시킨다.
  const saveId = beginTradeTransition(tradeId);
  mutateTrade(tradeId, (trade) => ({ ...trade, issueNote: "발행 요청 중..." }), false);
  try {
    const res = await gasMutation("updateTradeProof", {
      tid: tradeId,
      field: "issueStatus",
      value: "발행요청",
      mutationId: createLedgerMutationId("proof-issue"),
    });
    const result = res?.result || res || {};
    if (res?.skipped || result.error || !isPositiveExternalActionResult_(result)) {
      throw new Error(String(result.error || result.message || "증빙 발행 성공을 확인하지 못했습니다"));
    }
    mutateTrade(tradeId, (trade) => ({
      ...trade,
      issueStatus: result.issueStatus || "발행완료",
      issueNote: result.message || "증빙 발행 완료",
    }), false);
    const latest = state.trades.find((trade) => trade.tradeId === tradeId);
    if (latest) schedulePersistTrade(latest, previous);
    finishTradeSave(tradeId, saveId, "saved", "증빙 발행 완료");
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const unknown = isGasOutcomeUnknownError(error);
    mutateTrade(tradeId, (trade) => ({
      ...trade,
      issueStatus: previous.issueStatus,
      issueNote: unknown
        ? "발행 결과 확인 필요 — 거래내역 확인 전에는 다시 발행하지 마세요"
        : message,
    }), false);
    finishTradeSave(
      tradeId,
      saveId,
      "error",
      unknown ? "⚠️ 발행 결과를 확인할 수 없습니다 — 거래내역에서 먼저 확인해주세요" : `⚠️ 증빙 발행 실패 — ${message}`,
    );
    if (unknown && typeof window !== "undefined") {
      window.setTimeout(() => void pollSheetChangesNow({ mode: "light", resetBackoff: false }), 2_000);
    }
    throw error;
  }
}
export async function setBillingCompany(tradeId: string, billingCompany: string): Promise<boolean> {
  const previous = state.trades.find((trade) => trade.tradeId === tradeId);
  if (!previous) return false;
  if (activeTradeTransitions.has(tradeId) || hasTradePending(tradeId)) {
    showTransientError("⚠️ 이 거래의 앞선 변경을 저장 중입니다. 저장 후 다시 선택해주세요");
    return false;
  }
  if (isSupabase && !writeBackEnabled) {
    showTransientError(`⚠️ 발행처 저장 실패: ${writeBackDisabledReason}`);
    return false;
  }
  mutateTrade(tradeId, (t) => ({ ...t, billingCompany }), false);
  if (!isSupabase) {
    flashSave(tradeId);
    return true;
  }
  const saveId = beginTradeSave(tradeId);
  try {
    const res = await gasMutationRetrying("updateBillingCompany", { tid: tradeId, billingCompany });
    const result = res?.result || res || {};
    if (result.success !== true || !Object.prototype.hasOwnProperty.call(result, "billingCompany")) {
      throw new Error(String(result.error || "거래내역 발행처 저장을 확인하지 못했습니다"));
    }
    mutateTrade(tradeId, (t) => ({ ...t, billingCompany: String(result.billingCompany ?? "") }), false);
    const latest = state.trades.find((trade) => trade.tradeId === tradeId);
    if (latest) schedulePersistTrade(latest, previous);
    finishTradeSave(tradeId, saveId, "saved", "발행처 저장됨");
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    mutateTrade(tradeId, (trade) => ({ ...trade, billingCompany: previous.billingCompany }), false);
    finishTradeSave(tradeId, saveId, "error", `⚠️ 발행처 저장 실패 — ${message}`);
    return false;
  }
}
// 확인요청 M열·계약마스터 K열과 동일한 허용값 — 카드의 할인유형 셀렉터가 사용
export const DISCOUNT_TYPE_OPTIONS = ["일반", "학생", "개인사업자/프리랜서", "단골", "제휴"];

/** 등록된 거래의 할인유형 변경 — 화면 즉시 반영, 원장(계약마스터 K열)과 계약서·금액
 *  재생성은 뒤에서 진행된다(재생성 완료 시 폴링 merge가 새 금액·계약서 링크를 가져옴). */
export async function setDiscountType(tradeId: string, discountType: string): Promise<boolean> {
  if (activeTradeTransitions.has(tradeId) || hasTradePending(tradeId)) {
    showTransientError("⚠️ 이 거래의 다른 변경을 저장 중입니다. 잠시 후 다시 시도해주세요");
    return false;
  }
  const current = state.trades.find((t) => t.tradeId === tradeId);
  if (!current) return false;
  if ((current.discountType || "") === discountType) return true;
  if (isSupabase && !writeBackEnabled) {
    showTransientError(`⚠️ 할인유형 변경 실패: ${writeBackDisabledReason}`);
    return false;
  }
  const previous = { discountType: current.discountType, contractRegenPending: current.contractRegenPending };
  mutateTrade(tradeId, (t) => ({ ...t, discountType, contractRegenPending: true }), false);
  const saveId = isSupabase ? beginTradeTransition(tradeId) : 0;
  if (!isSupabase) flashSave(tradeId);
  if (!isSupabase) return true;
  let ledgerCommitted = false;
  try {
    const res = await gasMutationRetrying("updateTradeDiscount", { tid: tradeId, discountType });
    if (res?.skipped) throw new Error(writeBackDisabledReason);
    ledgerCommitted = true;
    if (res?.unchanged) mutateTrade(tradeId, (t) => ({ ...t, contractRegenPending: previous.contractRegenPending }), false);
    const latest = state.trades.find((t) => t.tradeId === tradeId);
    if (latest) schedulePersistTrade(latest, current);
    await flushTradePersist(tradeId);
    // 재생성 워커가 새 계약서·금액을 만들면 폴링이 contractUrlChanged/amountFix로 수렴시킨다
    if (typeof window !== "undefined") {
      window.setTimeout(() => void pollSheetChangesNow({ mode: "light", resetBackoff: false }), 12_000);
    }
    finishTradeSave(tradeId, saveId, "saved", "할인유형 저장됨");
    return true;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (ledgerCommitted) {
      finishTradeSave(tradeId, saveId, "error", "⚠️ 원장에는 반영됐고 앱 동기화를 자동 재시도 중입니다");
      return true;
    }
    mutateTrade(tradeId, (t) => ({ ...t, ...previous }), false);
    finishTradeSave(tradeId, saveId, "error", `⚠️ 할인유형 변경 실패 — ${message}`);
    return false;
  }
}

export async function sendEstimate(tradeId: string): Promise<boolean> {
  const previous = state.trades.find((trade) => trade.tradeId === tradeId);
  if (!previous) return false;
  if (previous.estimateSent) return true;
  if (activeTradeTransitions.has(tradeId) || hasTradePending(tradeId)) {
    showTransientError("⚠️ 이 거래의 앞선 변경을 저장 중입니다. 저장 후 다시 발송해주세요");
    return false;
  }
  if (isSupabase && !writeBackEnabled) {
    showTransientError(`⚠️ 견적 발송 실패: ${writeBackDisabledReason}`);
    return false;
  }
  if (!isSupabase) {
    mutateTrade(tradeId, (trade) => ({ ...trade, estimateSent: true }));
    flashSave(tradeId);
    return true;
  }
  const saveId = beginTradeTransition(tradeId);
  try {
    // 외부 발송은 응답 유실 시 중복 발송 여부를 알 수 없으므로 자동 재전송하지 않는다.
    const res = await gasMutation("sendEstimate", {
      tid: tradeId,
      mutationId: createLedgerMutationId("estimate-send"),
    });
    const result = res?.result || res || {};
    if (res?.skipped || result.error || !isPositiveExternalActionResult_(result)) {
      throw new Error(String(result.error || result.message || "견적 발송 성공을 확인하지 못했습니다"));
    }
    mutateTrade(tradeId, (trade) => ({ ...trade, estimateSent: true }), false);
    const latest = state.trades.find((trade) => trade.tradeId === tradeId);
    if (latest) schedulePersistTrade(latest, previous);
    finishTradeSave(tradeId, saveId, "saved", "견적 발송 완료");
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    mutateTrade(tradeId, (trade) => ({ ...trade, estimateSent: previous.estimateSent }), false);
    finishTradeSave(tradeId, saveId, "error", `⚠️ 견적 발송 실패 — ${message}`);
    return false;
  }
}

export async function sendStatement(tradeId: string) {
  const previous = state.trades.find((trade) => trade.tradeId === tradeId);
  if (!previous) throw new Error("거래를 찾을 수 없습니다");
  if (activeTradeTransitions.has(tradeId) || hasTradePending(tradeId)) {
    throw new Error("이 거래의 앞선 변경을 저장 중입니다. 저장 후 다시 발송해주세요");
  }
  if (isSupabase && !writeBackEnabled) throw new Error(writeBackDisabledReason);
  if (!isSupabase) throw new Error("실데이터 모드에서만 거래명세서를 발송할 수 있습니다");
  const saveId = beginTradeTransition(tradeId);
  mutateTrade(tradeId, (t) => ({ ...t, issueNote: "거래명세서 발송 요청 중..." }), false);
  try {
    const res = await gasMutation("sendStatement", {
      tid: tradeId,
      mutationId: createLedgerMutationId("statement-send"),
    });
    const result = res?.result || res || {};
    if (res?.skipped || result.error || !isPositiveExternalActionResult_(result)) {
      throw new Error(String(result.error || result.message || "거래명세서 발송 성공을 확인하지 못했습니다"));
    }
    mutateTrade(tradeId, (t) => ({
      ...t,
      statementSent: true,
      issueNote: result.message || "거래명세서 발송 접수 완료",
    }), false);
    const latest = state.trades.find((trade) => trade.tradeId === tradeId);
    if (latest) schedulePersistTrade(latest, previous);
    finishTradeSave(tradeId, saveId, "saved", "거래명세서 발송 완료");
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const unknown = isGasOutcomeUnknownError(err);
    mutateTrade(tradeId, (t) => ({
      ...t,
      statementSent: previous.statementSent,
      issueNote: unknown
        ? "발송 결과 확인 필요 — 고객 수신 확인 전에는 다시 발송하지 마세요"
        : previous.issueNote,
    }), false);
    finishTradeSave(
      tradeId,
      saveId,
      "error",
      unknown ? "⚠️ 명세서 발송 결과를 확인할 수 없습니다 — 중복 발송 전에 확인해주세요" : `⚠️ 명세서 발송 실패 — ${message}`,
    );
    throw err;
  }
}

export async function sendPayAppPaymentLink(tradeId: string) {
  const previous = state.trades.find((trade) => trade.tradeId === tradeId);
  if (!previous) throw new Error("거래를 찾을 수 없습니다");
  if (activeTradeTransitions.has(tradeId) || hasTradePending(tradeId)) {
    throw new Error("이 거래의 앞선 변경을 저장 중입니다. 저장 후 다시 발송해주세요");
  }
  if (isSupabase && !writeBackEnabled) throw new Error(writeBackDisabledReason);
  if (!isSupabase) throw new Error("실데이터 모드에서만 결제링크를 발송할 수 있습니다");
  const saveId = beginTradeTransition(tradeId);
  mutateTrade(tradeId, (t) => ({ ...t, issueNote: "결제링크 발송 요청 중..." }), false);
  try {
    const res = await gasMutation("sendPayAppPaymentLink", {
      tid: tradeId,
      mutationId: createLedgerMutationId("payment-link-send"),
    });
    const result = res?.result || res || {};
    if (res?.skipped || result.error || !isPositiveExternalActionResult_(result)) {
      throw new Error(String(result.error || result.message || "결제링크 발송 성공을 확인하지 못했습니다"));
    }
    mutateTrade(tradeId, (t) => ({
      ...t,
      issueNote: result.message || "결제링크 발송 완료",
    }), false);
    const latest = state.trades.find((trade) => trade.tradeId === tradeId);
    if (latest) schedulePersistTrade(latest, previous);
    finishTradeSave(tradeId, saveId, "saved", "결제링크 발송 완료");
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const unknown = isGasOutcomeUnknownError(err);
    mutateTrade(tradeId, (t) => ({
      ...t,
      issueNote: unknown
        ? "발송 결과 확인 필요 — 고객 수신 확인 전에는 다시 발송하지 마세요"
        : previous.issueNote,
    }), false);
    finishTradeSave(
      tradeId,
      saveId,
      "error",
      unknown ? "⚠️ 결제링크 발송 결과를 확인할 수 없습니다 — 중복 발송 전에 확인해주세요" : `⚠️ 결제링크 발송 실패 — ${message}`,
    );
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
  let startShiftDays = 0;
  let endShiftDays = 0;
  mutateTrade(tradeId, (t) =>
    mapItem(t, scheduleId, (e) => {
      startShiftDays = (e.startShiftDays ?? 0) + days;
      endShiftDays = (e.endShiftDays ?? 0) + days;
      return { ...e, startShiftDays, endShiftDays };
    }), false,
  );
  queueItemMetadataPatch(tradeId, scheduleId, { start_shift_days: startShiftDays, end_shift_days: endShiftDays });
  flashSave(tradeId);
}
export function resizeEquipment(tradeId: string, scheduleId: string, edge: "start" | "end", days: number) {
  if (!days) return;
  let nextValue = 0;
  mutateTrade(tradeId, (t) =>
    mapItem(t, scheduleId, (e) => {
      const s0 = e.startShiftDays ?? 0;
      const en0 = e.endShiftDays ?? 0;
      // 시작이 종료를 넘지 않도록 보호는 컴포넌트에서 clamp; 여기선 그대로 반영
      nextValue = edge === "start" ? s0 + days : en0 + days;
      return edge === "start" ? { ...e, startShiftDays: nextValue } : { ...e, endShiftDays: nextValue };
    }), false,
  );
  queueItemMetadataPatch(tradeId, scheduleId, edge === "start" ? { start_shift_days: nextValue } : { end_shift_days: nextValue });
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
  for (const photo of incoming) {
    const prev = map.get(photoKey(photo));
    const merged: PhotoMeta = { ...prev, ...photo };
    // 업로드 응답에만 있는 sheetValue를 조회 응답의 undefined가 지우면, fileId 해석이
    // 실패한 사진의 삭제 매칭 수단이 사라진다 — 있는 값을 보존한다.
    if (photo.sheetValue == null && prev?.sheetValue != null) merged.sheetValue = prev.sheetValue;
    map.set(photoKey(photo), merged);
  }
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

function dashboardPhotoReadError_(raw: unknown): string {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "";
  const bucket = raw as Record<string, unknown>;
  return String(bucket.error ?? bucket.warning ?? "").trim();
}

function mergeTradePhotosFromGas(photoMap: Map<string, PhotoMeta[]>): void {
  if (!photoMap.size) return;
  let changed = false;
  const trades = state.trades.map((t) => {
    if (!photoMap.has(t.tradeId)) return t;
    const incoming = photoMap.get(t.tradeId) ?? [];
    // GAS 목록이 저장 사진의 정본이다. 빈 배열도 "전부 삭제됨"이라는 유효한 응답이다.
    // 단, 아직 전송 중이거나 실패 후 재시도 가능한 로컬 타일만 보존한다.
    const localQueueTiles = t.photos.filter((photo) => !!photo.status || !!photo.queueId);
    changed = true;
    return { ...t, photos: mergePhotos(incoming, localQueueTiles) };
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
        if (!Object.prototype.hasOwnProperty.call(rawMap, tradeId)) {
          throw new Error(`사진 정본 응답에서 거래가 누락됐습니다: ${tradeId}`);
        }
        const raw = rawMap[tradeId];
        const readError = dashboardPhotoReadError_(raw);
        if (readError) throw new Error(readError);
        photoMap.set(tradeId, flattenGasPhotos(raw));
      }
      mergeTradePhotosFromGas(photoMap);
      batch.forEach((tradeId) => loadedPhotoTrades.add(tradeId));
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

// ── 사진 변경 브로드캐스트 (기기 간 수렴) ───────────────────────
// 다른 기기/탭은 loadedPhotoTrades 캐시 때문에 삭제·업로드된 사진을 모달 재오픈까지
// 계속 보여줬다. 스키마 변경 없이 Supabase broadcast 채널로 수렴 신호를 보낸다.
// 신호 유실은 치명적이지 않다(모달 재오픈 시 기존 경로로 수렴) — best-effort.
const PHOTO_SYNC_CHANNEL = "photo-sync";
let photoSyncChannel: ReturnType<NonNullable<typeof supabase>["channel"]> | null = null;

function ensurePhotoSyncChannel_(): typeof photoSyncChannel {
  if (!supabase || typeof window === "undefined") return null;
  if (photoSyncChannel) return photoSyncChannel;
  photoSyncChannel = supabase
    .channel(PHOTO_SYNC_CHANNEL, { config: { broadcast: { self: false } } })
    .on("broadcast", { event: "photo-change" }, (message) => {
      const tradeId = String((message.payload as { tradeId?: string } | undefined)?.tradeId || "").trim();
      if (!tradeId) return;
      // 다음 열람 때 강제 재조회되도록 캐시를 비우고, 이미 로드된 거래면 즉시 수렴한다
      const wasLoaded = loadedPhotoTrades.delete(tradeId);
      if (wasLoaded && state.trades.some((t) => t.tradeId === tradeId)) {
        void loadTradePhotosBatch_([tradeId], true).catch(() => {});
      }
    })
    .subscribe();
  return photoSyncChannel;
}

function broadcastPhotoChange_(tradeId: string): void {
  try {
    const channel = ensurePhotoSyncChannel_();
    if (!channel) return;
    void Promise.resolve(channel.send({ type: "broadcast", event: "photo-change", payload: { tradeId } })).catch(() => {});
  } catch { /* 브로드캐스트 실패는 무해 — 수신 측은 모달 재오픈 시 수렴 */ }
}

// ── 사진 큐 전역 요약/목록 (배지 UI용) ─────────────────────────
export function usePhotoQueueSummary(): { uploading: number; failed: number } {
  return useSyncExternalStore(subscribe, () => state.photoQueueSummary, () => state.photoQueueSummary);
}

export type FailedPhotoJobView = {
  queueId: string;
  tradeId: string;
  phase: Phase;
  createdAt: number;
  attempts: number;
  lastError?: string;
  permanent?: boolean;
};

export function listFailedPhotoJobs(): FailedPhotoJobView[] {
  return listPhotoUploadJobs()
    .filter((job) => isPhotoUploadJobFailed(job))
    .map((job) => ({
      queueId: job.queueId,
      tradeId: job.tradeId,
      phase: job.phase,
      createdAt: job.createdAt,
      attempts: job.attempts,
      lastError: job.lastError,
      permanent: job.permanent,
    }));
}

// 업로드 대기 타일의 미리보기(data URL)는 Supabase 저장/동기화에 실리지 않도록 메모리에만 둔다.
const localPhotoPreviews = new Map<string, string>();
const resumedPhotoJobs = new Map<string, PhotoUploadJob>();

function attachResumedPhotoTiles_(trades: Trade[]): Trade[] {
  if (!resumedPhotoJobs.size) return trades;
  const jobsByTrade = new Map<string, PhotoUploadJob[]>();
  for (const job of resumedPhotoJobs.values()) {
    const list = jobsByTrade.get(job.tradeId) ?? [];
    list.push(job);
    jobsByTrade.set(job.tradeId, list);
  }
  return trades.map((trade) => {
    const pending = jobsByTrade.get(trade.tradeId);
    if (!pending?.length) return trade;
    const tiles = pending.map((job): PhotoMeta => ({
      id: job.queueId,
      phase: job.phase,
      swatch: photoSwatch(job.phase),
      label: `${photoLabel(job.phase)} ${job.attempts >= 5 ? "전송 실패" : "업로드 중"}`,
      status: job.attempts >= 5 ? "failed" : "uploading",
      queueId: job.queueId,
      memo: job.lastError,
    }));
    return { ...trade, photos: mergePhotos(trade.photos, tiles) };
  });
}

function restorePhotoUploadTiles_(jobs: PhotoUploadJob[]): void {
  if (!jobs.length) return;
  jobs.forEach((job) => {
    resumedPhotoJobs.set(job.queueId, job);
    localPhotoPreviews.set(job.queueId, job.data);
  });
  set({ trades: attachResumedPhotoTiles_(state.trades) });
}

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
  resumedPhotoJobs.delete(queueId);
  mutateTrade(tradeId, (t) => ({ ...t, photos: t.photos.filter((p) => p.queueId !== queueId) }));
  void discardPhotoUpload(queueId);
}

/** 서버에 저장된 사진 1장만 삭제한다. GAS 성공 전에는 타일을 제거하지 않는다. */
export async function deleteTradePhoto(tradeId: string, photo: PhotoMeta): Promise<void> {
  if (!writeBackEnabled) throw new Error(writeBackDisabledReason);
  if (photo.status || photo.queueId) throw new Error("전송 중인 사진은 전송이 끝난 뒤 삭제해 주세요");
  if (photo.phase !== "checkout" && photo.phase !== "checkin") throw new Error("반출/반납 사진만 삭제할 수 있습니다");
  if (!photo.fileId && !photo.sheetValue) throw new Error("삭제할 사진의 저장 정보를 찾지 못했습니다");

  let res: any;
  try {
    res = await gasMutation("deleteDashboardPhoto", {
      tid: tradeId,
      phase: photo.phase,
      fileId: photo.fileId || "",
      row: photo.row || 0,
      sheetValue: photo.sheetValue || "",
    });
  } catch (error) {
    // 응답만 유실되고 서버 삭제는 끝났을 수 있다. 정본 목록을 강제 replace해 사진이
    // 이미 없으면 성공으로 수렴하고, 여전히 있으면 원래 오류를 그대로 알린다.
    try {
      await loadTradePhotosBatch_([tradeId], true);
      const stillExists = state.trades
        .find((trade) => trade.tradeId === tradeId)
        ?.photos.some((candidate) => photoKey(candidate) === photoKey(photo));
      if (!stillExists) {
        broadcastPhotoChange_(tradeId); // 서버 삭제는 완료된 상태 — 타 기기도 수렴시킨다
        return;
      }
    } catch {
      // 원래 삭제 오류가 더 정확하므로 아래에서 다시 던진다.
    }
    throw error;
  }
  if (res?.skipped) throw new Error("사진 삭제 쓰기 경로가 비활성화되어 있습니다");

  const key = photoKey(photo);
  mutateTrade(tradeId, (t) => ({ ...t, photos: t.photos.filter((p) => photoKey(p) !== key) }));
  loadedPhotoTrades.add(tradeId);
  flashSave(tradeId);
  // 다른 기기/탭의 유령 사진(모달 재오픈 전까지 잔존)을 즉시 수렴시킨다
  broadcastPhotoChange_(tradeId);
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
      resumedPhotoJobs.delete(job.queueId);
      const raw = (res ?? {}) as { photo?: unknown; result?: { photo?: unknown } };
      const photo = normalizeGasPhoto(raw.photo || raw.result?.photo, job.phase, 0);
      mutateTrade(job.tradeId, (t) => ({
        ...t,
        photos: mergePhotos(t.photos.filter((p) => p.queueId !== job.queueId), [photo]),
      }));
      flashSave(job.tradeId);
      // 다른 기기/탭이 이 거래의 사진 캐시를 무효화하고 즉시 수렴하게 알린다
      broadcastPhotoChange_(job.tradeId);
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
  void resumePhotoUploads().then(restorePhotoUploadTiles_);
  // 큐 변화를 전역 배지 상태로 반영 (실패 잡이 화면 윈도우 밖 거래여도 보이게)
  onPhotoQueueChange(() => set({ photoQueueSummary: snapshotPhotoQueueSummary() }));
  set({ photoQueueSummary: snapshotPhotoQueueSummary() });
  // 사진 변경 브로드캐스트 수신 채널 구독 (다른 기기의 업로드/삭제 즉시 수렴)
  if (isSupabase) ensurePhotoSyncChannel_();
}

// ── 인수인계 메모 ──────────────────────────────────────────────
function mutateNotes(notes: HandoverNote[]) {
  markLocalMutation();
  notesMutationSeq++;
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
// date/trades/notes/savingTrades/remoteStatus가 실제로 바뀔 때만 새 스냅샷 객체를 만든다.
type DashboardSnapshot = DashboardDay & { savingTrades: Record<string, boolean>; remoteStatus: RemoteStatus };
let dashSnapshot: DashboardSnapshot = {
  date: state.date,
  trades: state.trades,
  notes: state.notes,
  savingTrades: state.savingTrades,
  remoteStatus: state.remoteStatus,
};
function getDashSnapshot() {
  if (
    dashSnapshot.date !== state.date ||
    dashSnapshot.trades !== state.trades ||
    dashSnapshot.notes !== state.notes ||
    dashSnapshot.savingTrades !== state.savingTrades ||
    dashSnapshot.remoteStatus !== state.remoteStatus
  ) {
    dashSnapshot = {
      date: state.date,
      trades: state.trades,
      notes: state.notes,
      savingTrades: state.savingTrades,
      remoteStatus: state.remoteStatus,
    };
  }
  return dashSnapshot;
}
export function useDashboard(): DashboardSnapshot {
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
