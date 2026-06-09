"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { authFetch } from "@/lib/data/authFetch";
import { AppSwitcher } from "@/components/AppSwitcher";
import { Refresh } from "@/components/icons";

// 운영판 — GAS action=operations(/api/operations) 단일 응답을 네이티브로 렌더. 읽기전용 + 60초 폴링.
// 디자인은 통합앱 토큰으로. 고객명 클릭 → 오늘일정(?tid=)로 이동.

type Eq = { name: string; qty: number };
type Row = { tid?: string; customer?: string; time?: string; items?: Eq[] };
type Imm = Row & { date?: string; daysAway?: number };
type Unconf = { reqID?: string; customer?: string; company?: string; checkoutDate?: string; checkoutTime?: string };
type Maint = { name?: string; status?: string; note?: string };
type Booking = { tid?: string; customer?: string; from?: string; to?: string; qty?: number };
type Alert = { date?: string; equipment?: string; stock?: number; booked?: number; overBy?: number; severity?: string; bookings?: Booking[] };
type Ops = {
  success?: boolean;
  date?: string;
  generatedAt?: string;
  week?: { start?: string; end?: string };
  summary?: { todayCheckout?: number; todayCheckin?: number; unconfirmed?: number; imminent?: number; maintenance?: number; weeklyReservations?: number };
  health?: {
    utilization?: { inUse?: number; total?: number; percent?: number };
    checkoutPace?: { thisWeek?: number; avg4Week?: number; percent?: number | null };
  };
  todayCheckout?: Row[];
  todayCheckin?: Row[];
  unconfirmed?: Unconf[];
  imminent?: Imm[];
  maintenance?: Maint[];
  inventoryAlerts?: Alert[];
  inventoryHorizonDays?: number;
};

const WD = ["일", "월", "화", "수", "목", "금", "토"];
function fmtClock(s?: string): string {
  if (!s) return "";
  const d = new Date(String(s).replace(" ", "T"));
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
}
function md(ymd?: string): string {
  if (!ymd) return "";
  const [, m, d] = ymd.split("-");
  return m && d ? `${Number(m)}/${Number(d)}` : ymd;
}
function mdDow(ymd?: string): string {
  if (!ymd) return "";
  const dt = new Date(ymd + "T00:00:00");
  if (Number.isNaN(dt.getTime())) return ymd;
  return `${dt.getMonth() + 1}월 ${dt.getDate()}일 (${WD[dt.getDay()]})`;
}

export function OperationsView({ embedded, headerLeft }: { embedded?: boolean; headerLeft?: ReactNode } = {}) {
  const [data, setData] = useState<Ops | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const loadingRef = useRef(false);

  const load = useCallback(async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    setError("");
    try {
      const res = await authFetch("/api/operations");
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || "운영판 불러오기 실패");
      setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 60000);
    return () => clearInterval(t);
  }, [load]);

  const s = data?.summary || {};
  const conflicts = (data?.inventoryAlerts || []).filter((a) => a.severity === "conflict");
  const horizon = data?.inventoryHorizonDays ?? 90;
  const util = data?.health?.utilization;
  const pace = data?.health?.checkoutPace;

  return (
    <div className={`flex min-h-screen flex-col bg-[#f4f5f7] ${embedded ? "lg:min-h-full" : ""}`}>
      <header className="safe-top sticky top-0 z-40 bg-white/90 backdrop-blur-md ring-1 ring-black/5">
        <div className="flex items-center justify-between gap-2 px-4 pt-2.5 pb-2.5">
          {embedded ? headerLeft ?? <span className="text-[15px] font-black text-accent-700">운영판</span> : <AppSwitcher active="operations" />}
          <button onClick={load} className={`tap flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-black/[0.04] text-ink-soft ${loading ? "animate-spin" : ""}`} title="새로고침">
            <Refresh className="h-4 w-4" />
          </button>
        </div>
        {data?.generatedAt && <div className="px-4 pb-1.5 text-[11px] text-ink-faint">마지막 업데이트 {fmtClock(data.generatedAt)}</div>}
      </header>

      <main className="flex-1 space-y-3.5 p-3 pb-24">
        {error && <div className="rounded-xl bg-attention-bg px-3.5 py-2.5 text-[13px] font-medium text-attention-fg ring-1 ring-attention-ring">{error}</div>}
        {!data && !error && <div className="py-16 text-center text-[14px] text-ink-faint">불러오는 중…</div>}

        {data && (
          <>
            {/* 재고 충돌 알림 */}
            {conflicts.length === 0 ? (
              <div className="rounded-xl bg-checkin-bg/60 px-3.5 py-2.5 text-[13px] font-semibold text-checkin-fg ring-1 ring-checkin-ring">✅ 향후 {horizon}일 재고 충돌 없음</div>
            ) : (
              <details className="overflow-hidden rounded-xl bg-attention-bg ring-1 ring-attention-ring" open>
                <summary className="cursor-pointer px-3.5 py-2.5 text-[13px] font-extrabold text-attention-fg">🔴 재고 충돌 {conflicts.length}건 — 펼쳐서 확인</summary>
                <div className="space-y-2 px-2.5 pb-2.5">
                  {conflicts.slice(0, 30).map((a, i) => (
                    <div key={i} className="rounded-lg bg-white p-2.5 ring-1 ring-attention-ring">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="text-[13px] font-extrabold text-ink">{a.equipment}</span>
                        <span className="text-[12px] font-bold text-attention-fg">🔴 {a.overBy}개 부족</span>
                      </div>
                      <div className="mt-0.5 text-[11.5px] text-ink-mute">{mdDow(a.date)} · 보유 {a.stock} / 예약 <b className="text-attention-fg">{a.booked}</b></div>
                      <div className="mt-1.5 space-y-0.5">
                        {(a.bookings || []).map((b, j) => (
                          <div key={j} className="text-[11.5px] text-ink-soft">
                            {b.customer} · {md(b.from)}{b.to && b.to !== b.from ? `~${md(b.to)}` : ""} · {b.qty}개
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </details>
            )}

            {/* KPI 4칸 */}
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
              <Kpi label="오늘 반출" value={s.todayCheckout ?? 0} bar="bg-checkout-fg" />
              <Kpi label="오늘 반납" value={s.todayCheckin ?? 0} bar="bg-checkin-fg" />
              <Kpi label="미확정 예약" value={s.unconfirmed ?? 0} bar="bg-attention-fg" alert={(s.unconfirmed ?? 0) > 0} />
              <Kpi label="임박 반출" value={s.imminent ?? 0} bar="bg-[#ea580c]" />
            </div>

            {/* 건강 지표 2카드 */}
            <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2">
              <Gauge util={util} />
              <Pace pace={pace} />
            </div>

            {/* 리스트 섹션 */}
            <div className="grid grid-cols-1 gap-3.5 lg:grid-cols-2">
              <Section title="오늘 반출" count={data.todayCheckout?.length || 0} empty="오늘 반출 없음">
                {(data.todayCheckout || []).map((r, i) => (
                  <OpsRow key={i} left={r.time} who={r.customer} tid={r.tid} pill={r.tid} date={data.date} />
                ))}
              </Section>
              <Section title="오늘 반납" count={data.todayCheckin?.length || 0} empty="오늘 반납 없음">
                {(data.todayCheckin || []).map((r, i) => (
                  <OpsRow key={i} left={r.time} who={r.customer} tid={r.tid} pill={r.tid} date={data.date} />
                ))}
              </Section>
              <Section title="임박 반출" count={data.imminent?.length || 0} empty="임박 반출 없음">
                {(data.imminent || []).map((r, i) => (
                  <OpsRow key={i} left={`${md(r.date)} ${r.time || ""}`} who={r.customer} tid={r.tid} pill={`D-${r.daysAway}`} pillTone={r.daysAway === 1 ? "urgent" : "high"} date={r.date} />
                ))}
              </Section>
              <Section title="미확정 예약" count={data.unconfirmed?.length || 0} empty="미확정 예약 없음">
                {(data.unconfirmed || []).map((r, i) => (
                  <OpsRow key={i} left={`${md(r.checkoutDate)} ${r.checkoutTime || ""}`} who={r.customer} sub={r.company} pill={r.reqID} pillTone="normal" />
                ))}
              </Section>
              {(data.maintenance?.length || 0) > 0 && (
                <Section title="정비 중" count={data.maintenance!.length} empty="정비 중 장비 없음">
                  {data.maintenance!.map((m, i) => (
                    <OpsRow key={i} who={m.name} sub={m.note} pill={m.status} pillTone="high" />
                  ))}
                </Section>
              )}
            </div>

            {/* 주간 신규예약 */}
            <div className="flex items-center justify-between rounded-xl bg-white p-3.5 shadow-card ring-1 ring-black/5">
              <div>
                <div className="text-[12px] font-semibold text-ink-mute">이번주 신규 예약</div>
                <div className="text-[11.5px] text-ink-faint">{md(data.week?.start)} ~ {md(data.week?.end)}</div>
              </div>
              <div className="text-[24px] font-extrabold tabular-nums text-ink">{s.weeklyReservations ?? 0}건</div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}

function Kpi({ label, value, bar, alert }: { label: string; value: number; bar: string; alert?: boolean }) {
  return (
    <div className="relative overflow-hidden rounded-xl bg-white p-3.5 shadow-card ring-1 ring-black/5">
      <span className={`absolute inset-y-0 left-0 w-[3px] ${bar}`} aria-hidden />
      <div className="text-[12px] font-semibold text-ink-mute">{label}</div>
      <div className={`mt-1 text-[24px] font-extrabold leading-none tabular-nums ${alert ? "text-attention-fg" : "text-ink"}`}>{value}<span className="text-[13px] font-bold text-ink-faint">건</span></div>
    </div>
  );
}

function Gauge({ util }: { util?: { inUse?: number; total?: number; percent?: number } }) {
  const pct = util?.percent ?? 0;
  const tone = pct >= 50 ? "text-checkin-fg" : pct >= 30 ? "text-[#ea580c]" : "text-attention-fg";
  const barColor = pct >= 50 ? "bg-checkin-fg" : pct >= 30 ? "bg-[#ea580c]" : "bg-attention-fg";
  return (
    <div className="rounded-xl bg-white p-3.5 shadow-card ring-1 ring-black/5">
      <div className="text-[12px] font-semibold text-ink-mute">장비 가동률</div>
      <div className={`mt-1 text-[34px] font-extrabold leading-none tabular-nums ${tone}`}>{pct}<span className="text-[16px]">%</span></div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-black/[0.06]">
        <div className={`h-full rounded-full ${barColor}`} style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
      <div className="mt-1.5 text-[11.5px] text-ink-mute">대여 중 {util?.inUse ?? 0}개 / 전체 보유 {util?.total ?? 0}개</div>
    </div>
  );
}

function Pace({ pace }: { pace?: { thisWeek?: number; avg4Week?: number; percent?: number | null } }) {
  const pct = pace?.percent;
  const na = pct == null;
  const arrow = na ? "" : pct >= 110 ? "▲" : pct >= 80 ? "▬" : "▼";
  const tone = na ? "text-ink-faint" : pct! >= 110 ? "text-checkin-fg" : pct! >= 80 ? "text-ink-soft" : "text-attention-fg";
  return (
    <div className="rounded-xl bg-white p-3.5 shadow-card ring-1 ring-black/5">
      <div className="text-[12px] font-semibold text-ink-mute">이번주 출고 페이스</div>
      <div className={`mt-1 text-[34px] font-extrabold leading-none tabular-nums ${tone}`}>{na ? "데이터 부족" : <>{arrow} {pct}<span className="text-[16px]">%</span></>}</div>
      {!na && (
        <div className="relative mt-2 h-2 overflow-hidden rounded-full bg-black/[0.06]">
          <div className="absolute inset-y-0 left-1/2 w-px bg-black/20" aria-hidden />
          <div className="h-full rounded-full bg-ink-soft" style={{ width: `${Math.min(200, Math.max(0, pct!)) / 2}%` }} />
        </div>
      )}
      <div className="mt-1.5 text-[11.5px] text-ink-mute">이번주 {pace?.thisWeek ?? 0}건 / 4주 평균 {pace?.avg4Week ?? 0}건</div>
    </div>
  );
}

function Section({ title, count, empty, children }: { title: string; count: number; empty: string; children: ReactNode }) {
  const arr = Array.isArray(children) ? children : [children];
  const has = count > 0;
  return (
    <section>
      <div className="mb-2 flex items-baseline justify-between px-1">
        <h2 className="text-[14px] font-bold text-ink-soft">{title}</h2>
        <span className="text-[12px] text-ink-mute">{count}건</span>
      </div>
      <div className="overflow-hidden rounded-xl bg-white shadow-card ring-1 ring-black/5">
        {has ? <div className="divide-y divide-black/5">{arr}</div> : <div className="px-3 py-5 text-center text-[12.5px] font-semibold text-ink-faint">{empty}</div>}
      </div>
    </section>
  );
}

function OpsRow({ left, who, sub, tid, pill, pillTone, date }: { left?: string; who?: string; sub?: string; tid?: string; pill?: string; pillTone?: "urgent" | "high" | "normal"; date?: string }) {
  const tonecls =
    pillTone === "urgent" ? "bg-attention-bg text-attention-fg"
    : pillTone === "high" ? "bg-warn-bg text-warn-fg"
    : pillTone === "normal" ? "bg-checkout-bg text-checkout-fg"
    : "bg-black/[0.04] text-ink-mute";
  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2.5 px-3 py-2.5">
      <span className="text-[12.5px] font-bold tabular-nums text-ink-soft">{left || ""}</span>
      <div className="min-w-0">
        {tid ? (
          <a href={`/?tid=${encodeURIComponent(tid)}`} className="truncate text-[14px] font-bold text-ink underline decoration-dotted underline-offset-2">{who || "—"}</a>
        ) : (
          <span className="truncate text-[14px] font-bold text-ink">{who || "—"}</span>
        )}
        {sub && <div className="truncate text-[11.5px] text-ink-mute">{sub}</div>}
      </div>
      {pill && <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold ${tonecls}`}>{pill}</span>}
    </div>
  );
}
