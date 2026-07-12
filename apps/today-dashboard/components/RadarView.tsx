"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { authFetch } from "@/lib/data/authFetch";

type RadarItem = {
  name: string;
  phone: string;
  count: number;
  daysSince: number;
  intervalDays: number;
  totalRevenue: number;
  avgRevenue: number;
  favGear: string[];
  discount: string;
  priority: number;
  lastRentedAt: string;
  reason: string;
  draft: string;
};

type RadarData = {
  ok: boolean;
  error?: string;
  generatedAt: string;
  today: string;
  stats: { totalRepeatCustomers: number; dueNow: number; atRisk: number; opportunityAmount: number };
  due: RadarItem[];
  atRisk: RadarItem[];
};

const won = (n: number) => "₩" + (n || 0).toLocaleString("ko-KR");
const telHref = (p: string) => "tel:" + (p || "").replace(/[^0-9+]/g, "");
const smsHref = (p: string, body: string) =>
  "sms:" + (p || "").replace(/[^0-9+]/g, "") + (body ? `?&body=${encodeURIComponent(body)}` : "");

export function RadarView() {
  const [data, setData] = useState<RadarData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"due" | "atRisk">("due");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await authFetch("/api/gas?action=radar&limit=60");
      const j = (await r.json()) as RadarData;
      if (!j.ok) throw new Error(j.error || "레이더 계산 실패");
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

  const list = useMemo(() => (data ? (tab === "due" ? data.due : data.atRisk) : []), [data, tab]);

  return (
    <div className="mx-auto flex min-h-screen max-w-2xl flex-col bg-paper">
      <header className="safe-top sticky top-0 z-40 bg-paper/90 px-4 pb-2 pt-3 backdrop-blur-md ring-1 ring-line/70">
        <div className="flex items-center justify-between">
          <div>
            <a href="/operations" className="text-[12px] font-semibold text-ink-faint">← 운영판</a>
            <h1 className="text-[19px] font-extrabold text-ink">🎯 재방문 레이더</h1>
          </div>
          <div className="flex items-center gap-2">
            <a href="/profit" className="tap flex h-9 items-center gap-1 rounded-full bg-white px-3 text-[12px] font-bold text-ink-soft ring-1 ring-line/60" title="장비 수익 레이더">
              💰 장비수익
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
          5년 계약 이력으로 “지금 연락하면 재대여 가능성 높은 고객”을 자동 산출합니다. 발송은 검토 후 직접.
        </p>
      </header>

      <main className="flex-1 space-y-3 p-3 pb-24">
        {error && (
          <div className="rounded-xl bg-attention-bg px-3.5 py-2.5 text-[13px] font-medium text-attention-fg ring-1 ring-attention-ring">
            {error}
          </div>
        )}

        {data && (
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
            <StatCard label="재방문 고객" value={String(data.stats.totalRepeatCustomers)} />
            <StatCard label="지금 적기" value={String(data.stats.dueNow)} tone="brand" />
            <StatCard label="이탈 위험" value={String(data.stats.atRisk)} tone="warn" />
            <StatCard label="예상 기회" value={won(data.stats.opportunityAmount)} sub="상위 고객 1회씩" />
          </div>
        )}

        <div className="flex gap-2">
          <TabButton active={tab === "due"} onClick={() => setTab("due")}>
            지금 연락 적기 {data ? `(${data.due.length})` : ""}
          </TabButton>
          <TabButton active={tab === "atRisk"} onClick={() => setTab("atRisk")}>
            이탈 위험 단골 {data ? `(${data.atRisk.length})` : ""}
          </TabButton>
        </div>

        {loading && !data && <div className="py-10 text-center text-[14px] font-bold text-ink-faint">레이더 계산 중…</div>}
        {data && list.length === 0 && (
          <div className="py-10 text-center text-[13.5px] text-ink-mute">해당 고객이 없습니다.</div>
        )}

        {list.map((it, i) => (
          <RadarCard key={`${it.name}-${it.phone}-${i}`} item={it} rank={i + 1} atRisk={tab === "atRisk"} />
        ))}

        {data && (
          <p className="pt-2 text-center text-[11px] text-ink-faint">
            {data.today} 기준 · 취소·현재 대여중 고객 제외 · 개인 대여주기(중앙값) 기반
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
      <div className={`mt-0.5 text-[18px] font-extrabold ${valCls}`}>{value}</div>
      {sub && <div className="text-[10px] text-ink-faint">{sub}</div>}
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`tap flex-1 rounded-full px-3 py-2 text-[13px] font-bold ring-1 ${
        active ? "bg-brand-600 text-white ring-brand-600" : "bg-white text-ink-mute ring-line"
      }`}
    >
      {children}
    </button>
  );
}

function RadarCard({ item, rank, atRisk }: { item: RadarItem; rank: number; atRisk: boolean }) {
  const [msg, setMsg] = useState(item.draft);
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(msg);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // 클립보드 미지원 환경 — textarea 선택으로 폴백
      const el = document.getElementById(`draft-${rank}`) as HTMLTextAreaElement | null;
      if (el) {
        el.focus();
        el.select();
      }
    }
  };

  return (
    <div className={`rounded-2xl bg-white p-3.5 shadow-card ring-1 ${atRisk ? "ring-attention-ring" : "ring-line"}`}>
      <div className="flex items-start gap-2.5">
        <div
          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[12px] font-extrabold ${
            atRisk ? "bg-attention-bg text-attention-fg" : "bg-brand-50 text-brand-600"
          }`}
        >
          {rank}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[15px] font-extrabold text-ink">{item.name || "이름없음"}</span>
            {item.discount && /단골|제휴|VIP/.test(item.discount) && (
              <span className="rounded-full bg-brand-50 px-1.5 py-0.5 text-[10px] font-bold text-brand-600">{item.discount}</span>
            )}
          </div>
          <div className="mt-0.5 flex flex-wrap gap-x-2.5 gap-y-0.5 text-[11.5px] text-ink-mute">
            <span>{item.count}회 대여</span>
            <span>주기 {item.intervalDays}일</span>
            <span>마지막 {item.daysSince}일 전</span>
            {item.avgRevenue > 0 && <span>평균 {won(item.avgRevenue)}</span>}
          </div>
        </div>
      </div>

      <div className={`mt-2 rounded-lg px-2.5 py-1.5 text-[12px] font-medium ${atRisk ? "bg-attention-bg text-attention-fg" : "bg-paper text-ink-soft"}`}>
        {item.reason}
      </div>

      {item.favGear.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {item.favGear.map((g) => (
            <span key={g} className="rounded-full bg-paper px-2 py-0.5 text-[11px] font-semibold text-ink-mute ring-1 ring-line/60">
              {g}
            </span>
          ))}
        </div>
      )}

      <textarea
        id={`draft-${rank}`}
        value={msg}
        onChange={(e) => setMsg(e.target.value)}
        rows={3}
        className="mt-2.5 w-full resize-y rounded-lg border border-line bg-paper/60 px-2.5 py-2 text-[13px] leading-relaxed text-ink-soft outline-none focus:border-brand-600"
      />

      <div className="mt-2 flex flex-wrap gap-2">
        <button onClick={copy} className="tap rounded-lg bg-brand-600 px-3 py-2 text-[13px] font-bold text-white">
          {copied ? "복사됨 ✓" : "메시지 복사"}
        </button>
        {item.phone && (
          <>
            <a href={smsHref(item.phone, msg)} className="tap rounded-lg bg-white px-3 py-2 text-[13px] font-bold text-ink-soft ring-1 ring-line">
              문자 보내기
            </a>
            <a href={telHref(item.phone)} className="tap rounded-lg bg-white px-3 py-2 text-[13px] font-bold text-ink-soft ring-1 ring-line">
              전화 {item.phone}
            </a>
          </>
        )}
      </div>
    </div>
  );
}
