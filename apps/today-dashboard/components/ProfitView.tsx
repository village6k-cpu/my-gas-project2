"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { authFetch } from "@/lib/data/authFetch";

type Earner = { name: string; category: string; count90: number; days90: number; revenue90: number; price: number; stock: number | null; lastRentedAt: string; inMaster: boolean };
type Idle = { name: string; category: string; stock: number; price: number; capital: number; lastRentedAt: string; neverRented: boolean };
type Unpriced = { name: string; countAll: number; count90: number; lastRentedAt: string };

type ProfitData = {
  ok: boolean;
  error?: string;
  generatedAt: string;
  today: string;
  windowDays: number;
  stats: { activeEquipment: number; idleEquipment: number; revenue90: number; idleCapitalPerDay: number; unpricedCount: number };
  earners: Earner[];
  idle: Idle[];
  unpriced: Unpriced[];
};

const won = (n: number) => "₩" + (n || 0).toLocaleString("ko-KR");
const wonShort = (n: number) => {
  if (!n) return "₩0";
  if (n >= 10000000) return "₩" + (n / 10000000).toFixed(n >= 100000000 ? 1 : 0) + "천만";
  if (n >= 10000) return "₩" + Math.round(n / 10000).toLocaleString("ko-KR") + "만";
  return "₩" + n.toLocaleString("ko-KR");
};

export function ProfitView() {
  const [data, setData] = useState<ProfitData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"earners" | "idle" | "unpriced">("earners");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await authFetch("/api/gas?action=equipRadar&limit=80");
      const j = (await r.json()) as ProfitData;
      if (!j.ok) throw new Error(j.error || "장비 수익 계산 실패");
      setData(j);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const list = useMemo(() => {
    if (!data) return [] as (Earner | Idle | Unpriced)[];
    if (tab === "earners") return data.earners;
    if (tab === "idle") return data.idle;
    return data.unpriced;
  }, [data, tab]);

  return (
    <div className="mx-auto flex min-h-screen max-w-2xl flex-col bg-paper">
      <header className="safe-top sticky top-0 z-40 bg-paper/90 px-4 pb-2 pt-3 backdrop-blur-md ring-1 ring-line/70">
        <div className="flex items-center justify-between">
          <div>
            <a href="/operations" className="text-[12px] font-semibold text-ink-faint">← 헤이빌리</a>
            <h1 className="text-[19px] font-extrabold text-ink">💰 장비 수익 레이더</h1>
          </div>
          <div className="flex items-center gap-2">
            <a href="/radar" className="tap flex h-9 items-center gap-1 rounded-full bg-white px-3 text-[12px] font-bold text-ink-soft ring-1 ring-line/60" title="재방문 레이더">
              🎯 재방문
            </a>
            <button
              onClick={load}
              className={`tap flex h-9 w-9 items-center justify-center rounded-full bg-white text-ink-soft ring-1 ring-line/60 ${loading ? "animate-spin" : ""}`}
              title="새로고침"
              aria-label="새로고침"
            >
              ↻
            </button>
          </div>
        </div>
        <p className="mt-0.5 text-[12px] text-ink-mute">
          어떤 장비가 돈을 벌고, 어떤 고가 장비가 놀며 자본을 묶고 있는지 자동 분석합니다{data ? ` (최근 ${data.windowDays}일)` : ""}.
        </p>
      </header>

      <main className="flex-1 space-y-3 p-3 pb-24">
        {error && (
          <div className="rounded-xl bg-attention-bg px-3.5 py-2.5 text-[13px] font-medium text-attention-fg ring-1 ring-attention-ring">{error}</div>
        )}

        {data && (
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
            <StatCard label="추정 매출" value={wonShort(data.stats.revenue90)} sub={`최근 ${data.windowDays}일`} tone="brand" />
            <StatCard label="활성 장비" value={String(data.stats.activeEquipment)} sub="대여된 품목" />
            <StatCard label="노는 장비" value={String(data.stats.idleEquipment)} tone="warn" />
            <StatCard label="묶인 자본" value={wonShort(data.stats.idleCapitalPerDay) + "/일"} sub="유휴 재고" tone="warn" />
          </div>
        )}

        <div className="flex gap-2">
          <TabButton active={tab === "earners"} onClick={() => setTab("earners")}>효자 장비 {data ? `(${data.earners.length})` : ""}</TabButton>
          <TabButton active={tab === "idle"} onClick={() => setTab("idle")}>노는 장비 {data ? `(${data.idle.length})` : ""}</TabButton>
          <TabButton active={tab === "unpriced"} onClick={() => setTab("unpriced")}>미가격 {data ? `(${data.unpriced.length})` : ""}</TabButton>
        </div>

        {loading && !data && <div className="py-10 text-center text-[14px] font-bold text-ink-faint">장비 수익 계산 중…</div>}
        {data && list.length === 0 && <div className="py-10 text-center text-[13.5px] text-ink-mute">해당 장비가 없습니다.</div>}

        {tab === "earners" && (data?.earners || []).map((it, i) => <EarnerCard key={it.name + i} item={it} rank={i + 1} />)}
        {tab === "idle" && (data?.idle || []).map((it, i) => <IdleCard key={it.name + i} item={it} rank={i + 1} />)}
        {tab === "unpriced" && (data?.unpriced || []).map((it, i) => <UnpricedCard key={it.name + i} item={it} />)}

        {data && (
          <p className="pt-2 text-center text-[11px] text-ink-faint">
            {data.today} 기준 · 추정매출 = 대여일수 × 장비마스터 단가 · 세트는 구성품과 중복 집계될 수 있음
          </p>
        )}
      </main>
    </div>
  );
}

function StatCard({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "brand" | "warn" }) {
  const valCls = tone === "brand" ? "text-brand-600" : tone === "warn" ? "text-attention-fg" : "text-ink";
  return (
    <div className="rounded-xl bg-white p-3 ring-1 ring-line/70">
      <div className="text-[11px] font-semibold text-ink-mute">{label}</div>
      <div className={`mt-0.5 text-[17px] font-extrabold ${valCls}`}>{value}</div>
      {sub && <div className="text-[10px] text-ink-faint">{sub}</div>}
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`tap flex-1 rounded-full px-2 py-2 text-[12.5px] font-bold ring-1 ${active ? "bg-brand-600 text-white ring-brand-600" : "bg-white text-ink-mute ring-line"}`}
    >
      {children}
    </button>
  );
}

function EarnerCard({ item, rank }: { item: Earner; rank: number }) {
  return (
    <div className="rounded-2xl bg-white p-3.5 shadow-card ring-1 ring-line">
      <div className="flex items-start gap-2.5">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-50 text-[12px] font-extrabold text-brand-600">{rank}</div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[14.5px] font-extrabold text-ink">{item.name}</span>
            {item.category && <span className="shrink-0 rounded-full bg-paper px-1.5 py-0.5 text-[10px] font-semibold text-ink-mute ring-1 ring-line/60">{item.category}</span>}
          </div>
          <div className="mt-0.5 flex flex-wrap gap-x-2.5 gap-y-0.5 text-[11.5px] text-ink-mute">
            <span className="font-bold text-checkin-fg">{item.count90}회 대여</span>
            <span>{item.days90}일</span>
            {item.price > 0 && <span>단가 {won(item.price)}</span>}
            {item.stock != null && <span>보유 {item.stock}</span>}
          </div>
        </div>
        <div className="shrink-0 text-right">
          <div className="text-[15px] font-extrabold text-brand-600">{wonShort(item.revenue90)}</div>
          <div className="text-[10px] text-ink-faint">추정 매출</div>
        </div>
      </div>
    </div>
  );
}

function IdleCard({ item, rank }: { item: Idle; rank: number }) {
  return (
    <div className="rounded-2xl bg-white p-3.5 shadow-card ring-1 ring-attention-ring">
      <div className="flex items-start gap-2.5">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-attention-bg text-[12px] font-extrabold text-attention-fg">{rank}</div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[14.5px] font-extrabold text-ink">{item.name}</span>
            {item.category && <span className="shrink-0 rounded-full bg-paper px-1.5 py-0.5 text-[10px] font-semibold text-ink-mute ring-1 ring-line/60">{item.category}</span>}
          </div>
          <div className="mt-0.5 flex flex-wrap gap-x-2.5 gap-y-0.5 text-[11.5px] text-ink-mute">
            <span>보유 {item.stock}</span>
            {item.price > 0 && <span>단가 {won(item.price)}</span>}
            <span className={item.neverRented ? "font-bold text-attention-fg" : ""}>
              {item.neverRented ? "한 번도 안 나감" : `마지막 대여 ${item.lastRentedAt}`}
            </span>
          </div>
        </div>
        <div className="shrink-0 text-right">
          <div className="text-[14px] font-extrabold text-attention-fg">{wonShort(item.capital)}</div>
          <div className="text-[10px] text-ink-faint">묶인 자본/일</div>
        </div>
      </div>
    </div>
  );
}

function UnpricedCard({ item }: { item: Unpriced }) {
  return (
    <div className="rounded-2xl bg-white p-3 shadow-card ring-1 ring-warn-ring">
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate text-[14px] font-bold text-ink">{item.name}</span>
        <span className="shrink-0 rounded-full bg-warn-bg px-2 py-0.5 text-[11px] font-bold text-warn-fg">단가 0원</span>
      </div>
      <div className="mt-0.5 text-[11.5px] text-ink-mute">
        {item.countAll}회 대여됨 · 최근 {item.lastRentedAt || "?"} — 장비마스터 단가 확인 필요
      </div>
    </div>
  );
}
