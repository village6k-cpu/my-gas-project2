// 시트 → Supabase 읽기 동기화 (Phase 1, 단방향).
// 소스: 기존 GAS action=timeline (날짜가 보정된 epoch ms를 줌 → 1899 버그 회피).
import type { EquipmentItem, Phase, ReturnCount, RiskLevel, RiskWarning, Trade } from "../domain/types";
import { categoryOf } from "../domain/catalog";
import { sanitizeCautionDisplayText } from "../domain/cautions";
import { fetchAllTrades, persistTrade } from "./remote";
import { gasFetch } from "./apiClient";
import { ymd } from "../domain/status";
import { mergeTimelineTradeSnapshot, shouldRestoreMissingTimelineEquipments } from "./timelineMerge";
import { isSheetBackedScheduleId } from "./mappers";

const DAY = 86400000;
const EMPH = /배터리|메모리|카드|CFexpress|SD|미디어/;
const PRUNE_MISSING_SHEET_BACKED = "__pruneMissingSheetBacked";

type DashboardDetailOptions = {
  authoritativeForMissingSheetBacked?: boolean;
};

type DashboardRepairTrade = Trade & {
  [PRUNE_MISSING_SHEET_BACKED]?: true;
};

function markPruneMissingSheetBacked(trade: Trade): DashboardRepairTrade {
  return { ...trade, [PRUNE_MISSING_SHEET_BACKED]: true };
}

export function shouldPruneMissingSheetBacked(trade: Trade): boolean {
  return (trade as DashboardRepairTrade)[PRUNE_MISSING_SHEET_BACKED] === true;
}

function st2contract(st: string): Trade["contractStatus"] {
  if (st === "반출중" || st === "반출") return "반출";
  if (st === "반납완료") return "반납완료";
  if (st === "취소") return "취소";
  return "예약"; // 대기 등
}

function toMs(v: unknown): number {
  if (typeof v === "number") return v;
  const t = new Date(v as string).getTime();
  return isNaN(t) ? 0 : t;
}

/** GAS timeline 압축 응답 → Trade[] (거래ID로 묶음) */
export function parseTimeline(resp: any): Trade[] {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const groups = new Map<string, string>((resp.groups ?? []).map((g: any) => [g.i, g.c]));
  const byTid = new Map<string, { items: any[] }>();
  for (const it of resp.items ?? []) {
    const tid = it.tid;
    if (!tid) continue;
    (byTid.get(tid) ?? byTid.set(tid, { items: [] }).get(tid)!).items.push(it);
  }
  const trades: Trade[] = [];
  for (const [tid, { items }] of byTid) {
    const first = items[0];
    let minS = Infinity;
    let maxE = -Infinity;
    let amount = 0;
    const seenRowKeys = new Set<string>();
    const equipments: EquipmentItem[] = [];
    items.forEach((it: any, idx: number) => {
      const s = toMs(it.s);
      const e = toMs(it.e);
      if (s < minS) minS = s;
      if (e > maxE) maxE = e;
      // 타임라인은 세트 수량 N이면 같은 스케줄 행을 바 N개로 복제한다(시각화용) —
      // 품목/금액은 행당 1번만 만들어야 함. 안 그러면 "숏노가암 ×4"가 4줄로 중복 표시됨.
      const rowKey = `${it.g}|${it.r ?? idx}`;
      if (seenRowKeys.has(rowKey)) return;
      seenRowKeys.add(rowKey);
      if (typeof it.p === "number") amount += it.p;
      const name = groups.get(it.g) ?? it.eq ?? "장비";
      equipments.push({
        scheduleId: `${tid}-${it.r ?? idx}`,
        synthetic: true, // 행번호 기반 합성 ID — dashboard merge 전까지 시트 write-back 금지
        name,
        qty: parseInt(String(it.q ?? "").replace(/[^0-9]/g, ""), 10) || 1, // "2세트" 같은 문자열 수량 파싱
        category: categoryOf(name) ?? undefined,
        checkoutState: it.st === "대기" ? "pending" : "taken",
      } as EquipmentItem);
    });
    const cs = st2contract(first.st);
    trades.push({
      tradeId: tid,
      customerName: first.cn ?? "",
      customerPhone: first.t ?? "",
      checkoutAt: new Date(minS).toISOString(),
      returnAt: new Date(maxE).toISOString(),
      contractStatus: cs,
      amount: amount || undefined,
      // 상태로 검수 플래그 추론 (과거 완료건이 '지연'으로 잘못 잡히는 것 방지)
      setupDone: cs === "반출" || cs === "반납완료",
      returnDone: cs === "반납완료",
      returnDoneAt: cs === "반납완료" ? new Date(maxE).toISOString() : undefined,
      photos: [],
      riskWarnings: [],
      returnCounts: {},
      equipments,
    });
  }
  return trades;
}

/** 동기화 실행: timeline 범위 읽어 Supabase에 upsert. onLog로 진행 보고 */
export async function syncTimelineToSupabase(opts?: { fromDays?: number; toDays?: number; onLog?: (s: string) => void }): Promise<number> {
  const log = opts?.onLog ?? (() => {});
  const today = new Date();
  const from = ymd(new Date(today.getTime() + (opts?.fromDays ?? -30) * 86400000));
  const to = ymd(new Date(today.getTime() + (opts?.toDays ?? 180) * 86400000));
  log(`GAS timeline 읽는 중… (${from} ~ ${to})`);
  const res = await gasFetch(`action=timeline&from=${from}&to=${to}&compact=2`);
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  const trades = parseTimeline(data);
  log(`예약 ${trades.length}건 파싱 → Supabase 적재 중…`);
  // 기존 거래는 merge 경유로만 갱신 — 사진/반납카운트/검수플래그를 timeline 추정값으로 리셋하지 않음
  const existingMap = new Map((await fetchAllTrades()).map((t) => [t.tradeId, t]));
  let n = 0;
  for (const t of trades) {
    const ex = existingMap.get(t.tradeId);
    await persistTrade(ex ? mergeTimelineTradeSnapshot(ex, t) : t);
    n++;
    if (n % 10 === 0) log(`  …${n}/${trades.length}`);
  }
  log(`완료: ${n}건 동기화됨 (기존 ${existingMap.size}건은 보존 merge)`);
  return n;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function dashboardCautionPhase(it: any): Phase {
  const phase = String(it?.cardCautionsPhase || it?._type || it?.phase || "").toLowerCase();
  return phase === "return" || phase === "checkin" ? "checkin" : "checkout";
}

function dashboardCautionSeverity(value: unknown): 1 | 2 | 3 {
  const severity = Number(value || 1);
  return severity === 3 || severity === 2 ? severity : 1;
}

function dashboardCautionRiskLevel(severity: number): RiskLevel {
  if (severity === 3) return "high";
  if (severity === 2) return "medium";
  return "low";
}

function mapDashboardCardCautions(it: any): RiskWarning[] {
  const raw = Array.isArray(it?.cardCautions) ? it.cardCautions : [];
  const phase = dashboardCautionPhase(it);
  const hiddenCount = Math.max(0, Number(it?.cardCautionsHiddenCount || 0) || 0);
  const totalMatched = Math.max(0, Number(it?.cardCautionsTotalMatched || 0) || 0);
  return raw
    .map((c: any) => ({ caution: c, text: sanitizeCautionDisplayText(c?.text) }))
    .filter(({ text }: { text: string }) => text)
    .slice(0, 5)
    .map(({ caution: c, text }: { caution: any; text: string }, i: number) => {
      const severity = dashboardCautionSeverity(c?.severity);
      const equipmentName = String(c?.equipment || c?.matched_item || "").trim();
      return {
        id: `card-caution:${phase}:${i}:${equipmentName}:${text.slice(0, 40)}`,
        phase,
        equipmentName,
        riskLevel: dashboardCautionRiskLevel(severity),
        customerMessage: text,
        guidanceState: severity === 3 ? "발송권장" : "대상없음",
        source: "cardCaution",
        severity,
        scope: String(c?.scope || "").trim() || undefined,
        matchedItem: String(c?.matched_item || "").trim() || undefined,
        hiddenCount,
        totalMatched,
      };
    });
}

function mergeDashboardCardCautions(base: Trade, it: any): RiskWarning[] {
  const phase = dashboardCautionPhase(it);
  const preservedOtherPhase = (base.riskWarnings ?? []).filter((w) => w.source === "cardCaution" && w.phase !== phase);
  return [...preservedOtherPhase, ...mapDashboardCardCautions(it)];
}

function dashboardCardCautionSignature(warnings: RiskWarning[]): string {
  return JSON.stringify(
    warnings
      .filter((w) => w.source === "cardCaution")
      .map((w) => ({
        phase: w.phase,
        text: w.customerMessage,
        equipment: w.equipmentName,
        severity: w.severity,
        hidden: w.hiddenCount || 0,
        total: w.totalMatched || 0,
      })),
  );
}

function hasDashboardCardCautionChange(base: Trade, it: any): boolean {
  return dashboardCardCautionSignature(base.riskWarnings ?? []) !== dashboardCardCautionSignature(mergeDashboardCardCautions(base, it));
}

/** action=dashboard 항목을 기존 거래(날짜 유지) 위에 상세 덮어쓰기.
 *  isSetHeader는 raw 헤더여부(isHeader)로 저장 → 라벨/노출 판정은 읽기(normalizeItems) 단일소스. */
function mergeDashboard(base: Trade, it: any): Trade {
  // 품목은 scheduleId 단위 merge — 시트가 모르는 앱 전용 상태(제외/부분픽업/메모/오프셋/정산)를 보존
  const baseById = new Map(base.equipments.map((e) => [e.scheduleId, e]));
  const incoming: EquipmentItem[] = (it.equipments ?? []).map((e: any) => {
    const prev = baseById.get(e.scheduleId);
    return {
      scheduleId: e.scheduleId,
      name: e.name,
      qty: Number(e.qty) || 1,
      setName: e.setName || undefined,
      isSetHeader: !!e.isHeader,
      isComponent: !!e.isComponent,
      emphasize: EMPH.test(e.name) || undefined,
      category: e.category || categoryOf(e.name) || undefined, // 장비마스터 실제 카테고리 우선
      // 원장에 다시 보이는 행은 앱 캐시의 excluded 상태로 숨기지 않는다.
      // 제외는 GAS 삭제 성공 후 원장에서 사라져야 확정이다.
      // 현장추가는 물리적으로 이미 나간 품목 — 시트 체크박스가 늦더라도 taken 유지
      checkoutState:
        e.checkedCheckout ? "taken"
        : prev?.onsite && prev?.checkoutState === "taken" ? "taken"
        : "pending",
      takenQty: prev?.takenQty,
      memoCheckout: prev?.memoCheckout ?? prev?.memoCheckin,
      memoCheckin: prev?.memoCheckin ?? prev?.memoCheckout,
      startShiftDays: prev?.startShiftDays,
      endShiftDays: prev?.endShiftDays,
      settlement: prev?.settlement,
      offCatalog: prev?.offCatalog,
      onsite: prev?.onsite, // 시트에 기록된 현장추가도 '현장 추가' 구획에 계속 묶이도록 보존
    } as EquipmentItem;
  });
  // 시트에 없는 앱 전용 품목(현장추가 등 유상 청구 대상)은 절대 삭제하지 않음.
  // 단, 거래ID-숫자 형태의 원장 스케줄ID는 onsite/offCatalog 플래그가 남아 있어도 시트 행으로 본다.
  const incomingIds = new Set(incoming.map((e) => e.scheduleId));
  const appOnly = base.equipments.filter((e) => !incomingIds.has(e.scheduleId) && isPreservedAppOnlyItem(base.tradeId, e));
  const equipments = incoming.length ? [...incoming, ...appOnly] : base.equipments;

  const returnCounts: Record<string, ReturnCount> = {};
  for (const e of it.equipments ?? []) {
    if (e.isHeader) continue;
    if (e.checkedCheckin) {
      returnCounts[e.scheduleId] = { good: Number(e.qty) || 1, damaged: 0, lost: 0 }; // scheduleId 단위
    }
  }
  // 앱이 기록한 파손/분실 카운트는 시트 체크박스보다 정보가 많음 — 보존
  for (const [sid, rc] of Object.entries(base.returnCounts ?? {})) {
    if ((rc.damaged ?? 0) > 0 || (rc.lost ?? 0) > 0) returnCounts[sid] = rc;
  }

  // GAS paymentWarning은 "거래내역 조회 실패" 에러 문자열 — 실패 시 결제 필드 merge 금지 (기본값 wipe 방지)
  const extrasFailed = typeof it.paymentWarning === "string" && it.paymentWarning.trim().length > 0;
  const payment = extrasFailed
    ? {
        paymentMethod: base.paymentMethod,
        depositStatus: base.depositStatus,
        proofType: base.proofType,
        issueStatus: base.issueStatus,
        issueNote: base.issueNote,
        billingCompany: base.billingCompany,
      }
    : {
        paymentMethod: it.paymentMethod || base.paymentMethod,
        depositStatus: it.depositStatus || base.depositStatus,
        proofType: it.proofType || base.proofType,
        issueStatus: it.issueStatus || base.issueStatus,
        issueNote: it.issueNote || base.issueNote,
        billingCompany: it.billingCompany || base.billingCompany,
      };

  return {
    ...base,
    // 거래내역 I열 실 결제금액이 정산 표시의 기준 — 타임라인 단가합(추정치)을 대체
    amount: typeof it.actualAmount === "number" && it.actualAmount > 0 ? it.actualAmount : base.amount,
    customerName: it.name || base.customerName,
    customerPhone: it.tel || base.customerPhone,
    company: it.company || base.company,
    contractStatus: it.contractStatus || base.contractStatus,
    setupDone: !!it.setupDone,
    returnDone: !!it.returnDone,
    setupDoneAt: it.setupDoneAt || undefined,
    returnDoneAt: it.returnDoneAt || undefined,
    ...payment,
    paymentWarning: base.paymentWarning, // 에러 문자열을 경고 플래그로 둔갑시키지 않음
    contractUrl: it.contractUrl || base.contractUrl,
    contractRegenPending: !!it.contractRegenPending,
    noteCheckin: it.returnMemo || base.noteCheckin,
    riskWarnings: mergeDashboardCardCautions(base, it),
    returnCounts,
    equipments,
  };
}

/** 대시보드 상세를 날짜 윈도우로 동기화(기존 거래에 덮어쓰기) */
export async function syncDashboardToSupabase(opts?: { fromDays?: number; toDays?: number; onLog?: (s: string) => void }): Promise<number> {
  const log = opts?.onLog ?? (() => {});
  const existing = new Map((await fetchAllTrades()).map((t) => [t.tradeId, t]));
  log(`기존 ${existing.size}건 기준, 대시보드 상세 동기화…`);
  const pending = new Map<string, Trade>();
  let n = 0;
  let skipped = 0;
  const fromD = opts?.fromDays ?? -2;
  const toD = opts?.toDays ?? 14;
  for (let i = fromD; i <= toD; i++) {
    const date = ymd(new Date(Date.now() + i * DAY));
    try {
      const res = await gasFetch(`action=dashboard&date=${date}`);
      const data = await res.json();
      if (data.error) continue;
      const items = [...(data.checkout ?? []), ...(data.checkin ?? [])];
      for (const it of items) {
        const tid = it.tradeId;
        if (!tid) continue;
        const base = pending.get(tid) ?? existing.get(tid);
        if (!base) {
          skipped++;
          continue;
        }
        pending.set(tid, mergeDashboard(base, it));
        n++;
      }
      log(`  ${date}: 누적 ${n}건`);
    } catch {
      /* 한 날짜 실패는 건너뜀 */
    }
  }
  for (const t of pending.values()) await persistTrade(t);
  log(`대시보드 상세 ${n}건 반영 (윈도우 밖 ${skipped}건 스킵)`);
  return n;
}

function needsDashboardDetailRepair(t: Trade): boolean {
  return t.equipments.length === 0 || !t.contractUrl;
}

function currentEquipmentCount(t: Trade): number {
  return t.equipments.length;
}

function incomingEquipmentCount(it: any): number {
  return Array.isArray(it?.equipments) ? it.equipments.length : 0;
}

function isPreservedAppOnlyItem(tradeId: string, e: EquipmentItem): boolean {
  return !!(e.onsite || e.offCatalog) && !isSheetBackedScheduleId(e.scheduleId, tradeId);
}

function hasSheetBackedItemsMissingFromDashboard(base: Trade, it: any): boolean {
  const incomingIds = new Set(
    (it?.equipments ?? [])
      .map((e: any) => String(e?.scheduleId || "").trim())
      .filter(Boolean),
  );
  if (!incomingIds.size) return false;
  return base.equipments.some(
    (e) => !e.synthetic && isSheetBackedScheduleId(e.scheduleId, base.tradeId) && !incomingIds.has(e.scheduleId),
  );
}

function shouldUseDashboardDetail(base: Trade, it: any, options: DashboardDetailOptions = {}): boolean {
  const amountFix =
    typeof it?.actualAmount === "number" && it.actualAmount > 0 && it.actualAmount !== (base.amount ?? 0);
  // 합성(타임라인 유래) 품목이 남아 있으면 개수와 무관하게 dashboard 실데이터로 교체 —
  // 과거 중복 생성된 목록은 정상 목록보다 길어서 개수 비교만으로는 영원히 복구되지 않음
  const hasSynthetic = incomingEquipmentCount(it) > 0 && base.equipments.some((e) => e.synthetic);
  // 스케줄상세에서 수동 삭제된 행은 Supabase 캐시에 남기면 앱에 유령 장비가 계속 보인다.
  // 단, 현장추가/자유입력 앱 전용 품목은 mergeDashboard에서 계속 보존한다.
  const sheetBackedDeleted = options.authoritativeForMissingSheetBacked && hasSheetBackedItemsMissingFromDashboard(base, it);
  // 계약서 재생성으로 링크가 '바뀐' 경우 — 없을 때만 갱신하면 옛 링크를 영원히 들고 있음
  const contractUrlChanged = !!it?.contractUrl && it.contractUrl !== base.contractUrl;
  const cautionsChanged = hasDashboardCardCautionChange(base, it);
  return (
    incomingEquipmentCount(it) > currentEquipmentCount(base) ||
    sheetBackedDeleted ||
    contractUrlChanged ||
    amountFix ||
    hasSynthetic ||
    cautionsChanged
  );
}

function repairFromDashboardItems(current: Trade[], items: any[], options: DashboardDetailOptions = {}): Trade[] {
  const existing = new Map(current.map((t) => [t.tradeId, t]));
  const changed = new Map<string, Trade>();
  for (const it of items) {
    const tid = it.tradeId;
    if (!tid || changed.has(tid)) continue;
    const base = existing.get(tid);
    if (!base) continue;
    if (shouldUseDashboardDetail(base, it, options)) {
      const merged = mergeDashboard(base, it);
      changed.set(
        tid,
        options.authoritativeForMissingSheetBacked && hasSheetBackedItemsMissingFromDashboard(base, it)
          ? markPruneMissingSheetBacked(merged)
          : merged,
      );
    }
  }
  return [...changed.values()];
}

function missingSheetBackedTradeIds(current: Trade[], items: any[]): string[] {
  const existing = new Map(current.map((t) => [t.tradeId, t]));
  const ids = new Set<string>();
  for (const it of items) {
    const tid = String(it?.tradeId || "").trim();
    if (!tid || ids.has(tid)) continue;
    const base = existing.get(tid);
    if (base && hasSheetBackedItemsMissingFromDashboard(base, it)) ids.add(tid);
  }
  return [...ids];
}

async function fetchDashboardSearchItemsForTradeIds(tradeIds: string[]): Promise<any[]> {
  const wanted = new Set(tradeIds.map((tid) => tid.trim()).filter(Boolean));
  if (!wanted.size) return [];

  const byId = new Map<string, any>();
  for (const tid of wanted) {
    try {
      const res = await gasFetch(`action=dashboardSearch&q=${encodeURIComponent(tid)}&limit=20`);
      const data = await res.json();
      if (data.error) continue;
      const items = [...(data.checkout ?? []), ...(data.checkin ?? [])];
      for (const it of items) {
        const itemTid = String(it?.tradeId || "").trim();
        if (wanted.has(itemTid) && !byId.has(itemTid)) byId.set(itemTid, it);
      }
    } catch {
      /* 검색 복구 실패 거래만 건너뜀 */
    }
  }
  return [...byId.values()];
}

/** Supabase 캐시에 품목/계약서 등 dashboard 상세가 빠진 거래를 즉시 복구 */
export async function repairDashboardDetailsForIncompleteTrades(current: Trade[]): Promise<Trade[]> {
  const repairIds = new Set(current.filter(needsDashboardDetailRepair).map((t) => t.tradeId));
  if (!repairIds.size) return [];

  const existing = new Map(current.map((t) => [t.tradeId, t]));
  const dates = new Set<string>();
  for (const t of current) {
    if (!repairIds.has(t.tradeId)) continue;
    dates.add(ymd(new Date(t.checkoutAt)));
    dates.add(ymd(new Date(t.returnAt)));
  }

  const changed = new Map<string, Trade>();
  for (const date of dates) {
    try {
      const res = await gasFetch(`action=dashboard&date=${date}`);
      const data = await res.json();
      if (data.error) continue;
      const items = [...(data.checkout ?? []), ...(data.checkin ?? [])];
      for (const it of items) {
        const tid = it.tradeId;
        if (!repairIds.has(tid) || changed.has(tid)) continue;
        const base = existing.get(tid);
        if (!base) continue;
        changed.set(tid, mergeDashboard(base, it));
      }
    } catch {
      /* 복구 실패 날짜만 건너뜀 */
    }
  }
  return [...changed.values()];
}

/** 날짜 화면 진입 시 Supabase 캐시가 원장보다 짧은 거래를 dashboard 상세로 즉시 복구 */
export async function repairDashboardDateDetails(current: Trade[], date: string): Promise<Trade[]> {
  date = date.trim();
  if (!date) return [];
  try {
    const res = await gasFetch(`action=dashboard&date=${date}&nocache=1`);
    const data = await res.json();
    if (data.error) return [];
    const items = [...(data.checkout ?? []), ...(data.checkin ?? [])];
    const changed = repairFromDashboardItems(current, items);
    const authoritativeItems = await fetchDashboardSearchItemsForTradeIds(missingSheetBackedTradeIds(current, items));
    const authoritativeChanged = repairFromDashboardItems(current, authoritativeItems, { authoritativeForMissingSheetBacked: true });
    const byId = new Map(changed.map((t) => [t.tradeId, t]));
    for (const t of authoritativeChanged) byId.set(t.tradeId, t);
    return [...byId.values()];
  } catch {
    return [];
  }
}

/** 검색 중 Supabase 캐시가 원장보다 짧은 거래를 dashboardSearch 상세로 즉시 복구 */
export async function repairDashboardSearchResults(current: Trade[], query: string): Promise<Trade[]> {
  query = query.trim();
  if (query.length < 2) return [];

  try {
    const res = await gasFetch(`action=dashboardSearch&q=${encodeURIComponent(query)}`);
    const data = await res.json();
    if (data.error) return [];
    const items = [...(data.checkout ?? []), ...(data.checkin ?? [])];
    const changed = repairFromDashboardItems(current, items, { authoritativeForMissingSheetBacked: true });

    // 시트에는 있는데 스토어에 아직 없는 신규 거래(방금 등록된 건) → timeline에서 통째로 가져와 합류
    const known = new Set(current.map((t) => t.tradeId));
    const hasUnknown = items.some((it) => it?.tradeId && !known.has(it.tradeId));
    if (hasUnknown) {
      const fresh = await pollTimelineChanges(current);
      const byId = new Map(changed.map((t) => [t.tradeId, t]));
      for (const t of fresh) if (!byId.has(t.tradeId)) byId.set(t.tradeId, t);
      return [...byId.values()];
    }
    return changed;
  } catch {
    return [];
  }
}

/** 전체 동기화: timeline(날짜·예약) → dashboard(상세) */
export async function syncAll(onLog?: (s: string) => void): Promise<void> {
  await syncTimelineToSupabase({ fromDays: -30, toDays: 180, onLog });
  await syncDashboardToSupabase({ fromDays: -2, toDays: 14, onLog });
}

/**
 * 가벼운 폴링: timeline에서 예약의 날짜/고객/금액 변경·신규만 골라 반환.
 * 앱이 가진 ops(검수·결제·제외·반납카운트·장비구조)는 보존(시트 timeline엔 없으므로 덮어쓰지 않음).
 */
export async function pollTimelineChanges(current: Trade[]): Promise<Trade[]> {
  const today = new Date();
  const from = ymd(new Date(today.getTime() - 30 * DAY));
  const to = ymd(new Date(today.getTime() + 180 * DAY));
  const res = await gasFetch(`action=timeline&from=${from}&to=${to}&compact=2`);
  const data = await res.json();
  if (data.error) return [];
  const fresh = parseTimeline(data);
  const byId = new Map(current.map((t) => [t.tradeId, t]));
  const changed: Trade[] = [];
  for (const tl of fresh) {
    const ex = byId.get(tl.tradeId);
    if (!ex) {
      changed.push(tl); // 신규 예약(시트에서 막 들어옴)
      continue;
    }
    // 문자열 비교 금지: timestamptz 왕복(+00:00)과 toISOString(.000Z)이 같은 시각도 다르게 보임 → epoch 비교
    const nameChanged = ex.customerName !== tl.customerName && tl.customerName !== tl.tradeId; // 계약마스터 매칭 실패 시 cn=거래ID 폴백 제외
    if (
      toMs(ex.checkoutAt) !== toMs(tl.checkoutAt) ||
      toMs(ex.returnAt) !== toMs(tl.returnAt) ||
      nameChanged ||
      shouldRestoreMissingTimelineEquipments(ex, tl)
    ) {
      changed.push(mergeTimelineTradeSnapshot(ex, tl));
    }
  }
  return changed;
}
