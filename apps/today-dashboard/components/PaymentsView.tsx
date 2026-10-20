"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { authFetch } from "@/lib/data/authFetch";
import { ViewHeader } from "@/components/ViewHeader";
import { Refresh, Search } from "@/components/icons";
import { isCancelledReceipt, suggestedAllocation, validateAllocationDraft, validateOpeningBalance, allocationBalanceError, type Allocation, type AllocationDraft } from "@/lib/paymentAllocationForm";

type Receipt = {
  id: string; source: string; sourceId: string; amount: number; allocatedAmount: number;
  unallocatedAmount: number; occurredAt: string; payerName: string; status: string;
  revision: number; reviewReason?: string; allocations: Allocation[]; candidates: string[];
};
type Trade = { tradeId: string; customerName: string; billedAmount: number | null; paidAmount: number; balance: number | null; credit: number | null; status: string; revision: number; openingPaid: number; reviewRequired: boolean };
type Workspace = { receipts: Receipt[]; trades: Trade[]; counts: { unmatched: number; partial: number; credit: number }; syncWarnings: string[] };
type Filter = "unmatched" | "partial" | "all";
const money = (amount: number | null | undefined) => amount == null ? "금액 확인 필요" : `${amount.toLocaleString("ko-KR")}원`;
const field = "w-full rounded-lg border border-line bg-white px-3 py-2.5 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100 disabled:bg-paper";
function reasonLabel(reason: string) {
  const labels: Record<string, string> = {
    ambiguous_approval_identity: "같은 승인 번호의 결제 원본이 여러 개입니다. 중복 여부 확인이 필요합니다.",
    no_match: "연결할 예약을 찾지 못했습니다.",
    multiple_matches: "연결 후보가 여러 개입니다. 예약을 확인해 주세요.",
    amount_mismatch: "예약 금액과 수납 금액이 다릅니다.",
  };
  return labels[reason] || (/^[A-Za-z0-9_:-]+$/.test(reason) ? "수납 원본 확인이 필요합니다." : reason);
}
const button = "rounded-lg border border-line bg-white px-3 py-2 text-xs font-bold disabled:opacity-40";
function when(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Seoul" });
}
function sourceLabel(source: string) {
  return /toss|front|card/i.test(source) ? "토스 결제" : /bank|deposit/i.test(source) ? "계좌 입금" : /legacy|opening/i.test(source) ? "기존 수납" : source;
}
function receiptLabel(receipt: Receipt) {
  return isCancelledReceipt(receipt.status) ? "취소·환불" : receipt.unallocatedAmount === 0 ? "연결 완료" : receipt.allocatedAmount > 0 ? "일부 연결" : "미매칭";
}

export function PaymentsView({ active = true }: { active?: boolean }) {
  const [data, setData] = useState<Workspace | null>(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("unmatched");
  const [selected, setSelected] = useState<Receipt | null>(null);
  const [rows, setRows] = useState<AllocationDraft[]>([]);
  const [note, setNote] = useState("");
  const [tradeSearch, setTradeSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [notice, setNotice] = useState("");
  const [savedAwaitingRefresh, setSavedAwaitingRefresh] = useState(false);
  const [opening, setOpening] = useState<Trade | null>(null);
  const [openingAmount, setOpeningAmount] = useState("");
  const [openingNote, setOpeningNote] = useState("");
  const [openingError, setOpeningError] = useState("");
  const [openingSaved, setOpeningSaved] = useState(false);
  const openingRequestRef = useRef<{ body: string; id: string } | null>(null);
  const savingRef = useRef(false);
  const loadSequence = useRef(0);
  // 동일한 입력 재시도에는 같은 요청 ID를 사용한다. 응답 유실 후 중복 배분을 막는다.
  const requestRef = useRef<{ body: string; id: string } | null>(null);
  const selectedRef = useRef<HTMLDivElement>(null);

  const select = useCallback((receipt: Receipt | null) => {
    setSelected(receipt);
    setRows((receipt?.allocations || []).map((a) => ({ tradeId: a.tradeId, amount: String(a.amount) })));
    setNote(""); setSaveError(""); setTradeSearch(""); setSavedAwaitingRefresh(false);
    requestRef.current = null;
  }, []);

  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    setLoading(true); setError("");
    try {
      const response = await authFetch(`/api/payments?search=${encodeURIComponent(search.trim())}`, { cache: "no-store" });
      const result = await response.json();
      if (!response.ok || result.success === false || !Array.isArray(result.receipts) || !Array.isArray(result.trades)) {
        throw new Error(response.status === 401 ? "로그인이 만료되었습니다. 다시 로그인해 주세요." : result.error || "수납 내역을 불러오지 못했습니다.");
      }
      if (sequence === loadSequence.current) setData(result);
      return result as Workspace;
    } catch (cause) {
      if (sequence === loadSequence.current) setError(cause instanceof Error ? cause.message : "수납 조회에 실패했습니다.");
      return null;
    } finally {
      if (sequence === loadSequence.current) setLoading(false);
    }
  }, [search]);

  useEffect(() => {
    if (!active) return;
    const timer = setTimeout(() => { if (!savingRef.current) void load(); }, 300);
    return () => clearTimeout(timer);
  }, [active, load]);

  const dirty = !!selected && (note !== "" || JSON.stringify(rows) !== JSON.stringify(selected.allocations.map((a) => ({ tradeId: a.tradeId, amount: String(a.amount) }))));
  useEffect(() => {
    if ((!dirty || savedAwaitingRefresh) && (!opening || openingSaved)) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, savedAwaitingRefresh, opening, openingSaved]);

  const tradeMap = useMemo(() => new Map((data?.trades || []).map((trade) => [trade.tradeId, trade])), [data]);
  const visibleTrades = useMemo(() => {
    const query = search.trim().toLowerCase();
    return (data?.trades || []).filter((trade) => !query || `${trade.tradeId} ${trade.customerName}`.toLowerCase().includes(query))
      .sort((a, b) => b.tradeId.localeCompare(a.tradeId));
  }, [data, search]);
  const validation = validateAllocationDraft(selected?.amount || 0, rows, selected?.allocations || [], note);
  const allocationError = validation.error || allocationBalanceError(validation.allocations, selected?.allocations || [], data?.trades || []) || (selected?.reviewReason ? "결제 원본 확인이 필요한 수납입니다. 확인이 끝난 뒤 연결할 수 있습니다." : "");
  const draftTotal = rows.reduce((sum, row) => sum + (/^\d+$/.test(row.amount) ? Number(row.amount) : 0), 0);
  const remaining = (selected?.amount || 0) - draftTotal;
  const latest = data?.receipts.find((receipt) => receipt.id === selected?.id);
  const stale = !!selected && !!latest && latest.revision !== selected.revision;
  const cancelled = !!selected && (isCancelledReceipt(selected.status) || (!!latest && isCancelledReceipt(latest.status)));
  const receipts = (data?.receipts || []).filter((receipt) => filter === "all" || (!isCancelledReceipt(receipt.status) && receipt.unallocatedAmount > 0 && (filter === "partial" ? receipt.allocatedAmount > 0 : receipt.allocatedAmount === 0)));
  const suggestions = (data?.trades || []).filter((trade) => {
    if (rows.some((row) => row.tradeId === trade.tradeId) || /취소|cancel/i.test(trade.status)) return false;
    const query = tradeSearch.trim().toLowerCase();
    return query ? `${trade.tradeId} ${trade.customerName}`.toLowerCase().includes(query) : selected?.candidates.includes(trade.tradeId) || (trade.balance ?? 0) > 0;
  }).sort((a, b) => Number(selected?.candidates.includes(b.tradeId)) - Number(selected?.candidates.includes(a.tradeId)) || b.tradeId.localeCompare(a.tradeId)).slice(0, 30);

  async function save() {
    if (!selected || savingRef.current || allocationError || cancelled || stale || savedAwaitingRefresh || !dirty) return;
    savingRef.current = true; setSaving(true); setSaveError(""); setNotice("");
    ++loadSequence.current; setLoading(false);
    const body = JSON.stringify({ action: "allocate", receiptId: selected.id, allocations: validation.allocations, expectedRevision: selected.revision, note: note.trim() });
    if (requestRef.current?.body !== body) requestRef.current = { body, id: crypto.randomUUID() };
    try {
      const response = await authFetch("/api/payments", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...JSON.parse(body), requestId: requestRef.current.id }) });
      const result = await response.json();
      if (!response.ok || result.success === false) throw new Error(response.status === 409 ? "다른 작업에서 수납이 변경되었습니다. 입력은 보존했습니다. 최신 내역을 불러온 뒤 배분을 다시 확인해 주세요." : result.error || "배분을 저장하지 못했습니다.");
      setSavedAwaitingRefresh(true);
      const fresh = Array.isArray(result.receipts) && Array.isArray(result.trades) ? result as Workspace : await load();
      if (fresh) { setData(fresh); select(fresh.receipts.find((r) => r.id === selected.id) || null); }
      setNotice(fresh ? "배분을 저장했습니다. 예약별 수납액과 잔액에 반영되었습니다." : "배분은 저장되었습니다. 최신 내역 조회에 실패해 새로고침이 필요합니다.");
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : "저장에 실패했습니다. 입력 내용은 보존했습니다.");
    } finally { savingRef.current = false; setSaving(false); }
  }

  async function reloadSelected() {
    const fresh = await load();
    if (fresh && selected) select(fresh.receipts.find((r) => r.id === selected.id) || null);
  }


  function editOpening(trade: Trade) {
    setOpening(trade); setOpeningAmount(String(trade.openingPaid)); setOpeningNote(""); setOpeningError(""); setOpeningSaved(false); openingRequestRef.current = null;
  }

  async function saveOpening() {
    if (!opening || savingRef.current || openingSaved) return;
    const checked = validateOpeningBalance(openingAmount, openingNote, opening.revision);
    if (checked.error) { setOpeningError(checked.error); return; }
    savingRef.current = true; setSaving(true); setOpeningError(""); setNotice("");
    ++loadSequence.current; setLoading(false);
    const body = JSON.stringify({ action: "openingBalance", tradeId: opening.tradeId, openingPaid: checked.amount, expectedRevision: opening.revision, note: openingNote.trim() });
    if (openingRequestRef.current?.body !== body) openingRequestRef.current = { body, id: crypto.randomUUID() };
    try {
      const response = await authFetch("/api/payments", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...JSON.parse(body), requestId: openingRequestRef.current.id }) });
      const result = await response.json();
      if (!response.ok || result.success === false) throw new Error(response.status === 409 ? "OPENING_CONFLICT" : result.error || "기존 수납 기준을 저장하지 못했습니다.");
      setOpeningSaved(true);
      const fresh = Array.isArray(result.receipts) && Array.isArray(result.trades) ? result as Workspace : await load();
      if (fresh) { setData(fresh); setOpening(null); }
      setNotice(fresh ? "기존 수납 기준을 저장하고 잔액을 다시 계산했습니다." : "기준은 저장되었습니다. 최신 내역은 새로고침 후 확인해 주세요.");
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "기준 저장에 실패했습니다.";
      setOpeningError(message === "OPENING_CONFLICT" ? "예약이 변경되었습니다. 입력은 보존했습니다. 최신 기준을 불러와 다시 확인해 주세요." : message);
    } finally { savingRef.current = false; setSaving(false); }
  }

  return (
    <div className="min-h-screen bg-paper text-ink">
      <header className="safe-top sticky top-0 z-30 border-b border-line/70 bg-paper/95 backdrop-blur">
        <ViewHeader title="수납 관리">
          <button className={button} disabled={loading || saving} onClick={() => void load()}><Refresh className={`mr-1 inline h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />새로고침</button>
        </ViewHeader>
        <div className="px-4 pb-4"><h1 className="text-xl font-black">수납 관리</h1><p className="mt-1 text-xs leading-5 text-ink-mute">입금·결제 내역을 예약에 연결하고 남은 금액을 확인하세요.</p></div>
      </header>
      <div className="space-y-4 p-3 pb-28 sm:p-5 sm:pb-28">
        {error && <div role="alert" className="rounded-xl bg-attention-bg p-3 text-sm text-attention-fg">{error} <button className="ml-2 underline" onClick={() => void load()}>다시 시도</button></div>}
        {notice && <div role="status" className="rounded-xl border border-brand-100 bg-brand-50 p-3 text-sm text-brand-700">{notice}</div>}
        {!!data?.syncWarnings?.length && <div role="alert" className="rounded-xl bg-attention-bg p-3 text-sm text-attention-fg"><p className="font-bold">동기화 확인 필요</p><ul className="mt-1 list-inside list-disc">{data.syncWarnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></div>}
        <div className="grid grid-cols-3 gap-2">
          {[{ label: "미매칭", value: data?.counts.unmatched }, { label: "일부 연결", value: data?.counts.partial }, { label: "초과 수납 예약", value: data?.counts.credit }].map((item) => <div key={item.label} className="rounded-xl border border-line/70 bg-white p-3"><p className="text-[11px] font-bold text-ink-mute">{item.label}</p><p className="mt-1 text-2xl font-black tabular-nums">{item.value ?? "—"}<span className="ml-1 text-xs font-medium text-ink-faint">건</span></p></div>)}
        </div>
        <label className="relative block"><Search className="absolute left-3 top-3 h-4 w-4 text-ink-faint" /><span className="sr-only">입금자명 또는 거래번호 검색</span><input className={`${field} pl-9`} value={search} disabled={saving} onChange={(event) => setSearch(event.target.value)} placeholder="입금자명 · 고객명 · 거래번호 검색" /></label>
        <div className="flex items-center gap-1 rounded-xl bg-line/30 p-1" role="group" aria-label="수납 상태 필터">
          {([['unmatched', '미매칭'], ['partial', '일부 연결'], ['all', '전체']] as [Filter, string][]).map(([key, label]) => <button key={key} aria-pressed={filter === key} onClick={() => setFilter(key)} className={`flex-1 rounded-lg px-3 py-2 text-sm font-bold ${filter === key ? "bg-white text-brand-700 shadow-sm" : "text-ink-mute"}`}>{label}</button>)}
        </div>
        <div className="grid items-start gap-4 xl:grid-cols-[minmax(220px,0.85fr)_minmax(320px,1.15fr)]">
          <section aria-label="수납 목록" className="space-y-2">
            <div className="flex items-center justify-between px-1 text-xs text-ink-mute"><span>{receipts.length}건 표시</span><span>{loading ? "조회 중…" : "수납 원본 기준"}</span></div>
            {!data && !error && <p className="py-12 text-center text-sm text-ink-faint">수납 내역을 불러오는 중…</p>}
            {data && receipts.length === 0 && <div className="rounded-xl border border-dashed border-line p-8 text-center text-sm text-ink-mute">{search ? "검색 결과가 없습니다." : filter === "unmatched" ? "미매칭 수납이 없습니다." : "해당 수납이 없습니다."}</div>}
            {receipts.map((receipt) => <button key={receipt.id} disabled={saving || (dirty && selected?.id !== receipt.id && !savedAwaitingRefresh)} onClick={() => { if (selected?.id === receipt.id) return; select(receipt); setNotice(""); setTimeout(() => selectedRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }), 0); }} className={`w-full rounded-xl border p-3.5 text-left transition disabled:opacity-50 ${selected?.id === receipt.id ? "border-brand-500 bg-brand-50 ring-1 ring-brand-500" : "border-line/70 bg-white hover:border-brand-300"}`}>
              <div className="flex items-start justify-between gap-2"><span className="font-bold">{receipt.payerName || "입금자명 없음"}</span><span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold ${receipt.unallocatedAmount > 0 ? "bg-attention-bg text-attention-fg" : "bg-paper text-ink-mute"}`}>{receiptLabel(receipt)}</span></div>
              <p className="mt-2 text-lg font-black tabular-nums">{money(receipt.amount)}</p><p className="mt-1 text-xs text-ink-mute">{sourceLabel(receipt.source)} · {when(receipt.occurredAt)}</p>
              <div className="mt-3 flex justify-between border-t border-line/60 pt-2 text-xs"><span className="text-ink-mute">미배분</span><span className="font-bold tabular-nums">{money(receipt.unallocatedAmount)}</span></div>
              {receipt.reviewReason && <p className="mt-2 break-words text-xs text-attention-fg">{reasonLabel(receipt.reviewReason)}</p>}
            </button>)}
          </section>
          <section ref={selectedRef} aria-label="수납 배분" className="scroll-mt-36 rounded-xl border border-line/70 bg-white p-4">
            {!selected ? <div className="py-12 text-center"><h2 className="font-bold">수납 내역을 선택하세요</h2><p className="mt-2 text-sm leading-6 text-ink-mute">한 번의 입금을 여러 예약에 나누거나,<br />예약 금액의 일부만 연결할 수 있습니다.</p></div> : <>
              <div className="flex items-start justify-between gap-3"><div><h2 className="font-black">{selected.payerName || "입금자명 없음"} 수납 배분</h2><p className="mt-1 text-xs text-ink-mute">{sourceLabel(selected.source)} · {when(selected.occurredAt)}</p></div><button disabled={saving} className="text-xs font-bold text-ink-mute underline" onClick={() => select(null)}>{dirty ? "편집 취소" : "닫기"}</button></div>
              <p className="mt-2 break-all text-[10px] text-ink-faint">원본 번호 {selected.sourceId || selected.id}</p>
              {selected.reviewReason && <p role="alert" className="mt-3 rounded-lg bg-attention-bg p-3 text-sm text-attention-fg">{reasonLabel(selected.reviewReason)}</p>}
              {cancelled && <p role="alert" className="mt-3 rounded-lg bg-attention-bg p-3 text-sm text-attention-fg">취소·환불 수납은 연결할 수 없습니다.</p>}
              {stale && <p role="alert" className="mt-3 rounded-lg bg-attention-bg p-3 text-sm text-attention-fg">수납 내역이 변경되었습니다. 최신 내역을 불러와 다시 확인해 주세요.</p>}
              <div className="my-4 grid grid-cols-2 gap-3 rounded-lg bg-paper p-3"><div><p className="text-xs text-ink-mute">수납 금액</p><p className="mt-1 font-black tabular-nums">{money(selected.amount)}</p></div><div><p className="text-xs text-ink-mute">배분 후 남는 금액</p><p className={`mt-1 font-black tabular-nums ${remaining < 0 ? "text-attention-fg" : "text-brand-700"}`}>{money(remaining)}</p></div></div>
              <fieldset disabled={saving || cancelled || savedAwaitingRefresh} className="min-w-0 space-y-3">
                <legend className="mb-2 text-sm font-bold">연결할 예약</legend>
                {!rows.length && <p className="rounded-lg border border-dashed border-line p-3 text-xs text-ink-mute">아래에서 예약을 찾아 추가하세요.</p>}
                {rows.map((row, index) => {
                  const trade = tradeMap.get(row.tradeId);
                  const previous = selected.allocations.find((a) => a.tradeId === row.tradeId)?.amount || 0;
                  const after = trade && trade.billedAmount !== null ? trade.billedAmount - trade.paidAmount + previous - (Number(row.amount) || 0) : null;
                  return <div key={row.tradeId} className="rounded-lg border border-line p-3"><div className="flex justify-between gap-2"><div><p className="text-sm font-bold">{trade?.customerName || row.tradeId}</p><p className="mt-0.5 text-[11px] text-ink-faint">{row.tradeId}</p></div><button type="button" className="self-start text-xs text-ink-mute underline" onClick={() => setRows((current) => current.filter((_, i) => i !== index))}>연결 해제</button></div>
                    {trade ? <p className="my-2 text-[11px] leading-5 text-ink-mute">청구 {money(trade.billedAmount)} · 수납 {money(trade.paidAmount)}<br />현재 잔액 {money(trade.balance)}{(trade.credit ?? 0) > 0 ? ` · 초과 수납 ${money(trade.credit)}` : ""}</p> : <p className="my-2 text-xs text-attention-fg">예약 잔액을 확인하려면 검색을 비우고 새로고침하세요.</p>}
                    <label className="block text-xs font-bold">배분 금액 (원)<input className={`${field} mt-1 text-right tabular-nums`} inputMode="numeric" pattern="[0-9]*" value={row.amount} onChange={(event) => setRows((current) => current.map((value, i) => i === index ? { ...value, amount: event.target.value } : value))} /></label>
                    {after !== null && <p className={`mt-2 text-right text-xs font-bold ${after < 0 ? "text-attention-fg" : "text-ink-mute"}`}>{after < 0 ? `배분 후 초과 수납 ${money(-after)}` : `배분 후 잔액 ${money(after)}`}</p>}
                  </div>;
                })}
                <label className="block text-xs font-bold">예약 찾기<input className={`${field} mt-1`} value={tradeSearch} onChange={(event) => setTradeSearch(event.target.value)} placeholder="고객명 또는 거래번호" /></label>
                <div className="max-h-60 overflow-y-auto rounded-lg border border-line/70">
                  {suggestions.length === 0 && <p className="p-3 text-xs text-ink-faint">연결 가능한 예약이 없습니다. 상단 검색을 비우고 확인해 주세요.</p>}
                  {suggestions.map((trade) => <button key={trade.tradeId} type="button" disabled={trade.reviewRequired || trade.balance === null} className="flex w-full items-center justify-between gap-2 border-b border-line/50 p-3 text-left last:border-0 hover:bg-paper disabled:opacity-50" onClick={() => { setRows((current) => [...current, { tradeId: trade.tradeId, amount: String(suggestedAllocation(remaining, trade.balance ?? 0)) }]); setTradeSearch(""); }}><span className="min-w-0"><span className="block truncate text-xs font-bold">{trade.customerName || "고객명 없음"}{selected.candidates.includes(trade.tradeId) && <span className="ml-1 text-[10px] text-brand-600">연결 후보</span>}</span><span className="text-[10px] text-ink-faint">{trade.tradeId}</span></span><span className="shrink-0 text-right text-xs"><span className="block font-bold">{money(trade.balance)}</span><span className="text-[10px] text-brand-600">{trade.reviewRequired ? "기존 수납 확인 필요" : trade.balance === null ? "청구 금액 확인 필요" : "잔액 · 추가 +"}</span></span></button>)}
                </div>
                <label className="block text-xs font-bold">메모 · 정정 사유<textarea className={`${field} mt-1 resize-y`} value={note} maxLength={1000} rows={2} onChange={(event) => setNote(event.target.value)} placeholder="예: 두 예약 합산 입금 / 잘못 연결한 예약 변경" /></label>
              </fieldset>
              <p className="mt-3 text-[11px] leading-5 text-ink-faint">배분 이력은 기록됩니다. 기존 배분을 줄이거나 해제할 때는 사유가 필요합니다. 남은 수납액은 미배분으로 유지됩니다.</p>
              {allocationError && dirty && <p className="mt-3 text-xs text-attention-fg">{allocationError}</p>}
              {saveError && <div role="alert" className="mt-3 rounded-lg bg-attention-bg p-3 text-sm text-attention-fg">{saveError}</div>}
              {(stale || saveError || savedAwaitingRefresh) && <button disabled={saving || loading} className={`${button} mt-3 w-full`} onClick={() => void reloadSelected()}>{savedAwaitingRefresh ? "저장된 내역 다시 불러오기" : "입력 초기화하고 최신 내역 불러오기"}</button>}
              <button disabled={saving || cancelled || stale || !!allocationError || !dirty || savedAwaitingRefresh} className="mt-4 w-full rounded-lg bg-brand-600 py-3 text-sm font-black text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-40" onClick={() => void save()}>{saving ? "배분 저장 중…" : `배분 ${money(validation.total)} 저장`}</button>
            </>}
          </section>
        </div>
        {!!data?.trades.length && <section className="rounded-xl border border-line/70 bg-white p-4">
          <h2 className="font-black">예약별 잔액</h2><p className="mt-1 text-xs text-ink-mute">현장 추가·제외가 반영된 청구 금액에서 실제 수납액을 뺀 금액입니다.</p>
          {opening && <div className="my-4 rounded-xl border border-brand-200 bg-brand-50 p-4">
            <div className="flex items-start justify-between gap-2"><h3 className="text-sm font-black">{opening.customerName || opening.tradeId} · 기존 수납 기준 확인/조정</h3><button disabled={saving} className="shrink-0 text-xs underline" onClick={() => setOpening(null)}>닫기</button></div>
            <p className="mt-1 text-xs text-ink-mute">{opening.tradeId} · 현재 기준 {money(opening.openingPaid)}</p>
            <p className="my-3 text-xs font-bold leading-5 text-brand-700">이전 수납 중 원본으로 연결되지 않은 금액만 입력하세요. 연결한 입금은 중복 입력하지 마세요.</p>
            <fieldset disabled={saving || openingSaved} className="space-y-3">
              <label className="block text-xs font-bold">기존 수납 기준 금액 (원)<input className={`${field} mt-1`} inputMode="numeric" value={openingAmount} onChange={(event) => setOpeningAmount(event.target.value)} /></label>
              <label className="block text-xs font-bold">확인 근거 · 정정 사유 (5자 이상)<textarea rows={2} maxLength={1000} className={`${field} mt-1`} value={openingNote} onChange={(event) => setOpeningNote(event.target.value)} placeholder="예: 이전 통장 입금 내역 대조 완료" /></label>
            </fieldset>
            {openingError && <p role="alert" className="mt-3 text-xs text-attention-fg">{openingError}</p>}
            {(openingError || openingSaved) && <button className={`${button} mt-3`} disabled={saving || loading} onClick={async () => { const fresh = await load(); const trade = fresh?.trades.find((value) => value.tradeId === opening.tradeId); if (trade) editOpening(trade); }}>입력 초기화하고 최신 기준 불러오기</button>}
            <button disabled={saving || openingSaved || !!validateOpeningBalance(openingAmount, openingNote, opening.revision).error} className="mt-3 w-full rounded-lg bg-brand-600 py-2.5 text-sm font-bold text-white disabled:opacity-40" onClick={() => void saveOpening()}>{saving ? "저장 중…" : "근거와 함께 기준 저장"}</button>
          </div>}
          <div className="mt-3 max-h-80 overflow-auto"><table className="w-full min-w-[520px] text-xs"><thead className="sticky top-0 bg-white text-ink-mute"><tr><th className="py-2 text-left">예약</th><th className="text-right">청구</th><th className="text-right">수납</th><th className="text-right">잔액 / 초과</th></tr></thead><tbody>
            {visibleTrades.map((trade) => <tr key={trade.tradeId} className="border-t border-line/60"><td className="py-3 font-bold">{trade.customerName}<span className="mt-0.5 block text-[10px] font-normal text-ink-faint">{trade.tradeId}</span>{trade.reviewRequired && <span className="mt-1 block text-[10px] text-attention-fg">기존 수납 확인 필요</span>}<button disabled={saving || !!opening} onClick={() => editOpening(trade)} className="mt-1 block text-[10px] font-normal text-brand-600 underline disabled:opacity-40">기존 수납 기준 확인/조정</button></td><td className="text-right tabular-nums">{money(trade.billedAmount)}</td><td className="text-right tabular-nums">{money(trade.paidAmount)}</td><td className={`text-right font-bold tabular-nums ${(trade.credit ?? 0) > 0 ? "text-attention-fg" : "text-brand-700"}`}>{(trade.credit ?? 0) > 0 ? `초과 ${money(trade.credit)}` : money(trade.balance)}</td></tr>)}
          </tbody></table></div>
        </section>}
      </div>
    </div>
  );
}
