// 시트 → Supabase 읽기 동기화 (Phase 1, 단방향).
// 소스: 기존 GAS action=timeline (날짜가 보정된 epoch ms를 줌 → 1899 버그 회피).
import type { EquipmentItem, ReturnCount, RiskWarning, Trade } from "../domain/types";
import { categoryOf } from "../domain/catalog";
import { fetchAllTrades, persistTrade } from "./remote";
import { gasFetch } from "./apiClient";
import { ymd } from "../domain/status";

const DAY = 86400000;
const EMPH = /배터리|메모리|카드|CFexpress|SD|미디어/;

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
    const equipments: EquipmentItem[] = items.map((it: any, idx: number) => {
      const s = toMs(it.s);
      const e = toMs(it.e);
      if (s < minS) minS = s;
      if (e > maxE) maxE = e;
      if (typeof it.p === "number") amount += it.p;
      const name = groups.get(it.g) ?? it.eq ?? "장비";
      return {
        scheduleId: `${tid}-${it.r ?? idx}`,
        name,
        qty: Number(it.q) || 1,
        category: categoryOf(name) ?? undefined,
        checkoutState: it.st === "대기" ? "pending" : "taken",
      } as EquipmentItem;
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
  const from = ymd(new Date(today.getTime() + (opts?.fromDays ?? -7) * 86400000));
  const to = ymd(new Date(today.getTime() + (opts?.toDays ?? 30) * 86400000));
  log(`GAS timeline 읽는 중… (${from} ~ ${to})`);
  const res = await gasFetch(`action=timeline&from=${from}&to=${to}&compact=2`);
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  const trades = parseTimeline(data);
  log(`예약 ${trades.length}건 파싱 → Supabase 적재 중…`);
  let n = 0;
  for (const t of trades) {
    await persistTrade(t);
    n++;
    if (n % 10 === 0) log(`  …${n}/${trades.length}`);
  }
  log(`완료: ${n}건 동기화됨`);
  return n;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function mapRisk(arr: any): RiskWarning[] {
  if (!Array.isArray(arr)) return [];
  return arr.map((r: any, i: number) => {
    const lvl = String(r.riskLevel ?? "").toLowerCase();
    const riskLevel = lvl.includes("high") || lvl.includes("상") ? "high" : lvl.includes("low") || lvl.includes("하") ? "low" : "medium";
    return {
      id: String(r.ruleId ?? i),
      phase: "checkout",
      equipmentName: r.equipmentName ?? "",
      riskLevel,
      customerMessage: r.customerMessage ?? r.returnCheckText ?? "",
      guidanceState: (r.guidanceState as RiskWarning["guidanceState"]) ?? "대상없음",
    };
  });
}

/** action=dashboard 항목을 기존 거래(날짜 유지) 위에 상세 덮어쓰기 */
function mergeDashboard(base: Trade, it: any): Trade {
  const equipments: EquipmentItem[] = (it.equipments ?? []).map((e: any) => ({
    scheduleId: e.scheduleId,
    name: e.name,
    qty: Number(e.qty) || 1,
    setName: e.setName || undefined,
    isSetHeader: !!e.isHeader,
    isComponent: !!e.isComponent,
    emphasize: EMPH.test(e.name) || undefined,
    category: categoryOf(e.name) ?? undefined,
    checkoutState: e.checkedCheckout ? "taken" : "pending",
  }));
  const returnCounts: Record<string, ReturnCount> = {};
  for (const e of it.equipments ?? []) {
    if (e.isHeader) continue;
    if (e.checkedCheckin) {
      const k = e.name;
      returnCounts[k] = { good: (returnCounts[k]?.good ?? 0) + (Number(e.qty) || 1), damaged: 0, lost: 0 };
    }
  }
  return {
    ...base,
    customerName: it.name || base.customerName,
    customerPhone: it.tel || base.customerPhone,
    company: it.company || base.company,
    contractStatus: it.contractStatus || base.contractStatus,
    setupDone: !!it.setupDone,
    returnDone: !!it.returnDone,
    setupDoneAt: it.setupDoneAt || undefined,
    returnDoneAt: it.returnDoneAt || undefined,
    paymentMethod: it.paymentMethod || undefined,
    paymentWarning: !!it.paymentWarning,
    depositStatus: it.depositStatus || undefined,
    proofType: it.proofType || undefined,
    issueStatus: it.issueStatus || undefined,
    billingCompany: it.billingCompany || undefined,
    contractUrl: it.contractUrl || base.contractUrl,
    contractRegenPending: !!it.contractRegenPending,
    noteCheckin: it.returnMemo || base.noteCheckin,
    riskWarnings: mapRisk(it.riskWarnings),
    returnCounts,
    equipments: equipments.length ? equipments : base.equipments,
  };
}

/** 대시보드 상세를 날짜 윈도우로 동기화(기존 거래에 덮어쓰기) */
export async function syncDashboardToSupabase(opts?: { fromDays?: number; toDays?: number; onLog?: (s: string) => void }): Promise<number> {
  const log = opts?.onLog ?? (() => {});
  const existing = new Map((await fetchAllTrades()).map((t) => [t.tradeId, t]));
  log(`기존 ${existing.size}건 기준, 대시보드 상세 동기화…`);
  const seen = new Set<string>();
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
        if (!tid || seen.has(tid)) continue;
        seen.add(tid);
        const base = existing.get(tid);
        if (!base) {
          skipped++;
          continue;
        }
        await persistTrade(mergeDashboard(base, it));
        n++;
      }
      log(`  ${date}: 누적 ${n}건`);
    } catch {
      /* 한 날짜 실패는 건너뜀 */
    }
  }
  log(`대시보드 상세 ${n}건 반영 (윈도우 밖 ${skipped}건 스킵)`);
  return n;
}

/** 전체 동기화: timeline(날짜·예약) → dashboard(상세) */
export async function syncAll(onLog?: (s: string) => void): Promise<void> {
  await syncTimelineToSupabase({ fromDays: -7, toDays: 30, onLog });
  await syncDashboardToSupabase({ fromDays: -2, toDays: 14, onLog });
}

/**
 * 가벼운 폴링: timeline에서 예약의 날짜/고객/금액 변경·신규만 골라 반환.
 * 앱이 가진 ops(검수·결제·제외·반납카운트·장비구조)는 보존(시트 timeline엔 없으므로 덮어쓰지 않음).
 */
export async function pollTimelineChanges(current: Trade[]): Promise<Trade[]> {
  const today = new Date();
  const from = ymd(new Date(today.getTime() - 7 * DAY));
  const to = ymd(new Date(today.getTime() + 30 * DAY));
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
    if (ex.checkoutAt !== tl.checkoutAt || ex.returnAt !== tl.returnAt || ex.customerName !== tl.customerName) {
      changed.push({
        ...ex, // ops 보존
        checkoutAt: tl.checkoutAt,
        returnAt: tl.returnAt,
        customerName: tl.customerName,
        customerPhone: tl.customerPhone || ex.customerPhone,
        amount: tl.amount ?? ex.amount,
      });
    }
  }
  return changed;
}
