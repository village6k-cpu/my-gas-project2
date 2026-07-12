"use client";

import { useCallback, useEffect, useState } from "react";
import { authFetch } from "@/lib/data/authFetch";

type ReactItem = { name: string; phone: string; count: number; daysSince: number; intervalDays: number; favGear: string[]; discount: string; lastRentedAt: string; reason: string; draft: string };
type Unbilled = { name: string; count: number; masterPrice: number; lastRentedAt: string };
type Idle = { name: string; category: string; stock: number; price: number; foregone: number; lastRentedAt: string; neverRented: boolean };
type Todo = { key: string; icon: string; title: string; desc: string; count: number; action: string };
type Kpi = { thisMonth: string; revenueThisMonth: number; revenueLastMonth: number; activeThisMonth: number; activeLastMonth: number; txThisMonth: number; txLastMonth: number };
type Data = {
  ok: boolean; error?: string; today: string; weekOf: string;
  kpi: Kpi; season: { icon: string; tag: string; title: string; desc: string };
  todos: Todo[];
  reactivation: { due: ReactItem[]; atRisk: ReactItem[] };
  billing: { unbilled: Unbilled[]; idle: Idle[] };
  summary: { dueNow: number; atRisk: number; unbilled: number; idle: number; actionsThisWeek: number };
};

const won = (n: number) => "₩" + (n || 0).toLocaleString("ko-KR");
const wonShort = (n: number) => {
  if (!n) return "₩0";
  if (n >= 100000000) return "₩" + (n / 100000000).toFixed(1) + "억";
  if (n >= 10000) return "₩" + Math.round(n / 10000).toLocaleString("ko-KR") + "만";
  return "₩" + n.toLocaleString("ko-KR");
};
const telHref = (p: string) => "tel:" + (p || "").replace(/[^0-9+]/g, "");
const smsHref = (p: string, body: string) => "sms:" + (p || "").replace(/[^0-9+]/g, "") + (body ? `?&body=${encodeURIComponent(body)}` : "");

export function AutopilotView() {
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"due" | "atRisk" | "money">("due");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await authFetch("/api/gas?action=autopilot");
      const j = (await r.json()) as Data;
      if (!j.ok) throw new Error(j.error || "오토파일럿 계산 실패");
      setData(j);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const revDelta = data ? data.kpi.revenueThisMonth - data.kpi.revenueLastMonth : 0;
  const actDelta = data ? data.kpi.activeThisMonth - data.kpi.activeLastMonth : 0;

  return (
    <div className="mx-auto flex min-h-screen max-w-2xl flex-col bg-paper">
      <header className="safe-top sticky top-0 z-40 bg-paper/90 px-4 pb-2 pt-3 backdrop-blur-md ring-1 ring-line/70">
        <div className="flex items-center justify-between">
          <div>
            <a href="/operations" className="text-[12px] font-semibold text-ink-faint">← 헤이빌리</a>
            <h1 className="text-[19px] font-extrabold text-ink">🚀 그로스 오토파일럿</h1>
          </div>
          <div className="flex items-center gap-2">
            <a href="/radar" className="tap flex h-9 items-center rounded-full bg-white px-2.5 text-[11.5px] font-bold text-ink-soft ring-1 ring-line/60">🎯</a>
            <a href="/profit" className="tap flex h-9 items-center rounded-full bg-white px-2.5 text-[11.5px] font-bold text-ink-soft ring-1 ring-line/60">💰</a>
            <button onClick={load} className={`tap flex h-9 w-9 items-center justify-center rounded-full bg-white text-ink-soft ring-1 ring-line/60 ${loading ? "animate-spin" : ""}`} aria-label="새로고침">↻</button>
          </div>
        </div>
        <p className="mt-0.5 text-[12px] text-ink-mute">
          이번 주 할 일을 시스템이 미리 계산·초안까지 해뒀어요. 확인하고 원탭으로 실행만 하세요{data ? ` · ${data.weekOf}` : ""}.
        </p>
      </header>

      <main className="flex-1 space-y-3 p-3 pb-24">
        {error && <div className="rounded-xl bg-attention-bg px-3.5 py-2.5 text-[13px] font-medium text-attention-fg ring-1 ring-attention-ring">{error}</div>}
        {loading && !data && <div className="py-10 text-center text-[14px] font-bold text-ink-faint">오토파일럿 계산 중…</div>}

        {data && (
          <>
            {/* KPI */}
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
              <Stat label="이번달 매출" value={wonShort(data.kpi.revenueThisMonth)} delta={revDelta} deltaFmt={wonShort} tone="brand" />
              <Stat label="활성 고객" value={String(data.kpi.activeThisMonth) + "명"} delta={actDelta} deltaFmt={(n) => `${n}명`} />
              <Stat label="연락 적기" value={String(data.summary.dueNow) + "명"} tone="brand" />
              <Stat label="돈 새는 곳" value={String(data.summary.unbilled + data.summary.idle) + "건"} tone="warn" />
            </div>

            {/* 시즌 */}
            <div className="rounded-2xl bg-white p-3.5 shadow-card ring-1 ring-line">
              <div className="flex items-center gap-2">
                <span className="text-[18px]">{data.season.icon}</span>
                <span className="text-[13px] font-extrabold text-ink">{data.season.title}</span>
                <span className="ml-auto rounded-full bg-brand-50 px-2 py-0.5 text-[10px] font-bold text-brand-600">{data.season.tag}</span>
              </div>
              <p className="mt-1 text-[12.5px] text-ink-mute">{data.season.desc}</p>
            </div>

            {/* 이번 주 할 일 */}
            <div className="rounded-2xl bg-white p-3.5 shadow-card ring-1 ring-line">
              <div className="mb-2 flex items-center gap-2">
                <span className="text-[13px] font-extrabold text-ink">✅ 이번 주 할 일</span>
                <span className="rounded-full bg-brand-600 px-2 py-0.5 text-[11px] font-extrabold text-white">{data.todos.length}</span>
              </div>
              <div className="space-y-2">
                {data.todos.map((t) => (
                  <div key={t.key} className="flex items-start gap-2.5 rounded-xl bg-paper/70 px-3 py-2.5">
                    <span className="text-[16px] leading-tight">{t.icon}</span>
                    <div className="min-w-0 flex-1">
                      <div className="text-[13.5px] font-bold text-ink">{t.title}</div>
                      <div className="text-[11.5px] text-ink-mute">{t.desc}</div>
                    </div>
                    {t.count > 0 && (
                      <button
                        onClick={() => setTab(t.key === "unbilled" || t.key === "idle" ? "money" : t.key === "atrisk" ? "atRisk" : "due")}
                        className="tap shrink-0 self-center rounded-lg bg-brand-600 px-2.5 py-1.5 text-[11.5px] font-bold text-white"
                      >
                        {t.action} →
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* 실행 탭 */}
            <div className="flex gap-2 pt-1">
              <TabButton active={tab === "due"} onClick={() => setTab("due")}>재방문 발송 ({data.summary.dueNow})</TabButton>
              <TabButton active={tab === "atRisk"} onClick={() => setTab("atRisk")}>이탈위험 ({data.summary.atRisk})</TabButton>
              <TabButton active={tab === "money"} onClick={() => setTab("money")}>돈 새는 곳 ({data.summary.unbilled + data.summary.idle})</TabButton>
            </div>

            {tab === "due" && (data.reactivation.due.length ? data.reactivation.due.map((it, i) => <SendCard key={it.name + i} item={it} rank={i + 1} />) : <Empty text="지금 연락 적기 고객이 없어요." />)}
            {tab === "atRisk" && (data.reactivation.atRisk.length ? data.reactivation.atRisk.map((it, i) => <SendCard key={it.name + i} item={it} rank={i + 1} atRisk /> ) : <Empty text="이탈위험 단골이 없어요. 👍" />)}
            {tab === "money" && <MoneySection unbilled={data.billing.unbilled} idle={data.billing.idle} />}

            <p className="pt-2 text-center text-[11px] text-ink-faint">
              {data.today} 기준 · 재방문 레이더 + 장비 수익 레이더 + 주간 KPI 자동 조립 · 발송은 검토 후 직접(반자동)
            </p>
          </>
        )}
      </main>
    </div>
  );
}

function Stat({ label, value, sub, tone, delta, deltaFmt }: { label: string; value: string; sub?: string; tone?: "brand" | "warn"; delta?: number; deltaFmt?: (n: number) => string }) {
  const valCls = tone === "brand" ? "text-brand-600" : tone === "warn" ? "text-attention-fg" : "text-ink";
  const up = (delta ?? 0) > 0, down = (delta ?? 0) < 0;
  return (
    <div className="rounded-xl bg-white p-3 ring-1 ring-line/70">
      <div className="text-[11px] font-semibold text-ink-mute">{label}</div>
      <div className={`mt-0.5 text-[17px] font-extrabold ${valCls}`}>{value}</div>
      {delta != null && delta !== 0 && deltaFmt && (
        <div className={`text-[10.5px] font-bold ${up ? "text-checkin-fg" : down ? "text-attention-fg" : "text-ink-faint"}`}>
          {up ? "▲" : "▼"} {deltaFmt(Math.abs(delta))} 전월대비
        </div>
      )}
      {sub && <div className="text-[10px] text-ink-faint">{sub}</div>}
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className={`tap flex-1 rounded-full px-2 py-2 text-[12px] font-bold ring-1 ${active ? "bg-brand-600 text-white ring-brand-600" : "bg-white text-ink-mute ring-line"}`}>{children}</button>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="py-8 text-center text-[13px] text-ink-mute">{text}</div>;
}

function SendCard({ item, rank, atRisk }: { item: ReactItem; rank: number; atRisk?: boolean }) {
  const [msg, setMsg] = useState(item.draft);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(msg); setCopied(true); setTimeout(() => setCopied(false), 1500); }
    catch {
      const el = document.getElementById(`ap-${atRisk ? "r" : "d"}-${rank}`) as HTMLTextAreaElement | null;
      if (el) { el.focus(); el.select(); }
    }
  };
  return (
    <div className={`rounded-2xl bg-white p-3.5 shadow-card ring-1 ${atRisk ? "ring-attention-ring" : "ring-line"}`}>
      <div className="flex items-start gap-2.5">
        <div className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[12px] font-extrabold ${atRisk ? "bg-attention-bg text-attention-fg" : "bg-brand-50 text-brand-600"}`}>{rank}</div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[15px] font-extrabold text-ink">{item.name || "이름없음"}</span>
            {item.discount && /단골|제휴|VIP/.test(item.discount) && <span className="rounded-full bg-brand-50 px-1.5 py-0.5 text-[10px] font-bold text-brand-600">{item.discount}</span>}
          </div>
          <div className="mt-0.5 flex flex-wrap gap-x-2.5 gap-y-0.5 text-[11.5px] text-ink-mute">
            <span>{item.count}회 대여</span><span>주기 {item.intervalDays}일</span><span>마지막 {item.daysSince}일 전</span>
          </div>
        </div>
      </div>
      <div className={`mt-2 rounded-lg px-2.5 py-1.5 text-[12px] font-medium ${atRisk ? "bg-attention-bg text-attention-fg" : "bg-paper text-ink-soft"}`}>{item.reason}</div>
      <textarea id={`ap-${atRisk ? "r" : "d"}-${rank}`} value={msg} onChange={(e) => setMsg(e.target.value)} rows={3}
        className="mt-2.5 w-full resize-y rounded-lg border border-line bg-paper/60 px-2.5 py-2 text-[13px] leading-relaxed text-ink-soft outline-none focus:border-brand-600" />
      <div className="mt-2 flex flex-wrap gap-2">
        <button onClick={copy} className="tap rounded-lg bg-brand-600 px-3 py-2 text-[13px] font-bold text-white">{copied ? "복사됨 ✓" : "메시지 복사"}</button>
        {item.phone && (
          <>
            <a href={smsHref(item.phone, msg)} className="tap rounded-lg bg-white px-3 py-2 text-[13px] font-bold text-ink-soft ring-1 ring-line">문자 보내기</a>
            <a href={telHref(item.phone)} className="tap rounded-lg bg-white px-3 py-2 text-[13px] font-bold text-ink-soft ring-1 ring-line">전화 {item.phone}</a>
          </>
        )}
      </div>
    </div>
  );
}

function MoneySection({ unbilled, idle }: { unbilled: Unbilled[]; idle: Idle[] }) {
  return (
    <div className="space-y-2.5">
      <div className="text-[12.5px] font-extrabold text-ink-soft">💸 청구 누락 의심 — 정가 있는데 0원으로 나감</div>
      {unbilled.length ? unbilled.map((u, i) => (
        <div key={u.name + i} className="rounded-xl bg-white p-3 shadow-card ring-1 ring-warn-ring">
          <div className="flex items-center justify-between gap-2">
            <span className="min-w-0 truncate text-[13.5px] font-bold text-ink">{u.name}</span>
            <span className="shrink-0 rounded-full bg-warn-bg px-2 py-0.5 text-[11px] font-bold text-warn-fg">정가 {won(u.masterPrice)}</span>
          </div>
          <div className="mt-0.5 text-[11.5px] text-ink-mute">{u.count}회 대여 · 최근 {u.lastRentedAt || "?"} — 계약 확인해서 청구 여부 점검</div>
        </div>
      )) : <Empty text="청구 누락 의심 없음 👍" />}

      <div className="mt-3 text-[12.5px] font-extrabold text-ink-soft">📦 노는 고가장비 — 굴리면 돈</div>
      {idle.length ? idle.map((it, i) => (
        <div key={it.name + i} className="rounded-xl bg-white p-3 shadow-card ring-1 ring-attention-ring">
          <div className="flex items-center justify-between gap-2">
            <span className="min-w-0 truncate text-[13.5px] font-bold text-ink">{it.name}</span>
            <span className="shrink-0 text-[13px] font-extrabold text-attention-fg">{wonShort(it.foregone)}/일</span>
          </div>
          <div className="mt-0.5 text-[11.5px] text-ink-mute">보유 {it.stock} · 단가 {won(it.price)} · {it.neverRented ? "대여 이력 없음" : `마지막 ${it.lastRentedAt}`} — 세트 끼워팔기·프로모</div>
        </div>
      )) : <Empty text="노는 장비 없음 👍" />}
    </div>
  );
}
