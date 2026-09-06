"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { authFetch } from "@/lib/data/authFetch";
import { AUDIT_FILTERS, buildAutomationAuditQuery, buildAutomationAuditView } from "@/lib/automation-audit/inbox-model.mjs";

type RangeKey = "today" | "7d" | "custom";
type AuditFilter = {
  range: RangeKey;
  customFrom?: string;
  customTo?: string;
  effect: string;
  outcome: string;
  search: string;
  limit: number;
};
type ChangeItem = { field: string; before: string | null; after: string | null };
type AuditRow = {
  eventKey: string;
  occurredLabel: string;
  effectLabel: string;
  actionLabel: string;
  outcome: string;
  outcomeLabel: string;
  outcomeIcon: string;
  customerLabel: string;
  summary: string;
  ownerLine: string;
  targetId: string | null;
  outboundText: string | null;
  changeItems: ChangeItem[];
  changeLines: string[];
  evidence: { status: string; error_type?: string; attempted_stage?: string };
  historicalImport: boolean;
};
type AuditPayload = {
  ok: true;
  source: "kakao_automation_audit_events";
  items: unknown[];
  nextCursor: string | null;
  sync: { delayed: boolean };
};
type AuditModel = {
  rows: AuditRow[];
  selected: AuditRow | null;
  nextCursor: string | null;
  syncDelayed: boolean;
  emptyLabel: string;
};
type Snapshot = { filterKey: string; payload: AuditPayload; model: AuditModel };
const createAuditQuery = buildAutomationAuditQuery as (value: AuditFilter & { after?: string | null }) => string;
const createAuditView = buildAutomationAuditView as (value: {
  payload: AuditPayload;
  selectedEventKey: string | null;
  range: RangeKey;
}) => AuditModel;
const AUDIT_FILTER_OPTIONS = AUDIT_FILTERS as {
  ranges: readonly { value: RangeKey; label: string }[];
  effects: readonly { value: string; label: string }[];
  outcomes: readonly { value: string; label: string }[];
};

function kstToday() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function filterKey(filter: AuditFilter) {
  return JSON.stringify(filter);
}

function outcomeTone(outcome: string) {
  if (outcome === "success") return "bg-checkin-bg text-checkin-fg ring-checkin-ring";
  if (outcome === "partial_success") return "bg-warn-bg text-warn-fg ring-warn-ring";
  if (outcome === "failed" || outcome === "blocked") return "bg-attention-bg text-attention-fg ring-attention-ring";
  return "bg-paper text-ink-mute ring-line";
}

export function AutomationAuditView({ active, refreshVersion = 0 }: { active: boolean; refreshVersion?: number }) {
  const today = useMemo(kstToday, []);
  const [filter, setFilter] = useState<AuditFilter>({
    range: "today", effect: "", outcome: "", search: "", limit: 50,
  });
  const [searchDraft, setSearchDraft] = useState("");
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const snapshotRef = useRef<Snapshot | null>(null);
  const [selectedEventKey, setSelectedEventKey] = useState<string | null>(null);
  const selectedRef = useRef<string | null>(null);
  const requestIdRef = useRef(0);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false);

  const load = useCallback(async (
    current: AuditFilter,
    { after = null, append = false }: { after?: string | null; append?: boolean } = {},
  ) => {
    const requestId = ++requestIdRef.current;
    if (append) setLoadingMore(true);
    else setLoading(true);
    try {
      const params = createAuditQuery({ ...current, after });
      const response = await authFetch(`/api/automation-audit?${params}`);
      const incoming = await response.json().catch(() => null) as AuditPayload | null;
      if (!response.ok || !incoming) throw new Error("read failed");
      let payload = incoming;
      const currentKey = filterKey(current);
      const previous = snapshotRef.current;
      if (append && previous?.filterKey === currentKey) {
        const mergedItems = [...previous.payload.items, ...incoming.items].slice(0, 500);
        payload = {
          ...incoming,
          items: mergedItems,
          nextCursor: mergedItems.length >= 500 ? null : incoming.nextCursor,
        };
      }
      const model = createAuditView({ payload, selectedEventKey: selectedRef.current, range: current.range });
      if (requestId !== requestIdRef.current) return;
      const nextSelected = model.selected?.eventKey || null;
      selectedRef.current = nextSelected;
      setSelectedEventKey(nextSelected);
      const nextSnapshot = { filterKey: currentKey, payload, model };
      snapshotRef.current = nextSnapshot;
      setSnapshot(nextSnapshot);
      setUnavailable(false);
    } catch {
      if (requestId !== requestIdRef.current) return;
      setUnavailable(true);
    } finally {
      if (requestId === requestIdRef.current) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    void load(filter);
    const tick = () => {
      if (typeof document !== "undefined" && document.hidden) return;
      void load(filter);
    };
    const timer = setInterval(tick, 30_000);
    const onVisible = () => {
      if (typeof document !== "undefined" && !document.hidden) void load(filter);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [active, filter, load, refreshVersion]);

  useEffect(() => {
    if (!mobileDetailOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileDetailOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [mobileDetailOpen]);

  const currentKey = filterKey(filter);
  const model = snapshot?.filterKey === currentKey ? snapshot.model : null;
  const selected = model?.rows.find(({ eventKey }) => eventKey === selectedEventKey) || model?.rows[0] || null;

  const updateFilter = useCallback((next: AuditFilter) => {
    selectedRef.current = null;
    setSelectedEventKey(null);
    setMobileDetailOpen(false);
    setUnavailable(false);
    setFilter(next);
  }, []);

  const selectRow = useCallback((eventKey: string) => {
    selectedRef.current = eventKey;
    setSelectedEventKey(eventKey);
    setMobileDetailOpen(true);
  }, []);

  return (
    <main className="flex-1 p-3 pb-24 lg:p-4">
      <section aria-label="자동처리 기록 필터" className="mb-3 rounded-xl bg-white p-3 ring-1 ring-line/70">
        <div className="flex flex-wrap gap-1.5">
          {AUDIT_FILTER_OPTIONS.ranges.map(({ value, label }) => (
            <button key={value} type="button" onClick={() => updateFilter({
              ...filter,
              range: value,
              ...(value === "custom" ? { customFrom: filter.customFrom || today, customTo: filter.customTo || today } : { customFrom: undefined, customTo: undefined }),
            })} className={`tap rounded-full px-3 py-1.5 text-[12px] font-extrabold ${filter.range === value ? "bg-ink text-white" : "bg-paper text-ink-soft ring-1 ring-line"}`}>
              {label}
            </button>
          ))}
        </div>
        {filter.range === "custom" && (
          <div className="mt-2 grid grid-cols-2 gap-2">
            <label className="text-[11px] font-bold text-ink-mute">시작일<input aria-label="자동처리 시작일" type="date" value={filter.customFrom || today} onChange={(event) => updateFilter({ ...filter, customFrom: event.target.value })} className="mt-1 w-full rounded-lg bg-paper px-2.5 py-2 text-[13px] text-ink ring-1 ring-line" /></label>
            <label className="text-[11px] font-bold text-ink-mute">종료일<input aria-label="자동처리 종료일" type="date" value={filter.customTo || today} onChange={(event) => updateFilter({ ...filter, customTo: event.target.value })} className="mt-1 w-full rounded-lg bg-paper px-2.5 py-2 text-[13px] text-ink ring-1 ring-line" /></label>
          </div>
        )}
        <div className="mt-2 grid gap-2 sm:grid-cols-3">
          <label className="text-[11px] font-bold text-ink-mute">처리 종류<select value={filter.effect} onChange={(event) => updateFilter({ ...filter, effect: event.target.value })} className="mt-1 w-full rounded-lg bg-paper px-2.5 py-2 text-[13px] text-ink ring-1 ring-line">{AUDIT_FILTER_OPTIONS.effects.map(({ value, label }) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label className="text-[11px] font-bold text-ink-mute">결과<select value={filter.outcome} onChange={(event) => updateFilter({ ...filter, outcome: event.target.value })} className="mt-1 w-full rounded-lg bg-paper px-2.5 py-2 text-[13px] text-ink ring-1 ring-line">{AUDIT_FILTER_OPTIONS.outcomes.map(({ value, label }) => <option key={value} value={value}>{label}</option>)}</select></label>
          <form className="text-[11px] font-bold text-ink-mute" onSubmit={(event) => { event.preventDefault(); updateFilter({ ...filter, search: searchDraft.trim() }); }}>
            <label>고객명 또는 요청·거래번호<input value={searchDraft} maxLength={120} onChange={(event) => setSearchDraft(event.target.value)} className="mt-1 w-full rounded-lg bg-paper px-2.5 py-2 text-[13px] text-ink ring-1 ring-line" /></label>
          </form>
        </div>
      </section>

      {model?.syncDelayed && <div className="mb-3 rounded-xl bg-warn-bg px-3.5 py-2.5 text-[13px] font-semibold text-warn-fg ring-1 ring-warn-ring">기록 동기화 지연 · 자동처리 자체는 끝났지만 이 목록 반영이 재시도 중입니다.</div>}
      {unavailable && <div className="mb-3 rounded-xl bg-attention-bg px-3.5 py-2.5 text-[13px] font-semibold text-attention-fg ring-1 ring-attention-ring">자동처리 기록을 불러오지 못했습니다. {model ? "마지막으로 확인한 기록을 표시합니다." : "잠시 후 다시 확인해 주세요."}</div>}

      {model && model.rows.length > 0 ? (
        <div className="lg:grid lg:grid-cols-[minmax(320px,0.9fr)_minmax(420px,1.1fr)] lg:gap-4">
          <section aria-label="자동처리 기록 목록" className="min-w-0 space-y-2.5">
            <div className="flex items-end justify-between px-1 pb-1">
              <div><h2 className="text-[15px] font-extrabold text-ink">자동으로 반영된 내역</h2><p className="mt-0.5 text-[12px] text-ink-mute">카카오 헤르메스가 실제 반영을 확인한 기록만 표시합니다.</p></div>
              <span className="text-[12px] font-bold tabular-nums text-ink-mute">{model.rows.length}건</span>
            </div>
            {model.rows.map((row) => <AuditRowButton key={row.eventKey} row={row} selected={selected?.eventKey === row.eventKey} onSelect={() => selectRow(row.eventKey)} />)}
            {model.nextCursor && <button type="button" disabled={loadingMore} onClick={() => void load(filter, { after: model.nextCursor, append: true })} className="tap w-full rounded-xl bg-white px-3 py-3 text-[13px] font-extrabold text-brand-600 ring-1 ring-line disabled:opacity-50">{loadingMore ? "이전 기록을 불러오는 중…" : "이전 기록 더 보기"}</button>}
          </section>
          <aside className="hidden min-w-0 lg:block"><div className="lg:sticky lg:top-[188px]">{selected ? <AuditDetail row={selected} /> : null}</div></aside>
        </div>
      ) : loading && !model ? (
        <div className="rounded-xl2 bg-white py-20 text-center text-[14px] font-bold text-ink-mute ring-1 ring-line/70">기록을 불러오는 중…</div>
      ) : (
        <div className="rounded-xl2 border border-dashed border-line bg-white py-20 text-center"><div className="text-[15px] font-extrabold text-ink-soft">{model?.emptyLabel || "자동처리 기록이 없습니다"}</div><div className="mt-1.5 text-[13px] text-ink-mute">실제 반영이 확인되면 여기에 한 번만 기록됩니다.</div></div>
      )}

      {mobileDetailOpen && selected && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button type="button" aria-label="자동처리 상세 배경 닫기" onClick={() => setMobileDetailOpen(false)} className="absolute inset-0 bg-ink/35" />
          <section role="dialog" aria-modal="true" aria-label="자동처리 상세" className="absolute inset-x-0 bottom-0 max-h-[86vh] overflow-y-auto rounded-t-[24px] bg-white p-3 pb-[calc(env(safe-area-inset-bottom)+12px)] shadow-2xl ring-1 ring-line">
            <div className="mb-2 flex justify-end"><button type="button" onClick={() => setMobileDetailOpen(false)} className="tap rounded-full px-3 py-1.5 text-[13px] font-extrabold text-ink-soft ring-1 ring-line">닫기</button></div>
            <AuditDetail row={selected} />
          </section>
        </div>
      )}
    </main>
  );
}

function AuditRowButton({ row, selected, onSelect }: { row: AuditRow; selected: boolean; onSelect: () => void }) {
  return <button type="button" onClick={onSelect} className={`tap w-full rounded-xl border bg-white p-3.5 text-left shadow-sm ${selected ? "border-ink/20 ring-2 ring-ink/20" : "border-line hover:ring-2 hover:ring-line"}`}>
    <div className="flex items-start justify-between gap-3"><div className="min-w-0"><div className="flex flex-wrap gap-1.5"><span className="rounded-full bg-brand-50 px-2 py-0.5 text-[11px] font-extrabold text-brand-600">{row.effectLabel}</span><span className={`rounded-full px-2 py-0.5 text-[11px] font-extrabold ring-1 ${outcomeTone(row.outcome)}`}>{row.outcomeIcon} {row.outcomeLabel}</span></div><p className="mt-2 text-[15px] font-extrabold leading-snug text-ink">{row.ownerLine}</p></div><span className="shrink-0 text-[11.5px] font-bold text-ink-mute">{row.occurredLabel}</span></div>
    <div className="mt-2 flex flex-wrap gap-2 text-[11.5px] font-semibold text-ink-mute"><span>{row.actionLabel}</span>{row.targetId && <span>{row.targetId}</span>}{row.historicalImport && <span>과거 기록</span>}</div>
  </button>;
}

function AuditDetail({ row }: { row: AuditRow }) {
  return <article className="rounded-xl2 bg-white p-4 shadow-card ring-1 ring-line/70">
    <div className="flex flex-wrap gap-1.5"><span className="rounded-full bg-brand-50 px-2.5 py-1 text-[11.5px] font-extrabold text-brand-600">{row.effectLabel} · {row.actionLabel}</span><span className={`rounded-full px-2.5 py-1 text-[11.5px] font-extrabold ring-1 ${outcomeTone(row.outcome)}`}>{row.outcomeIcon} {row.outcomeLabel}</span></div>
    <h2 className="mt-3 text-[20px] font-extrabold leading-snug text-ink">{row.customerLabel}</h2><p className="mt-2 text-[14px] leading-relaxed text-ink-soft">{row.summary}</p>
    <Detail title="처리 시각"><p>{row.occurredLabel}{row.historicalImport ? " · 과거 기록 복구" : ""}</p></Detail>
    {row.targetId && <Detail title="대상"><p>{row.targetId}</p></Detail>}
    {row.changeLines.length > 0 && <Detail title="변경 내역"><ul className="space-y-1">{row.changeLines.map((line) => <li key={line}>{line}</li>)}</ul></Detail>}
    {row.outboundText && <Detail title="보낸 답변"><p className="whitespace-pre-wrap">{row.outboundText}</p></Detail>}
    {(row.evidence.error_type || row.evidence.attempted_stage) && <Detail title="처리 근거"><p>{row.evidence.error_type || row.evidence.attempted_stage}</p></Detail>}
  </article>;
}

function Detail({ title, children }: { title: string; children: ReactNode }) {
  return <section className="mt-4 rounded-xl bg-paper/70 p-3.5 text-[13px] font-semibold leading-relaxed text-ink-soft ring-1 ring-line/60"><h3 className="mb-1.5 text-[11px] font-extrabold tracking-wide text-ink-mute">{title}</h3>{children}</section>;
}
