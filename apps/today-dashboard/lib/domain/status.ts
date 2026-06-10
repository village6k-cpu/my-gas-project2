// 상태/시간 헬퍼 — 한국어 시간 정렬, 확인필요 집계, 인계 요약

import type { EquipmentItem, ReturnCount, Trade, TabKey, Phase } from "./types";

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

/** 거래의 나간 품목을 줄(scheduleId) 단위로 — 세트 묶음/시트순서 보존, 집계·진행도용 */
export function aggregateReturns(t: Trade): AggReturn[] {
  const out: AggReturn[] = [];
  for (const e of t.equipments) {
    if (e.isSetHeader) continue;
    if (e.checkoutState === "excluded") continue; // 안 나감 → 받을 것 없음
    const qty = e.takenQty ?? e.qty;
    out.push({ name: e.name, scheduleId: e.scheduleId, category: e.category, expected: qty, onsiteQty: e.onsite ? qty : 0, count: rcOf(t, e.scheduleId) });
  }
  return out;
}

/** 품목을 세트 단위로 묶음 (반출/반납 공통). 세트명 있는 것끼리, 단품은 연속해서 한 묶음. */
export interface SetGroup {
  key: string;
  setName?: string; // 있으면 세트 박스, 없으면 단품 묶음
  header?: EquipmentItem; // 세트 대표행
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
      let g = bySet.get(inferredSetName);
      if (!g) {
        g = { key: "set:" + inferredSetName, setName: inferredSetName, rows: [] };
        bySet.set(inferredSetName, g);
        groups.push(g);
      }
      if (inferredSetHeader) g.header = { ...e, setName: inferredSetName, isSetHeader: true };
      else g.rows.push(e);
    } else {
      const last = groups[groups.length - 1];
      if (last && !last.setName) last.rows.push(e); // 연속 단품 합침
      else groups.push({ key: "loose:" + e.scheduleId, rows: [e] });
    }
  }
  return groups;
}

export function missingOf(a: AggReturn): number {
  return Math.max(0, a.expected - a.count.good - a.count.damaged - a.count.lost);
}
export function isReturnDone(a: AggReturn): boolean {
  return a.count.good + a.count.damaged + a.count.lost >= a.expected;
}

export function returnBadge(t: Trade): string | null {
  const aggs = aggregateReturns(t);
  if (aggs.some((a) => a.count.lost > 0)) return "분실";
  if (aggs.some((a) => a.count.damaged > 0)) return "파손";
  if (aggs.some((a) => missingOf(a) > 0 && (a.count.good + a.count.damaged + a.count.lost) > 0)) return "미반납";
  return null;
}

export function needsAttention(t: Trade, date: string): boolean {
  const aggs = aggregateReturns(t);
  if (aggs.some((a) => a.count.damaged > 0 || a.count.lost > 0)) return true;
  if (t.depositStatus && /미|대기|예정/.test(t.depositStatus)) return true;
  if (t.paymentWarning) return true;
  const overdue = new Date(t.returnAt) < new Date(`${date}T00:00:00`) && !t.returnDone;
  if (overdue) return true;
  if (t.riskWarnings.some((r) => r.guidanceState === "발송권장")) return true;
  return false;
}

export function tradesForTab(trades: Trade[], date: string, tab: TabKey): Trade[] {
  let list = trades;
  if (tab === "checkout") {
    list = trades.filter((t) => {
      const p = phaseForDate(t, date);
      return p === "checkout" || p === "both";
    });
  } else if (tab === "checkin") {
    list = trades.filter((t) => {
      const p = phaseForDate(t, date);
      return p === "checkin" || p === "both";
    });
  } else if (tab === "attention") {
    list = trades.filter((t) => needsAttention(t, date));
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
  if (tab === "checkout") return t.setupDone;
  if (tab === "checkin") return t.returnDone;
  const p = phaseForDate(t, date);
  if (p === "checkout") return t.setupDone;
  if (p === "checkin") return t.returnDone;
  if (p === "both") return t.setupDone && t.returnDone;
  return t.returnDone;
}

export function tabCounts(trades: Trade[], date: string): Record<TabKey, number> {
  return {
    checkout: tradesForTab(trades, date, "checkout").length,
    checkin: tradesForTab(trades, date, "checkin").length,
    all: trades.length,
    attention: tradesForTab(trades, date, "attention").length,
  };
}

const items = (t: Trade) => t.equipments.filter((e) => !e.isSetHeader);

/** 반출/반납 진행도 */
export function setupProgress(t: Trade, phase: "checkout" | "checkin"): { done: number; total: number } {
  if (phase === "checkin") {
    const aggs = aggregateReturns(t);
    return { done: aggs.filter(isReturnDone).length, total: aggs.length };
  }
  const list = items(t);
  const done = list.filter((e) => e.checkoutState !== "pending").length;
  return { done, total: list.length };
}

/** 인계 요약: 체크리스트에서 자동 산출 (자유 텍스트 대체) */
export function handoverSummary(t: Trade, phase: "checkout" | "checkin"): string[] {
  const out: string[] = [];
  if (phase === "checkout") {
    const list = items(t);
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
