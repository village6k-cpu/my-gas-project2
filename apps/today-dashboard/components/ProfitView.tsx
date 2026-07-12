"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { authFetch } from "@/lib/data/authFetch";

type Earner = { name: string; category: string; count: number; revenue: number; avgPerRental: number; price: number; lastRentedAt: string };
type Idle = { name: string; category: string; stock: number; price: number; foregone: number; lastRentedAt: string; neverRented: boolean };
type Unbilled = { name: string; count: number; lastRentedAt: string; masterPrice: number; inMaster: boolean };

type ProfitData = {
  ok: boolean;
  error?: string;
  generatedAt: string;
  today: string;
  windowDays: number;
  stats: { revenue: number; productCount: number; idleCount: number; idleForegonePerDay: number; unbilledCount: number };
  earners: Earner[];
  idle: Idle[];
  unbilled: Unbilled[];
};

const won = (n: number) => "₩" + (n || 0).toLocaleString("ko-KR");
const wonShort = (n: number) => {
  if (!n) return "₩0";
  if (n >= 100000000) return "₩" + (n / 100000000).toFixed(1) + "억";
  if (n >= 10000000) return "₩" + Math.round(n / 10000000) + "천만";
  if (n >= 10000) return "₩" + Math.round(n / 10000).toLocaleString("ko-KR") + "만";
  return "₩" + n.toLocaleString("ko-KR");
};

export function ProfitView() {
  const [data, setData] = useState<ProfitData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"earners" | "idle" | "unbilled">("earners");

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

  const listLen = useMemo(() => {
    if (!data) return { earners: 0, idle: 0, unbilled: 0 };
    return { earners: data.earners.length, idle: data.idle.length, unbilled: data.unbilled.length };
  }, [data]);

  return (
    <div className="mx-auto flex min-h-screen max-w-2xl flex-col bg-paper">
      <header className="safe-top sticky top-0 z-40 bg-paper/90 px-4 pb-2 pt-3 backdrop-blur-md ring-1 ring-line/70">
        <div className="flex items-center justify-between">
          <div>
            <a href="/operations" className="text-[12px] font-semibold text-ink-faint">← 운영판</a>
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
          실제 청구 단가 기준으로 어떤 상품이 돈을 벌고, 어떤 장비가 놀며 매출을 놓치는지 분석합니다{data ? ` (최근 ${data.windowDays}일)` : ""}.
        </p>
      </header>

      <main className="flex-1 space-y-3 p-3 pb-24">
        {error && (
          <div className="rounded-xl bg-attention-bg px-3.5 py-2.5 text-[13px] font-medium text-attention-fg ring-1 ring-attention-ring">{error}</div>
        )}

        {data && (
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
            <StatCard label="매출" value={wonShort(data.stats.revenue)} sub={`최근 ${data.windowDays}일`} tone="brand" />
            <StatCard label="효자 상품" value={String(data.stats.productCount)} sub="대여된 상품 수" />
            <StatCard label="노는 장비" value={String(data.stats.idleCount)} tone="warn" />
            <StatCard label="놓치는 매출" value={wonShort(data.stats.idleForegonePerDay) + "/일"} sub="유휴 재고 잠재수입" tone="warn" />
          </div>
        )}

        <div className="flex gap-2">
          <TabButton active={tab === "earners"} onClick={() => setTab("earners")}>효자 상품 {data ? `(${listLen.earners})` : ""}</TabButton>
          <TabButton active={tab === "idle"} onClick={() => setTab("idle")}>노는 장비 {data ? `(${listLen.idle})` : ""}</TabButton>
          <TabButton active={tab === "unbilled"} onClick={() => setTab("unbilled")}>청구 누락 {data ? `(${listLen.unbilled})` : ""}</TabButton>
        </div>

        {loading && !data && <div className="py-10 text-center text-[14px] font-bold text-ink-faint">장비 수익 계산 중…</div>}
        {data && ((tab === "earners" && !data.earners.length) || (tab === "idle" && !data.idle.length) || (tab === "unbilled" && !data.unbilled.length)) && (
          <div className="py-10 text-center text-[13.5px] text-ink-mute">{tab === "unbilled" ? "청구 누락 의심 항목이 없습니다. 👍" : "해당 장비가 없습니다."}</div>
        )}

        {tab === "earners" && (data?.earners || []).map((it, i) => <EarnerCard key={it.name + i} item={it} rank={i + 1} />)}
        {tab === "idle" && (data?.idle || []).map((it, i) => <IdleCard key={it.name + i} item={it} rank={i + 1} />)}
        {tab === "unbilled" && (data?.unbilled || []).map((it, i) => <UnbilledCard key={it.name + i} item={it} />)}

        {data && (
          <p className="pt-2 text-center text-[11px] text-ink-faint">
            {data.today} 기준 · 매출 = 청구 단위(세트/단품) 실단가 × 대여일수 (구성품 중복 없음) · 노는 장비 = 최근 {data.windowDays}일 미대여
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

function CategoryChip({ category }: { category: string }) {
  if (!category) return null;
  return <span className="shrink-0 rounded-full bg-paper px-1.5 py-0.5 text-[10px] font-semibold text-ink-mute ring-1 ring-line/60">{category}</span>;
}

function EarnerCard({ item, rank }: { item: Earner; rank: number }) {
  return (
    <div className="rounded-2xl bg-white p-3.5 shadow-card ring-1 ring-line">
      <div className="flex items-start gap-2.5">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-50 text-[12px] font-extrabold text-brand-600">{rank}</div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[14.5px] font-extrabold text-ink">{item.name}</span>
            <CategoryChip category={item.category} />
          </div>
          <div className="mt-0.5 flex flex-wrap gap-x-2.5 gap-y-0.5 text-[11.5px] text-ink-mute">
            <span className="font-bold text-checkin-fg">{item.count}회 대여</span>
            {item.avgPerRental > 0 && <span>건당 {won(item.avgPerRental)}</span>}
            {item.lastRentedAt && <span>최근 {item.lastRentedAt}</span>}
          </div>
        </div>
        <div className="shrink-0 text-right">
          <div className="text-[15px] font-extrabold text-brand-600">{wonShort(item.revenue)}</div>
          <div className="text-[10px] text-ink-faint">매출</div>
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
            <CategoryChip category={item.category} />
          </div>
          <div className="mt-0.5 flex flex-wrap gap-x-2.5 gap-y-0.5 text-[11.5px] text-ink-mute">
            <span>보유 {item.stock}</span>
            {item.price > 0 && <span>단가 {won(item.price)}</span>}
            <span className={item.neverRented ? "font-bold text-attention-fg" : ""}>
              {item.neverRented ? "대여 이력 없음" : `마지막 대여 ${item.lastRentedAt}`}
            </span>
          </div>
        </div>
        <div className="shrink-0 text-right">
          <div className="text-[14px] font-extrabold text-attention-fg">{wonShort(item.foregone)}</div>
          <div className="text-[10px] text-ink-faint">놓치는 매출/일</div>
        </div>
      </div>
    </div>
  );
}

function UnbilledCard({ item }: { item: Unbilled }) {
  const sure = item.masterPrice > 0;
  return (
    <div className={`rounded-2xl bg-white p-3 shadow-card ring-1 ${sure ? "ring-warn-ring" : "ring-line"}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate text-[14px] font-bold text-ink">{item.name}</span>
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold ${sure ? "bg-warn-bg text-warn-fg" : "bg-line/40 text-ink-mute"}`}>
          {sure ? `정가 ${won(item.masterPrice)}` : "미등록"}
        </span>
      </div>
      <div className="mt-0.5 text-[11.5px] text-ink-mute">
        {item.count}회 대여 · 최근 {item.lastRentedAt || "?"} — {sure ? "정가가 있는데 0원으로 나감(청구 확인)" : "장비마스터 미등록 (세트 구성품일 수 있음)"}
      </div>
    </div>
  );
}
