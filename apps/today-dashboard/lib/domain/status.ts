// 상태/시간 헬퍼 — 한국어 시간 정렬, 확인필요 집계, 인계 요약

import type { EquipmentItem, ReturnCount, Trade, TabKey, Phase } from "./types";

function equipmentActualName(item: EquipmentItem): string {
  return String(item.actualName || item.name || "").trim();
}

function equipmentActualTakenQty(item: EquipmentItem): number {
  const value = item.actualTakenQty ?? item.takenQty ?? item.qty;
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : 0;
}

const WEEKDAY = ["일", "월", "화", "수", "목", "금", "토"];

export function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
export function parseYmd(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}
export function addDays(s: string, n: number): string {
  const d = parseYmd(s);
  d.setDate(d.getDate() + n);
  return ymd(d);
}
export function formatDateLabel(s: string): string {
  const d = parseYmd(s);
  return `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일 (${WEEKDAY[d.getDay()]})`;
}
export function shortDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}
export function timeLabel(iso: string): string {
  const d = new Date(iso);
  const h = d.getHours();
  const m = d.getMinutes();
  const ampm = h < 12 ? "오전" : "오후";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${ampm} ${h12}:${String(m).padStart(2, "0")}`;
}
export function timeSortKey(iso: string): number {
  const d = new Date(iso);
  return d.getHours() * 60 + d.getMinutes();
}
export function timeBand(iso: string): string {
  const h = new Date(iso).getHours();
  if (h < 12) return "오전";
  if (h < 17) return "오후";
  return "저녁";
}

export function phaseForDate(t: Trade, date: string): "checkout" | "checkin" | "both" | "none" {
  const isOut = ymd(new Date(t.checkoutAt)) === date;
  const isIn = ymd(new Date(t.returnAt)) === date;
  if (isOut && isIn) return "both";
  if (isOut) return "checkout";
  if (isIn) return "checkin";
  return "none";
}

/** 반출 당시 실제 포함 품목 기록은 반납 검증을 위해 고정한다. 예약 장비명·수량 편집에는 쓰지 않는다. */
export function isCheckoutBaselineLocked(t: Trade): boolean {
  return (
    t.setupDone ||
    t.returnDone ||
    t.contractStatus === "반출" ||
    t.contractStatus === "반납완료" ||
    t.equipments.some((item) => Number(item.takenQty || 0) > 0)
  );
}

// ── 반납: 품목 종류별 합산 ──────────────────────────────────────
export interface AggReturn {
  name: string;
  scheduleId: string;
  category?: string;
  expected: number; // 나간 수량(부분픽업 반영)
  onsiteQty: number;
  count: ReturnCount; // 반납 상태
}

const EMPTY_RC: ReturnCount = { good: 0, damaged: 0, lost: 0 };

/** 반납 상태는 scheduleId 단위(returnCounts[scheduleId])로 기록 — 세트 구성품 개별 추적 */
export function rcOf(t: Trade, scheduleId: string): ReturnCount {
  return t.returnCounts?.[scheduleId] ?? EMPTY_RC;
}

/** 거래의 나간 품목을 줄(scheduleId) 단위로 — 세트 묶음/시트순서 보존, 집계·진행도용.
 *  체크리스트가 실제로 렌더하는 '체크 가능한 행'(checkableItems)과 동일 집합을 사용해
 *  진행도 카운트와 화면 줄 수가 항상 일치하도록 한다.
 *  (세트 대표행 = 실제 메인 장비면 포함, 단순 번들 라벨이면 제외) */
export function aggregateReturns(t: Trade): AggReturn[] {
  return checkableItems(t, "checkin").map((e) => {
    const qty = equipmentActualTakenQty(e);
    return { name: equipmentActualName(e), scheduleId: e.scheduleId, category: e.category, expected: qty, onsiteQty: e.onsite ? qty : 0, count: rcOf(t, e.scheduleId) };
  });
}

/** 품목을 세트 단위로 묶음 (반출/반납 공통). 세트명 있는 것끼리, 단품은 연속해서 한 묶음. */
export interface SetGroup {
  key: string;
  setName?: string; // 있으면 세트 박스, 없으면 단품 묶음
  header?: EquipmentItem; // 첫 세트 대표행(호환용)
  headers: EquipmentItem[]; // 같은 세트명으로 독립 반출된 대표행을 모두 보존
  rows: EquipmentItem[]; // 구성품/단품
}

function setKeyOf(value?: string | null): string {
  return String(value ?? "").trim().replace(/\s+/g, "").toLowerCase();
}

function sameSetKey(a?: string | null, b?: string | null): boolean {
  const ak = setKeyOf(a);
  return !!ak && ak === setKeyOf(b);
}

export function groupBySet(items: EquipmentItem[]): SetGroup[] {
  const groups: SetGroup[] = [];
  const bySet = new Map<string, SetGroup>();
  const setNameByKey = new Map<string, string>();
  items.forEach((e) => {
    if (e.setName) setNameByKey.set(setKeyOf(e.setName), e.setName);
  });

  for (const e of items) {
    const inferredSetName = e.setName ?? setNameByKey.get(setKeyOf(e.name));
    if (inferredSetName) {
      const inferredSetHeader = !!e.isSetHeader || (!e.setName && sameSetKey(e.name, inferredSetName));
      const groupKey = setKeyOf(inferredSetName);
      let g = bySet.get(groupKey);
      if (!g) {
        g = { key: "set:" + inferredSetName, setName: inferredSetName, headers: [], rows: [] };
        bySet.set(groupKey, g);
        groups.push(g);
      }
      if (inferredSetHeader) {
        const header = { ...e, setName: inferredSetName, isSetHeader: true };
        g.headers.push(header);
        if (!g.header) g.header = header;
      }
      else g.rows.push(e);
    } else {
      const last = groups[groups.length - 1];
      if (last && !last.setName) last.rows.push(e); // 연속 단품 합침
      else groups.push({ key: "loose:" + e.scheduleId, headers: [], rows: [e] });
    }
  }
  return groups;
}

/** 세트 묶음에서 '단일 컨트롤 행'(체크박스 하나로 세트 전체를 다루는 단품형 세트) 추출.
 *  구성품이 없거나(대표행만), 구성품 1개가 세트명과 동일하면 그 행 하나만 컨트롤로 노출. */
export function singleControllableSetItem(g: SetGroup): EquipmentItem | null {
  if (!g.setName) return null;
  if (g.rows.length === 0) return g.headers.length === 1 ? g.headers[0] : null;
  if (g.rows.length === 1 && sameSetKey(g.rows[0].name, g.setName) && realDeviceHeaders(g).length === 0) return g.rows[0];
  return null;
}

// '~세트/셋업/패키지' 처럼 묶음 자체를 가리키는 라벨 — 대표행이 실제 장비가 아님
const BUNDLE_LABEL_RE = /세트|셋트|셋업|패키지|풀구성/;

/** 구성품이 있는 세트의 대표행(g.header)이 '실제 메인 장비'인지 판정.
 *  - 이름이 번들 라벨(~세트/셋업/패키지)이면 메인 장비 아님(제목으로만)
 *  - 구성품 중 대표행 이름과 포함관계인 것이 있으면(예: '소니 FX6 바디' ⊂ '소니 FX6 바디세트')
 *    그 구성품이 실제 본체이므로 대표행은 라벨로 취급
 *  - 그 외(예: '스몰HD 인디7' + 구성품 'D탭')는 대표행 자체가 메인 장비 → 체크 대상 */
export function isRealDeviceHeader(header: EquipmentItem | undefined, rows: EquipmentItem[]): boolean {
  if (!header) return false;
  const hk = setKeyOf(header.name);
  if (!hk) return false;
  if (BUNDLE_LABEL_RE.test(String(header.name).replace(/\s+/g, ""))) return false;
  for (const r of rows) {
    const rk = setKeyOf(r.name);
    if (rk && (hk.includes(rk) || rk.includes(hk))) return false;
  }
  return true;
}

/** 같은 세트명 아래 중복 대표행을 덮어쓰지 않고, 실제 장비인 대표행을 모두 반환한다. */
export function realDeviceHeaders(g: SetGroup): EquipmentItem[] {
  if (!g.setName) return [];
  if (g.rows.length === 0) return g.headers;
  return g.headers.filter((header) => isRealDeviceHeader(header, g.rows));
}

/** 한 묶음 리스트를 체크리스트가 렌더하는 '체크 가능한 행' 순서대로 평탄화 (렌더링과 동일 규칙) */
function flatGroupCheckable(list: EquipmentItem[]): EquipmentItem[] {
  const out: EquipmentItem[] = [];
  for (const g of groupBySet(list)) {
    if (g.setName) {
      const single = singleControllableSetItem(g);
      if (single) {
        out.push(single);
        continue;
      }
      out.push(...realDeviceHeaders(g));
      out.push(...g.rows);
    } else {
      out.push(...g.rows);
    }
  }
  return out;
}

/** 체크리스트에 인터랙티브(체크/제외/메모) 행으로 노출되는 품목들 — 진행도 카운트의 단일 소스.
 *  반납은 반출에서 제외된 품목(안 나간 것)은 받을 게 없으므로 뺀다. */
export function checkableItems(t: Trade, phase: "checkout" | "checkin"): EquipmentItem[] {
  const pool = phase === "checkin"
    ? t.equipments.filter((e) => e.checkoutState !== "excluded" && equipmentActualTakenQty(e) > 0)
    : t.equipments;
  const booked = pool.filter((e) => !e.onsite);
  const onsite = pool.filter((e) => e.onsite);
  return [...flatGroupCheckable(booked), ...flatGroupCheckable(onsite)];
}

export function missingOf(a: AggReturn): number {
  return Math.max(0, a.expected - a.count.good - a.count.damaged - a.count.lost);
}
export function isReturnDone(a: AggReturn): boolean {
  return a.count.good + a.count.damaged + a.count.lost === a.expected;
}

export interface ReturnCompletionBlocker {
  scheduleId: string;
  name: string;
  expected: number;
  accounted: number;
  missing: number;
  over: number;
}

/**
 * 거래 전체를 반납완료로 닫기 전에 반드시 해소해야 하는 수량 불일치.
 * 정상/파손/분실 중 어느 상태든 합계가 실제 반출 수량과 정확히 같아야 한다.
 */
export function returnCompletionBlockers(t: Trade): ReturnCompletionBlocker[] {
  // taken_qty 도입 전 완료된 레거시 거래에는 불변 반출 기준선이 없다. 예약 qty를
  // 사후 기준선처럼 소급 적용하면 과거 완료 카드 수백 건이 확인필요로 부활한다.
  // 기준선이 한 행이라도 시작된 거래(김동민 사고 건 및 향후 반출)만 새 차단을 적용한다.
  if (!checkableItems(t, "checkin").some((e) => Number(e.takenQty ?? 0) > 0 || e.actualTakenQty != null)) return [];
  return aggregateReturns(t)
    .map((a) => {
      const accounted = a.count.good + a.count.damaged + a.count.lost;
      return {
        scheduleId: a.scheduleId,
        name: a.name,
        expected: a.expected,
        accounted,
        missing: Math.max(0, a.expected - accounted),
        over: Math.max(0, accounted - a.expected),
      };
    })
    .filter((a) => a.accounted !== a.expected);
}

export function returnBadge(t: Trade): string | null {
  const aggs = aggregateReturns(t);
  if (aggs.some((a) => a.count.lost > 0)) return "분실";
  if (aggs.some((a) => a.count.damaged > 0)) return "파손";
  if (aggs.some((a) => missingOf(a) > 0 && ((a.count.good + a.count.damaged + a.count.lost) > 0 || Number(a.count.reportedMissing || 0) > 0))) return "미반납";
  return null;
}

// 확인필요로 잡히는 '주된 이유' — 배지 분해용. 한 거래가 여러 조건에 걸려도
// 아래 우선순위로 딱 하나만 대표 이유로 센다(그래서 분해 합계 = 확인필요 총합).
export type AttentionReason = "return_mismatch" | "damage" | "overdue" | "deposit" | "payment" | "risk";

export const ATTENTION_REASON_LABEL: Record<AttentionReason, string> = {
  return_mismatch: "반납수량",
  damage: "파손/분실",
  overdue: "미마감",
  deposit: "보증금",
  payment: "결제",
  risk: "위험",
};

export function attentionReason(t: Trade, date: string): AttentionReason | null {
  const aggs = aggregateReturns(t);
  // 이미 닫힌 과거 데이터라도 수량이 맞지 않으면 완료로 숨기지 않고 즉시 다시 드러낸다.
  if (t.returnDone && returnCompletionBlockers(t).length > 0) return "return_mismatch";
  if (aggs.some((a) => a.count.damaged > 0 || a.count.lost > 0)) return "damage";
  const overdue = new Date(t.returnAt) < new Date(`${date}T00:00:00`) && !t.returnDone;
  if (overdue) return "overdue";
  if (t.depositStatus && /미|대기|예정/.test(t.depositStatus)) return "deposit";
  if (t.paymentWarning) return "payment";
  // 위험(장비 카드주의/발송권장)은 '아직 처리 안 된 단계'에만 유효하다. 카드주의는 장비 단위
  // 상시 안내라, 이미 끝난 거래·지난 단계까지 세면 확인필요가 크게 부풀려진다(완료된 반납 건이
  // 렌즈 주의문구 하나로 확인필요에 잡히던 문제). 반출 안내는 반출 전, 반납 안내는 반납완료 전까지만.
  if (
    t.riskWarnings.some((r) => {
      const flagged = r.source === "cardCaution" ? r.severity === 3 : r.guidanceState === "발송권장";
      if (!flagged) return false;
      if (r.phase === "checkout") return !t.setupDone;
      return !t.returnDone;
    })
  )
    return "risk";
  return null;
}

export function needsAttention(t: Trade, date: string): boolean {
  return attentionReason(t, date) !== null;
}

// 확인필요 총합을 이유별로 분해. 취소 거래는 tradesForTab(attention)과 동일하게 제외 →
// 분해 합계가 화면 배지 숫자와 정확히 일치한다.
export function attentionBreakdown(trades: Trade[], date: string): Record<AttentionReason, number> {
  const acc: Record<AttentionReason, number> = { return_mismatch: 0, damage: 0, overdue: 0, deposit: 0, payment: 0, risk: 0 };
  for (const t of trades) {
    if (isCancelledTrade(t)) continue;
    const r = attentionReason(t, date);
    if (r) acc[r] += 1;
  }
  return acc;
}

export function isCancelledTrade(t: Trade): boolean {
  return t.contractStatus === "취소";
}

export function tradesForTab(trades: Trade[], date: string, tab: TabKey): Trade[] {
  // 취소 거래는 오조작 방지를 위해 오늘일정 작업 카드에서 제외한다.
  let list = trades.filter((t) => !isCancelledTrade(t));
  if (tab === "checkout") {
    list = list.filter((t) => {
      const p = phaseForDate(t, date);
      return p === "checkout" || p === "both";
    });
  } else if (tab === "checkin") {
    list = list.filter((t) => {
      const p = phaseForDate(t, date);
      return p === "checkin" || p === "both";
    });
  } else if (tab === "attention") {
    list = list.filter((t) => needsAttention(t, date));
  } else if (tab === "all") {
    // '전체'는 이 날짜에 실제로 걸치는 거래만 — 오늘 반출/반납 + 오늘 대여 중인 건.
    // (예전엔 필터가 없어 로드된 -30일~+365일 전체 435건을 다 셌고, 날짜와 무관한 미래
    //  예약·과거 완료까지 섞여 '전체 435인데 화면엔 몇 개'로 보였다.)
    const dayStart = new Date(`${date}T00:00:00`).getTime();
    const dayEnd = new Date(`${date}T23:59:59.999`).getTime();
    list = list.filter((t) => {
      const co = new Date(t.checkoutAt).getTime();
      const ro = new Date(t.returnAt).getTime();
      if (Number.isNaN(co) || Number.isNaN(ro)) return false;
      return co <= dayEnd && ro >= dayStart; // 대여기간이 이 날짜와 겹침(반출·반납·진행중 포함)
    });
  }
  return [...list].sort((a, b) => {
    const ka = tab === "checkin" ? a.returnAt : a.checkoutAt;
    const kb = tab === "checkin" ? b.returnAt : b.checkoutAt;
    return timeSortKey(ka) - timeSortKey(kb);
  });
}

export interface TradeSearchEvent {
  key: string;
  trade: Trade;
  phase: Phase;
  at: string;
  date: string;
  groupLabel: string;
}

function normalizeSearchText(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "");
}

function tradeSearchText(t: Trade): string {
  return [
    t.customerName,
    t.customerPhone,
    t.tradeId,
    t.company,
    t.contractStatus,
    ...t.equipments.map((e) => e.name),
  ].join(" ");
}

function searchEventFor(t: Trade, phase: Phase): TradeSearchEvent {
  const at = phase === "checkout" ? t.checkoutAt : t.returnAt;
  const date = ymd(new Date(at));
  const label = phase === "checkout" ? "반출" : "반납";
  return {
    key: `${t.tradeId}:${phase}:${date}`,
    trade: t,
    phase,
    at,
    date,
    groupLabel: `${formatDateLabel(date)} · ${label}`,
  };
}

export function searchTradeEvents(trades: Trade[], query: string): TradeSearchEvent[] {
  const needle = normalizeSearchText(query);
  if (!needle) return [];

  const events = trades
    .filter((t) => !isCancelledTrade(t))
    .filter((t) => normalizeSearchText(tradeSearchText(t)).includes(needle))
    .flatMap((t) => [searchEventFor(t, "checkout"), searchEventFor(t, "checkin")]);

  return events.sort((a, b) => {
    const dateCompare = new Date(a.at).getTime() - new Date(b.at).getTime();
    if (dateCompare) return dateCompare;
    if (a.phase !== b.phase) return a.phase === "checkout" ? -1 : 1;
    return a.trade.tradeId.localeCompare(b.trade.tradeId);
  });
}

/** 이 탭 관점에서 이 카드가 '처리 완료'인지 (완료 카드는 아래로 치움) */
export function cardDone(t: Trade, date: string, tab: TabKey): boolean {
  // 확인필요 탭은 그 자체가 '손봐야 할 것' 목록 → 반납완료됐다고 접어 숨기면 배지 숫자와
  // 실제 보이는 카드가 어긋난다(보증금·파손처럼 반납 후에도 남는 확인필요를 놓침). 다 펼친다.
  if (tab === "attention") return false;
  if (tab === "checkout") return t.setupDone;
  if (tab === "checkin") return t.returnDone && returnCompletionBlockers(t).length === 0;
  const p = phaseForDate(t, date);
  if (p === "checkout") return t.setupDone;
  if (p === "checkin") return t.returnDone && returnCompletionBlockers(t).length === 0;
  if (p === "both") return t.setupDone && t.returnDone && returnCompletionBlockers(t).length === 0;
  return t.returnDone && returnCompletionBlockers(t).length === 0;
}

export function tabCounts(trades: Trade[], date: string): Record<TabKey, number> {
  return {
    checkout: tradesForTab(trades, date, "checkout").length,
    checkin: tradesForTab(trades, date, "checkin").length,
    all: tradesForTab(trades, date, "all").length,
    attention: tradesForTab(trades, date, "attention").length,
  };
}

/** 반출/반납 진행도 — 화면에 노출되는 체크 가능한 행과 동일 집합으로 계산 */
export function setupProgress(t: Trade, phase: "checkout" | "checkin"): { done: number; total: number } {
  if (phase === "checkin") {
    const aggs = aggregateReturns(t);
    return { done: aggs.filter(isReturnDone).length, total: aggs.length };
  }
  const list = checkableItems(t, "checkout");
  const done = list.filter((e) => e.checkoutState !== "pending").length;
  return { done, total: list.length };
}

/** 인계 요약: 체크리스트에서 자동 산출 (자유 텍스트 대체) */
export function handoverSummary(t: Trade, phase: "checkout" | "checkin"): string[] {
  const out: string[] = [];
  if (phase === "checkout") {
    const list = checkableItems(t, "checkout");
    const taken = list.filter((e) => e.checkoutState === "taken").length;
    const excluded = list.filter((e) => e.checkoutState === "excluded");
    const onsite = list.filter((e) => e.onsite);
    if (taken) out.push(`가져감 ${taken}`);
    if (excluded.length) out.push(`제외 ${excluded.length} (${excluded.map(short).join(", ")})`);
    if (onsite.length) out.push(`현장추가 ${onsite.length} (${onsite.map(short).join(", ")})`);
  } else {
    const aggs = aggregateReturns(t);
    const good = aggs.reduce((s, a) => s + a.count.good, 0);
    const missing = aggs.reduce((s, a) => s + (a.count.good + a.count.damaged + a.count.lost > 0 ? missingOf(a) : 0), 0);
    const damaged = aggs.reduce((s, a) => s + a.count.damaged, 0);
    const lost = aggs.reduce((s, a) => s + a.count.lost, 0);
    if (good) out.push(`반납 ${good}`);
    if (missing) out.push(`미반납 ${missing}`);
    if (damaged) out.push(`파손 ${damaged}`);
    if (lost) out.push(`분실 ${lost}`);
  }
  return out;
}

function short(e: { name: string }): string {
  return e.name.length > 10 ? e.name.slice(0, 10) + "…" : e.name;
}

export function won(n?: number): string {
  if (n == null) return "—";
  return n.toLocaleString("ko-KR") + "원";
}
