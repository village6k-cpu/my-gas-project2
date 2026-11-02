"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { authFetch } from '@/lib/data/authFetch';
import { invoiceRequestSummary } from '@/lib/followups/invoice-model.mjs';
import { shortDate, timeLabel } from '@/lib/domain/status';

type Buyer = { corpNum: string; corpName: string; ceoName: string; email: string; addr: string; bizType: string; bizClass: string };
type Invoice = { tradeId: string; customerName: string; phone: string; checkoutAt: string; checkinAt: string;
  amount: number | null; supplyCost: number | null; tax: number | null; buyer: Buyer; paymentMethod: string;
  depositStatus: string; purposeType: string; issueStatus: string; issueNote: string; mgtKey: string; fingerprint: string };
type RequestRow = { id: string; version: number; title: string; summary: string; requestedAt: string; priority: string;
  customerLabel: string; tradeIds: string[]; workState: string; item: Invoice | null; complexReason: string | null;
  blockers: string[]; status: 'ready' | 'needs_info' | 'issued'; canIssue: boolean; conversationUrl: string | null };
type Company = { id: string; name: string };
type Candidate = { trade_id: string; customer_name: string; checkout_at: string; amount: number | null };
type Payload = { ok: true; rows: RequestRow[]; buyers: Company[]; observedAt: string };
type Filter = 'pending' | 'ready' | 'needs_info' | 'issued';
const EMPTY_BUYER: Buyer = { corpNum: '', corpName: '', ceoName: '', email: '', addr: '', bizType: '', bizClass: '' };
const money = (value: number | null | undefined) => value == null ? '금액 확인 필요' : `${value.toLocaleString('ko-KR')}원`;
function dateLabel(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value || '일정 확인 필요' : date.toLocaleString('ko-KR', {
    timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
}
const rentalLabel = (value: string) => value ? `${shortDate(value)} ${timeLabel(value)}` : '일정 확인 필요';
async function api(body: Record<string, unknown>) {
  const response = await authFetch('/api/follow-ups/invoices', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => null);
  if (!response.ok || data?.ok !== true) throw new Error(data?.error || '요청 결과를 확인하지 못했습니다. 새로고침 후 발행 상태를 확인해주세요.');
  return data;
}

export function InvoiceRequestsView({ active, refreshVersion, onCount }: { active: boolean; refreshVersion: number; onCount: (n: number) => void }) {
  const [payload, setPayload] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [notice, setNotice] = useState('');
  const [filter, setFilter] = useState<Filter>('pending');
  const [search, setSearch] = useState('');
  const requestId = useRef(0), actions = useRef(0);
  const load = useCallback(async () => {
    if (actions.current) return;
    const current = ++requestId.current;
    setLoading(true);
    try {
      const response = await authFetch('/api/follow-ups/invoices');
      const data = await response.json();
      if (!response.ok || data?.ok !== true || !Array.isArray(data.rows)) throw new Error('load failed');
      if (current !== requestId.current) return;
      setPayload(data); setUnavailable(false);
      onCount(invoiceRequestSummary(data.rows).pending);
    } catch {
      if (current === requestId.current) setUnavailable(true);
    } finally { if (current === requestId.current) setLoading(false); }
  }, [onCount]);
  useEffect(() => {
    if (!active) return;
    void load();
    const tick = () => { if (!document.hidden) void load(); };
    const timer = setInterval(tick, 30_000);
    document.addEventListener('visibilitychange', tick);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', tick); requestId.current++; };
  }, [active, refreshVersion, load]);
  const updateRow = useCallback((row: RequestRow, message?: string) => {
    requestId.current++;
    setLoading(false);
    setPayload(current => current ? { ...current, rows: current.rows.map(r => r.id === row.id ? row : r) } : current);
    if (message) setNotice(message);
  }, []);
  const summary = useMemo(() => invoiceRequestSummary(payload?.rows || []), [payload]);
  useEffect(() => { if (payload) onCount(summary.pending); }, [payload, summary.pending, onCount]);
  const rows = useMemo(() => (payload?.rows || []).filter(row => {
    const pending = !['resolved', 'dismissed'].includes(row.workState) && row.status !== 'issued';
    if (filter === 'pending' ? !pending : filter === 'issued' ? row.status !== 'issued' : !pending || row.status !== filter) return false;
    return !search.trim() || [row.title, row.customerLabel, row.item?.tradeId, row.item?.buyer.corpName, row.item?.buyer.corpNum]
      .some(value => value?.toLowerCase().includes(search.trim().toLowerCase()));
  }), [payload, filter, search]);
  return <section aria-label="계산서 요청 작업대" className="flex-1 p-3 pb-24 lg:p-4">
    <div className="mb-4 flex flex-wrap items-end justify-between gap-2">
      <div><h2 className="text-lg font-extrabold text-ink">계산서 요청</h2><p className="mt-1 text-[13px] text-ink-mute">발행처와 금액을 확인하고 바로 발행하세요. 발행 후 요청도 자동으로 완료됩니다.</p></div>
      <span className="text-[11px] text-ink-faint">{payload ? `원장 확인 ${dateLabel(payload.observedAt)}` : '원장 확인 중'}</span>
    </div>
    <div className="mb-4 grid grid-cols-3 gap-2">
      {([['ready', '바로 발행 가능', summary.ready], ['needs_info', '정보 확인 필요', summary.needsInfo], ['issued', '발행 완료', summary.issued]] as const).map(([key, label, count]) =>
        <button type="button" key={key} onClick={() => setFilter(key)} className={`tap rounded-xl border p-3 text-left ${filter === key ? 'border-brand-600 bg-brand-50' : 'border-line bg-white'}`}>
          <span className="block text-[12px] font-semibold text-ink-mute">{label}</span><strong className="mt-1 block text-2xl tabular-nums text-ink">{count}</strong>
        </button>)}
    </div>
    <div className="mb-3 flex flex-wrap gap-2">
      <button type="button" onClick={() => setFilter('pending')} className={`tap rounded-full px-3 py-2 text-[13px] font-bold ${filter === 'pending' ? 'bg-ink text-white' : 'bg-white ring-1 ring-line'}`}>처리 대기 {summary.pending}</button>
      <input aria-label="계산서 요청 검색" placeholder="고객·발행처·거래번호 검색" value={search} onChange={e => setSearch(e.target.value)} className="min-w-0 flex-1 rounded-xl border border-line bg-white px-3 py-2 text-sm" />
    </div>
    {unavailable && <div role="alert" className="mb-3 rounded-xl bg-attention-bg p-3 text-sm font-bold text-attention-fg">원장을 불러오지 못했습니다. 마지막 내용을 표시하며 발행은 잠시 중지합니다. <button type="button" onClick={() => void load()} className="underline">다시 확인</button></div>}
    {notice && <p role="status" className="mb-3 rounded-xl bg-checkin-bg p-3 text-sm font-bold text-checkin-fg">{notice}</p>}
    {loading && !payload ? <p className="rounded-xl bg-white p-8 text-center text-ink-mute">계산서 요청과 발행 원장을 대조하고 있습니다…</p>
      : <div className="grid gap-3 xl:grid-cols-2">{rows.map(row => <InvoiceCard key={row.id} row={row} buyers={payload?.buyers || []} disabled={unavailable}
        onUpdate={updateRow} onBusy={busy => { actions.current += busy ? 1 : -1; if (busy) requestId.current++; }} />)}</div>}
    {!loading && payload && !rows.length && <p className="rounded-xl border border-dashed border-line bg-white p-10 text-center font-bold text-ink-mute">{search ? '검색 결과가 없습니다' : filter === 'issued' ? '확인된 발행 완료 건이 없습니다' : '표시할 계산서 요청이 없습니다'}</p>}
  </section>;
}

function InvoiceCard({ row, buyers, disabled, onUpdate, onBusy }: { row: RequestRow; buyers: Company[]; disabled: boolean;
  onUpdate: (row: RequestRow, message?: string) => void; onBusy: (busy: boolean) => void }) {
  const item = row.item;
  const [editing, setEditing] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const busyRef = useRef(false);
  const editVersion = useRef(row.version);
  const [draft, setDraft] = useState<Buyer>(item?.buyer || EMPTY_BUYER);
  const [tradeId, setTradeId] = useState(item?.tradeId || '');
  const [query, setQuery] = useState(row.customerLabel), [candidates, setCandidates] = useState<Candidate[]>([]);
  const [searched, setSearched] = useState(false);
  useEffect(() => { if (!editing) { setDraft(item?.buyer || EMPTY_BUYER); setTradeId(item?.tradeId || ''); } }, [item, editing]);
  async function run(task: () => Promise<void>) {
    if (busyRef.current || disabled) return;
    busyRef.current = true; setBusy(true); setError(''); onBusy(true);
    try { await task(); } catch (e) { setError(e instanceof Error ? e.message : '처리하지 못했습니다'); }
    finally { busyRef.current = false; setBusy(false); onBusy(false); }
  }
  function prepare(buyerId?: string) {
    return run(async () => {
      const data = await api({ action: 'prepare', id: row.id, expectedVersion: editing ? editVersion.current : row.version, tradeId,
        ...(buyerId ? { buyerId } : { buyer: draft }) });
      onUpdate(data.row); setDraft(data.row.item.buyer); setEditing(false);
    });
  }
  function issue() {
    if (!item || !row.canIssue || editing) return;
    return run(async () => {
      try {
        const data = await api({ action: 'issue', id: row.id, expectedVersion: row.version,
          tradeId: item.tradeId, fingerprint: item.fingerprint, buyer: item.buyer });
        onUpdate(data.row, data.warning || `${row.customerLabel} · ${money(data.row.item.amount)} 세금계산서 발행 완료`);
      } catch (e) {
        onUpdate({ ...row, canIssue: false, status: 'needs_info', blockers: ['발행 상태를 새로 확인해주세요. 확인 전에는 재발행하지 마세요.'] });
        throw e;
      }
    });
  }
  function selectTrade(value: string) {
    setTradeId(value);
    if (!value) return;
    return run(async () => {
      const data = await api({ action: 'prepare', id: row.id, expectedVersion: editVersion.current, tradeId: value });
      editVersion.current = data.row.version;
      onUpdate(data.row); setDraft(data.row.item.buyer);
    });
  }
  const tone = row.status === 'issued' ? 'bg-checkin-bg text-checkin-fg' : row.status === 'ready' ? 'bg-brand-50 text-brand-700' : 'bg-warn-bg text-warn-fg';
  return <article className={`rounded-2xl border bg-white p-4 shadow-sm ${row.priority === 'p0' ? 'border-attention-ring' : 'border-line'}`} aria-label={`${row.customerLabel} 계산서 요청`}>
    <div className="flex items-start justify-between gap-2">
      <div className="min-w-0"><h3 className="text-lg font-extrabold text-ink">{row.customerLabel}</h3><p className="mt-0.5 text-[12px] text-ink-mute">요청 {dateLabel(row.requestedAt)}{item ? ` · ${item.tradeId}` : ''}</p></div>
      <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-extrabold ${tone}`}>{row.status === 'issued' ? '발행완료' : row.status === 'ready' ? '발행가능' : '확인필요'}</span>
    </div>
    <p className="mt-3 text-[13px] font-semibold leading-relaxed text-ink-soft">{row.title}</p>
    {item && <>
      <div className="mt-3 rounded-xl bg-paper p-3">
        <div className="flex items-center justify-between gap-2"><strong className="text-xl tabular-nums text-ink">{money(item.amount)}</strong><span className="rounded-md bg-white px-2 py-1 text-xs font-bold text-ink-soft">{item.purposeType} · VAT 포함</span></div>
        <p className="mt-1 text-[12px] text-ink-mute">공급가 {money(item.supplyCost)} + 부가세 {money(item.tax)}</p>
        <p className="mt-2 text-[12px] text-ink-mute">{item.paymentMethod || '결제수단 미입력'} · {item.depositStatus || '미입금'}</p>
      </div>
      <dl className="mt-3 grid grid-cols-[64px_minmax(0,1fr)] gap-x-2 gap-y-1.5 text-[13px]">
        <dt className="text-ink-faint">발행처</dt><dd className="font-bold text-ink">{item.buyer.corpName || '선택 필요'}</dd>
        <dt className="text-ink-faint">사업자</dt><dd className="text-ink-soft">{item.buyer.corpNum || '확인 필요'}{item.buyer.ceoName ? ` · ${item.buyer.ceoName}` : ''}</dd>
        <dt className="text-ink-faint">이메일</dt><dd className="break-all text-ink-soft">{item.buyer.email || '입력 필요'}</dd>
        <dt className="text-ink-faint">대여기간</dt><dd className="text-ink-soft">{rentalLabel(item.checkoutAt)} ~ {rentalLabel(item.checkinAt)}</dd>
      </dl>
    </>}
    {row.status !== 'issued' && row.blockers.length > 0 && <div className="mt-3 rounded-xl bg-warn-bg p-3 text-[12px] font-semibold leading-relaxed text-warn-fg">{row.blockers.join(' · ')}</div>}
    {row.status === 'issued' && <p className="mt-3 break-all text-xs text-checkin-fg">발행 관리번호 {item?.mgtKey}</p>}
    <details className="mt-3 text-[12px] text-ink-mute"><summary className="cursor-pointer font-semibold">고객 요청 내용</summary><p className="mt-2 whitespace-pre-wrap leading-relaxed">{row.summary}</p></details>
    {error && <p role="alert" className="mt-3 rounded-xl bg-attention-bg p-3 text-sm font-semibold text-attention-fg">{error}</p>}
    {editing && <div className="mt-3 space-y-2 rounded-xl border border-line bg-paper p-3">
      <div className="flex gap-2"><input aria-label="연결할 거래 검색" value={query} onChange={e => setQuery(e.target.value)} placeholder="고객명 또는 거래번호" className="min-w-0 flex-1 rounded-lg border border-line bg-white px-2 py-2 text-sm" />
        <button type="button" disabled={busy} className="tap rounded-lg bg-white px-3 text-sm font-bold ring-1 ring-line" onClick={() => void run(async () => {
          const response = await authFetch('/api/follow-ups/invoices?search=' + encodeURIComponent(query)); const data = await response.json();
          if (!response.ok || !data.ok) throw new Error(data.error || '검색 실패'); setCandidates(data.trades); setSearched(true);
        })}>거래 찾기</button></div>
      <label className="block text-xs font-bold text-ink-soft">발행할 거래<select aria-label="발행할 거래" disabled={busy} value={tradeId} onChange={e => void selectTrade(e.target.value)} className="mt-1 w-full rounded-lg border border-line bg-white p-2 text-sm">
        <option value="">거래를 선택해주세요</option>{item && !candidates.some(c => c.trade_id === item.tradeId) && <option value={item.tradeId}>{item.tradeId} · {item.customerName}</option>}
        {candidates.map(c => <option key={c.trade_id} value={c.trade_id}>{c.trade_id} · {c.customer_name} · {dateLabel(c.checkout_at)} · {money(c.amount)}</option>)}
      </select></label>
      {searched && !candidates.length && <p className="text-xs text-ink-mute">찾은 거래가 없습니다. 이름 또는 거래번호를 확인해주세요.</p>}
      <label className="block text-xs font-bold text-ink-soft">등록 발행처<select aria-label="등록 발행처" value={buyers.some(b => b.id === draft.corpNum) ? draft.corpNum : ''} disabled={busy || !tradeId} onChange={e => {
        if (e.target.value) void prepare(e.target.value); else setDraft({ ...EMPTY_BUYER });
      }} className="mt-1 w-full rounded-lg border border-line bg-white p-2 text-sm"><option value="">신규 발행처 정보 입력</option>{buyers.map((b, i) => <option key={`${b.id}:${i}`} value={b.id}>{b.name} · {b.id}</option>)}</select></label>
      {([['corpNum', '사업자등록번호'], ['corpName', '상호'], ['ceoName', '대표자명'], ['email', '수신 이메일'], ['addr', '사업장 주소'], ['bizType', '업태'], ['bizClass', '종목']] as const).map(([key, label]) =>
        <label key={key} className="block text-xs font-semibold text-ink-mute">{label}<input value={draft[key]} onChange={e => setDraft(current => ({ ...current, [key]: e.target.value }))} className="mt-1 w-full rounded-lg border border-line bg-white px-2 py-2 text-sm text-ink" /></label>)}
      <p className="text-xs leading-relaxed text-ink-mute">등록된 발행처를 선택하거나 신규 정보를 입력하세요. 기존 사업자 정보와 다르면 확인 후 발행합니다.</p>
      <button type="button" disabled={busy || !tradeId} onClick={() => void prepare()} className="tap w-full rounded-lg bg-ink px-3 py-2 text-sm font-bold text-white disabled:opacity-40">{busy ? '확인 중…' : '이 정보로 발행 준비'}</button>
    </div>}
    <div className="mt-4 flex flex-wrap gap-2">
      {row.status === 'issued' && !['resolved', 'dismissed'].includes(row.workState) && <button type="button" disabled={busy || disabled} onClick={() => void run(async () => {
        const response = await authFetch('/api/follow-ups', { method: 'PATCH', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: row.id, expectedVersion: row.version, action: { type: 'complete' } }) });
        const data = await response.json(); if (!response.ok || !data.ok) throw new Error(data.error || '업무 완료 반영 실패');
        onUpdate({ ...row, version: data.item.version, workState: 'resolved' }, `${row.customerLabel} 계산서 요청을 완료로 반영했습니다.`);
      })} className="tap flex-1 rounded-xl bg-checkin-bg px-3 py-3 text-sm font-bold text-checkin-fg">업무 완료 반영</button>}
      {row.status !== 'issued' && <button type="button" disabled={busy || disabled || editing || !row.canIssue} onClick={() => void issue()} className="tap flex-1 rounded-xl bg-brand-600 px-3 py-3 text-sm font-extrabold text-white disabled:bg-line/70 disabled:text-ink-faint">
        {busy ? '처리 중…' : row.complexReason ? '합산·정정 확인 필요' : editing ? '수정한 정보를 먼저 적용해주세요' : row.canIssue ? '세금계산서 발행' : '발행 정보 확인 필요'}</button>}
      {row.status !== 'issued' && !['resolved', 'dismissed'].includes(row.workState) && <button type="button" disabled={busy || disabled} onClick={() => { if (!editing) editVersion.current = row.version; setEditing(v => !v); }} className="tap rounded-xl border border-line px-3 py-3 text-sm font-bold text-ink-soft">{editing ? '접기' : item ? '정보 수정' : '거래 연결'}</button>}
      {row.conversationUrl && <a href={row.conversationUrl} target="_blank" rel="noreferrer" className="tap rounded-xl border border-line px-3 py-3 text-sm font-bold text-ink-soft">고객 대화</a>}
    </div>
  </article>;
}
