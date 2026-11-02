"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { authFetch } from "@/lib/data/authFetch";
import { groupCritical } from "@/lib/followups/triage.mjs";
type Item = { id: string; version: number; caseKey: string; title: string; summary: string; action: string; reason: string; kind: string; balance: number | null; unallocated: number | null; verifiedAt: string; updatedAt: string; accounts: {tradeId: string; balance: number | null; paid: number | null; depositStatus: string}[]; archivedAt: string | null };
type Payload = { ok: true; items: Item[]; total: number; nextOffset: number | null };
const amount = (n: number | null) => n === null ? "미확정" : `${n.toLocaleString("ko-KR")}원`;
const date = (s: string) => s ? new Date(s).toLocaleString("ko-KR", {month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit"}) : "확인일 미기록";
export function OwnerTriageView({ active, refreshVersion = 0 }: { active: boolean; refreshVersion?: number }) {
  const [mode, setMode] = useState<"critical" | "archive">("critical");
  const [offset, setOffset] = useState(0), [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true), [error, setError] = useState(""), [busy, setBusy] = useState<string | null>(null), [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const seq = useRef(0);
  const load = useCallback(async () => {
    const id = ++seq.current; setLoading(true);setError("");
    try {
      const r = await authFetch(`/api/follow-ups/triage?mode=${mode}&offset=${offset}&q=${encodeURIComponent(query)}`), p = await r.json();
      if (!r.ok || !p.ok || !Array.isArray(p.items)) throw new Error();
      if (id === seq.current) setData(p);
    } catch { if (id === seq.current) { setData(null);setError("목록을 불러오지 못했습니다. 새로고침해 주세요."); } }
    finally { if (id === seq.current) setLoading(false); }
  }, [mode, offset, query]);
  useEffect(() => {
    if (!active) return;
    load();
    const refresh = () => { if (!document.hidden) load(); };
    const timer = setInterval(refresh, 60000);
    document.addEventListener("visibilitychange", refresh);
    return () => { ++seq.current; clearInterval(timer); document.removeEventListener("visibilitychange", refresh); };
  }, [active, load, refreshVersion]);
  const items = useMemo(() => data?.items || [], [data]);
  const groups = groupCritical(items) as {key: string; title: string; items: Item[]}[];
  const act = async (item: Item) => {
    if (busy || loading) return;
    setBusy(item.id);setError("");
    try {
      const restore = mode === "archive";
      const r = await authFetch(restore ? "/api/follow-ups/triage" : "/api/follow-ups", { method:"PATCH", headers:{"content-type":"application/json"}, body:JSON.stringify(restore ? {id:item.id,expectedVersion:item.version} : {id:item.id,expectedVersion:item.version,action:{type:"complete"}}) });
      const p = await r.json();
      if (!r.ok || !p.ok) { await load();setError(r.status === 409 ? "다른 곳에서 변경된 카드입니다. 최신 내용을 확인해 주세요." : "반영하지 못했습니다. 다시 확인해 주세요.");return; }
      if ((data?.items.length || 0) === 1 && offset > 0) setOffset(Math.max(0, offset - 50)); else await load();
    } catch { setError("반영하지 못했습니다. 다시 확인해 주세요."); } finally { setBusy(null); }
  };
  return <main className="mx-auto w-full max-w-5xl p-3 pb-24 lg:p-5">
    <div className="mb-3 flex flex-wrap gap-2">
      {([['critical','대표 확인'],['archive','정리 보관함']] as const).map(([key,label]) => <button key={key} type="button" disabled={!!busy} onClick={() => { setMode(key);setOffset(0);setData(null);setSearch("");setQuery("");setLoading(true); }} className={`tap rounded-xl px-4 py-2 text-sm font-bold ${mode === key ? 'bg-ink text-white' : 'bg-white ring-1 ring-line'}`}>{label}</button>)}
    </div>
    <div className="mb-4 rounded-xl bg-white p-4 ring-1 ring-line">
      <h2 className="text-lg font-extrabold">{mode === 'critical' ? '대표 판단이 필요한 일' : '기존 업무 정리 보관함'} <span className="text-ink-mute">{data ? `${data.total}개` : ''}</span></h2>
      <p className="mt-2 text-sm leading-relaxed text-ink-soft">{mode === 'critical' ? '50만 원 이상 수납·잔액 대조와 금액이 미확정인 분실·파손·분쟁을 모았습니다. 원장 잔액은 미수 확정액이 아닙니다. 은행 입금과 배분 상태를 함께 확인하세요.' : '기존에 쌓인 일반 업무를 정리 보관했습니다. 실제 업무 완료를 뜻하지 않습니다. 필요한 카드는 다시 지금 할 일로 복원할 수 있습니다.'}</p>
      <form onSubmit={e=>{e.preventDefault();setOffset(0);setQuery(search.trim());}} className="mt-3 flex gap-2"><input aria-label="이름·업무 제목 검색" placeholder="전체 목록에서 이름·업무 제목 검색" value={search} onChange={e=>setSearch(e.target.value)} maxLength={100} className="min-w-0 flex-1 rounded-lg border border-line px-3 py-2 text-sm" /><button type="submit" disabled={!!busy} className="tap rounded-lg border border-line px-3 py-2 text-sm font-bold">검색</button></form>
      {data && (offset > 0 || data.nextOffset !== null) && <nav aria-label="대표 확인 목록 페이지" className="mt-3 flex justify-between">
        <button type="button" disabled={offset === 0 || loading || !!busy} onClick={()=>setOffset(Math.max(0,offset-50))} className="tap rounded-lg px-3 py-2 font-bold disabled:opacity-40">이전</button>
        <span className="p-2 text-sm">{Math.floor(offset/50)+1}쪽</span>
        <button type="button" disabled={data.nextOffset === null || loading || !!busy} onClick={()=>setOffset(data.nextOffset!)} className="tap rounded-lg px-3 py-2 font-bold disabled:opacity-40">다음</button>
      </nav>}
    </div>
    {error && <p role="alert" className="mb-3 rounded-xl bg-attention-bg p-3 text-sm text-attention-fg">{error}</p>}
    {loading && <p role="status" className="p-3 text-sm text-ink-mute">불러오는 중…</p>}
    {!loading && data && !items.length && <p className="p-6 text-center text-ink-mute">표시할 카드가 없습니다.</p>}
    <div className="space-y-4">{groups.map(group => <section key={group.key} className="overflow-hidden rounded-2xl bg-white ring-1 ring-line">
      <h3 className="border-b border-line bg-paper px-4 py-3 font-extrabold">{group.title} · {group.items.length}개</h3>
      {group.items.map(item => <article key={item.id} className="border-b border-line p-4 last:border-0">
        <h4 className="font-bold">{item.title}</h4>
        {item.reason && mode === 'critical' && <p className="mt-2 text-sm font-semibold text-brand-700">{item.reason}</p>}
        <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-ink-soft">{item.summary}</p>
        {mode === 'critical' && item.kind === 'money_reconcile' && <div className="mt-3 rounded-xl bg-paper p-3 text-sm">
          <div>원장 잔액 대조: <b>{amount(item.balance)}</b></div>
          <div className="mt-1">동일 명의 미배분 입금: <b>{amount(item.unallocated)}</b></div>
          <p className="mt-1 text-xs text-ink-mute">별개 금액입니다. 실제 충당 대상 확인 전 차감하지 않습니다. · 대조 {date(item.verifiedAt)}</p>
          {item.accounts.length > 0 && <details className="mt-2"><summary className="cursor-pointer font-bold">거래별 근거 {item.accounts.length}건</summary>{item.accounts.map(a=><div key={a.tradeId} className="mt-2 border-t border-line pt-2">{a.tradeId} · 잔액 {amount(a.balance)} · 수납 {amount(a.paid)}{a.depositStatus ? ` · 장부 ${a.depositStatus}` : ''}</div>)}</details>}
          <a href="/payments" className="mt-2 inline-block font-bold text-brand-700 underline">수납에서 원본 대조</a>
        </div>}
        {item.action && mode === 'critical' && <p className="mt-3 text-sm"><b>다음 할 일</b> · {item.action}</p>}
        <div className="mt-3 flex items-center justify-between gap-3"><span className="text-xs text-ink-mute">{mode === 'archive' ? `정리 보관 ${date(item.archivedAt || '')}` : `최근 기록 ${date(item.updatedAt)}`}</span><button type="button" disabled={!!busy || loading} onClick={()=>act(item)} className="tap shrink-0 rounded-xl bg-ink px-4 py-2 text-sm font-bold text-white disabled:opacity-40">{busy === item.id ? '반영 중…' : mode === 'archive' ? '지금 할 일로 복원' : '확인 완료'}</button></div>
      </article>)}
    </section>)}</div>
  </main>;
}
