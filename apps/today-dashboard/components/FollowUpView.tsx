"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { authFetch } from "@/lib/data/authFetch";
import { ViewHeader } from "@/components/ViewHeader";
import { Refresh } from "@/components/icons";
import { actionBody, buildInboxView } from "@/lib/followups/inbox-model.mjs";

type ViewKey = "now" | "snoozed" | "completed";
type CategoryKey = "schedule" | "quote" | "settlement" | "customer" | "operations";
type FilterState = { view: ViewKey; category: CategoryKey | null };
type WorkAction =
  | { type: "progress" | "ack_p0" | "request_resolve" | "dismiss" }
  | { type: "snooze"; snoozedUntil: string };
type WorkItem = {
  id: string;
  version: number;
  category: CategoryKey;
  workType: string;
  workTypeLabel: string;
  priority: "p0" | "urgent" | "normal" | "low";
  state: "open" | "in_progress" | "snoozed" | "resolved" | "dismissed";
  title: string;
  summary: string;
  recommendedAction: string;
  dueAt: string | null;
  snoozedUntil: string | null;
  firstOpenedAt: string;
  updatedAt: string;
};
type InboxPayload = {
  ok: true;
  source: "work_items_v2";
  summary: {
    now: number;
    snoozed: number;
    completed: number;
    p0: number;
    byCategory: Record<CategoryKey, number>;
  };
  items: WorkItem[];
  nextCursor: string | null;
  omittedCount: number;
};
type InboxModel = {
  tabs: { key: ViewKey; label: string; count: number }[];
  categories: { key: CategoryKey; label: string; count: number }[];
  rows: WorkItem[];
  selected: WorkItem | null;
  emptyLabel: string;
};
type Snapshot = { filterKey: string; model: InboxModel; payload: InboxPayload };

const VIEW_LABELS: Record<ViewKey, string> = {
  now: "지금 할 일",
  snoozed: "미뤄둔 일",
  completed: "완료",
};
const CATEGORY_LABELS: Record<CategoryKey, string> = {
  schedule: "예약·스케줄",
  quote: "견적·가격",
  settlement: "정산·서류",
  customer: "고객 응대",
  operations: "운영·예외",
};
const STATE_LABELS: Record<WorkItem["state"], string> = {
  open: "대기",
  in_progress: "진행 중",
  snoozed: "미뤄둠",
  resolved: "완료",
  dismissed: "업무 아님",
};
const PRIORITY_LABELS: Record<WorkItem["priority"], string> = {
  p0: "즉시 확인",
  urgent: "긴급",
  normal: "보통",
  low: "낮음",
};

function currentFilterKey(filter: FilterState) {
  return `${filter.view}:${filter.category || "all"}`;
}

function formatDateTime(value: string | null) {
  if (!value) return "기한 없음";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "기한 없음";
  return date.toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function oneHourLater() {
  return new Date(Date.now() + 60 * 60 * 1000).toISOString();
}

function rowTone(item: WorkItem) {
  if (item.priority === "p0") return "border-attention-ring bg-attention-bg/70";
  if (item.dueAt && Date.parse(item.dueAt) <= Date.now()) return "border-warn-ring bg-warn-bg/55";
  return "border-line bg-white";
}

export function FollowUpView({ active: paneActive = true }: { active?: boolean }) {
  const [status, setStatus] = useState<FilterState>({ view: "now", category: null });
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedIdRef = useRef<string | null>(null);
  const requestIdRef = useRef(0);
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [notice, setNotice] = useState("");
  const [actionBusy, setActionBusy] = useState(false);

  const load = useCallback(async (filter: FilterState) => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    const params = new URLSearchParams({ view: filter.view, limit: "200" });
    if (filter.category) params.set("category", filter.category);
    try {
      const response = await authFetch(`/api/follow-ups?${params.toString()}`);
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error("read failed");
      const model = buildInboxView({
        payload,
        view: filter.view,
        category: filter.category,
        selectedId: selectedIdRef.current,
        now: new Date().toISOString(),
      }) as InboxModel;
      if (requestId !== requestIdRef.current) return;
      setSnapshot({ filterKey: currentFilterKey(filter), model, payload: payload as InboxPayload });
      const nextSelected = model.selected?.id || null;
      selectedIdRef.current = nextSelected;
      setSelectedId(nextSelected);
      setUnavailable(false);
      setNotice("");
    } catch {
      if (requestId !== requestIdRef.current) return;
      setUnavailable(true);
      setNotice("후속조치 정보를 불러오지 못했습니다. 마지막으로 확인한 내용을 표시합니다.");
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!paneActive) return;
    load(status);
    const tick = () => {
      if (typeof document !== "undefined" && document.hidden) return;
      load(status);
    };
    const timer = setInterval(tick, 30_000);
    const onVisible = () => {
      if (typeof document !== "undefined" && !document.hidden) load(status);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [status, load, paneActive]);

  const model = snapshot?.model || null;
  const dataIsCurrent = snapshot?.filterKey === currentFilterKey(status);
  const selected = useMemo(
    () => model?.rows.find((item) => item.id === selectedId) || model?.rows[0] || null,
    [model, selectedId],
  );

  const selectRow = useCallback((id: string) => {
    selectedIdRef.current = id;
    setSelectedId(id);
    setMobileDetailOpen(true);
  }, []);

  const changeFilter = useCallback((next: FilterState) => {
    setStatus(next);
    setMobileDetailOpen(false);
    setUnavailable(false);
    setNotice("");
  }, []);

  const submitAction = useCallback(async (item: WorkItem, action: WorkAction) => {
    if (unavailable || actionBusy) return;
    setActionBusy(true);
    setNotice("");
    try {
      const response = await authFetch("/api/follow-ups", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(actionBody(item, action)),
      });
      const payload = await response.json().catch(() => null);
      if (response.status === 409) {
        await load(status);
        setNotice("다른 곳에서 이미 변경되었습니다. 최신 내용으로 다시 확인해 주세요.");
        return;
      }
      if (!response.ok || !payload?.ok || !payload.item) throw new Error("mutation failed");
      await load(status);
      setNotice("처리 요청을 접수했습니다.");
    } catch {
      setNotice("처리 요청을 반영하지 못했습니다. 잠시 후 다시 시도해 주세요.");
    } finally {
      setActionBusy(false);
    }
  }, [actionBusy, load, status, unavailable]);

  const mutationDisabled = unavailable || !dataIsCurrent || actionBusy;

  return (
    <div className="flex min-h-screen flex-col bg-paper">
      <header className="safe-top sticky top-0 z-40 border-b border-line/70 bg-paper/95 backdrop-blur-md">
        <ViewHeader title="후속조치">
          <button type="button" onClick={() => load(status)} aria-label="새로고침" className={`tap flex h-9 w-9 items-center justify-center rounded-full bg-white text-ink-soft ring-1 ring-line/70 ${loading ? "animate-spin" : ""}`}>
            <Refresh className="h-4 w-4" />
          </button>
        </ViewHeader>

        <div className="overflow-x-auto px-3 pb-2">
          <div className="flex min-w-max gap-1.5">
            {(model?.tabs || ([
              { key: "now", label: "지금 할 일", count: 0 },
              { key: "snoozed", label: "미뤄둔 일", count: 0 },
              { key: "completed", label: "완료", count: 0 },
            ] as InboxModel["tabs"])).map((tab) => (
              <button type="button" key={tab.key} onClick={() => changeFilter({ view: tab.key, category: status.category })} className={`tap rounded-full px-3 py-2 text-[13px] font-extrabold ${status.view === tab.key ? "bg-ink text-white" : "bg-white text-ink-soft ring-1 ring-line/70"}`}>
                {tab.label} <span className="ml-1 tabular-nums opacity-70">{tab.count}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="overflow-x-auto border-t border-line/50 px-3 py-2">
          <div className="flex min-w-max gap-1.5">
            <CategoryButton active={status.category === null} label="전체" onClick={() => changeFilter({ ...status, category: null })} />
            {(model?.categories || (Object.entries(CATEGORY_LABELS).map(([key, label]) => ({ key, label, count: 0 })) as InboxModel["categories"])).map((category) => (
              <CategoryButton key={category.key} active={status.category === category.key} label={category.label} count={category.count} onClick={() => changeFilter({ ...status, category: category.key })} />
            ))}
          </div>
        </div>
      </header>

      <main className="flex-1 p-3 pb-24 lg:p-4">
        {notice && (
          <div className={`mb-3 rounded-xl px-3.5 py-2.5 text-[13px] font-semibold ring-1 ${unavailable ? "bg-attention-bg text-attention-fg ring-attention-ring" : "bg-checkin-bg text-checkin-fg ring-checkin-ring"}`}>
            {notice}
          </div>
        )}

        {model && model.rows.length > 0 ? (
          <div className="lg:grid lg:grid-cols-[minmax(320px,0.9fr)_minmax(420px,1.1fr)] lg:gap-4">
            <section aria-label={`${VIEW_LABELS[status.view]} 목록`} className="min-w-0 space-y-2">
              <div className="flex items-end justify-between px-1 pb-1">
                <div>
                  <h2 className="text-[15px] font-extrabold text-ink">{VIEW_LABELS[status.view]}</h2>
                  <p className="mt-0.5 text-[12px] text-ink-mute">중요한 순서대로 정리했습니다.</p>
                </div>
                <span className="text-[12px] font-bold tabular-nums text-ink-mute">{model.rows.length}건</span>
              </div>
              {model.rows.map((item) => <WorkRow key={item.id} item={item} selected={selected?.id === item.id} onSelect={() => selectRow(item.id)} />)}
              {(snapshot?.payload.omittedCount ?? 0) > 0 && (
                <div className="rounded-xl border border-line bg-white px-3 py-2 text-center text-[12px] font-semibold text-ink-mute">
                  목록이 더 있습니다. 처리하면 다음 업무가 이어서 표시됩니다.
                </div>
              )}
            </section>

            <aside className="hidden min-w-0 lg:block">
              <div className="lg:sticky lg:top-[188px]">{selected ? <WorkDetail item={selected} disabled={mutationDisabled} busy={actionBusy} onAction={submitAction} /> : <EmptyDetail />}</div>
            </aside>
          </div>
        ) : loading && !model ? (
          <div className="rounded-xl2 bg-white py-20 text-center text-[14px] font-bold text-ink-mute ring-1 ring-line/70">업무를 정리하고 있습니다…</div>
        ) : (
          <div className="rounded-xl2 border border-dashed border-line bg-white py-20 text-center">
            <div className="text-[15px] font-extrabold text-ink-soft">{model?.emptyLabel || "후속조치 정보를 불러오지 못했습니다"}</div>
            <div className="mt-1.5 text-[13px] text-ink-mute">{model ? "필요한 업무가 생기면 여기에 표시됩니다." : "잠시 후 새로고침해 주세요."}</div>
          </div>
        )}
      </main>

      {mobileDetailOpen && selected && (
        <section className="fixed inset-x-0 bottom-0 z-50 max-h-[86vh] overflow-y-auto rounded-t-[24px] bg-white p-3 pb-[calc(env(safe-area-inset-bottom)+12px)] shadow-2xl ring-1 ring-line lg:hidden">
          <div className="sticky top-0 z-10 mb-2 flex justify-center bg-white pb-2">
            <button type="button" onClick={() => setMobileDetailOpen(false)} aria-label="상세 닫기" className="h-1.5 w-12 rounded-full bg-line" />
          </div>
          <WorkDetail item={selected} disabled={mutationDisabled} busy={actionBusy} onAction={submitAction} />
        </section>
      )}
    </div>
  );
}

function CategoryButton({ active, label, count, onClick }: { active: boolean; label: string; count?: number; onClick: () => void }) {
  return <button type="button" onClick={onClick} className={`tap rounded-lg px-2.5 py-1.5 text-[12px] font-bold ${active ? "bg-brand-600 text-white" : "bg-white text-ink-soft ring-1 ring-line/70"}`}>{label}{count === undefined ? "" : ` ${count}`}</button>;
}

function WorkRow({ item, selected, onSelect }: { item: WorkItem; selected: boolean; onSelect: () => void }) {
  const overdue = item.dueAt !== null && Date.parse(item.dueAt) <= Date.now();
  return (
    <button type="button" onClick={onSelect} className={`tap w-full rounded-xl border p-3 text-left shadow-sm transition ${rowTone(item)} ${selected ? "ring-2 ring-ink/25" : "hover:ring-2 hover:ring-line"}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex flex-wrap items-center gap-1.5">
            <span className={`rounded-full px-2 py-0.5 text-[11px] font-extrabold ${item.priority === "p0" ? "bg-attention-fg text-white" : item.priority === "urgent" ? "bg-warn-bg text-warn-fg" : "bg-paper text-ink-mute"}`}>{PRIORITY_LABELS[item.priority]}</span>
            {overdue && item.priority !== "p0" && <span className="rounded-full bg-attention-bg px-2 py-0.5 text-[11px] font-extrabold text-attention-fg">기한 지남</span>}
            <span className="rounded-full bg-white/80 px-2 py-0.5 text-[11px] font-bold text-ink-mute ring-1 ring-line/60">{item.workTypeLabel}</span>
          </div>
          <h3 className="line-clamp-2 text-[15px] font-extrabold leading-snug text-ink [word-break:keep-all]">{item.title}</h3>
          {item.summary && <p className="mt-1.5 line-clamp-2 text-[13px] leading-relaxed text-ink-soft">{item.summary}</p>}
        </div>
        <span className="shrink-0 text-[12px] font-bold text-ink-mute">{STATE_LABELS[item.state]}</span>
      </div>
      <div className="mt-2 flex items-center justify-between gap-2 text-[11.5px] font-semibold text-ink-mute">
        <span>{CATEGORY_LABELS[item.category]}</span>
        <span>{item.dueAt ? `기한 ${formatDateTime(item.dueAt)}` : "기한 없음"}</span>
      </div>
    </button>
  );
}

function WorkDetail({ item, disabled, busy, onAction }: { item: WorkItem; disabled: boolean; busy: boolean; onAction: (item: WorkItem, action: WorkAction) => Promise<void> }) {
  const completed = item.state === "resolved" || item.state === "dismissed";
  return (
    <article className="rounded-xl2 bg-white p-4 shadow-card ring-1 ring-line/70">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className={`rounded-full px-2.5 py-1 text-[11.5px] font-extrabold ${item.priority === "p0" ? "bg-attention-fg text-white" : "bg-paper text-ink-soft"}`}>{PRIORITY_LABELS[item.priority]}</span>
        <span className="rounded-full bg-brand-50 px-2.5 py-1 text-[11.5px] font-extrabold text-brand-600">{CATEGORY_LABELS[item.category]}</span>
        <span className="rounded-full bg-paper px-2.5 py-1 text-[11.5px] font-bold text-ink-mute">{item.workTypeLabel}</span>
      </div>
      <h2 className="mt-3 text-[20px] font-extrabold leading-snug text-ink [word-break:keep-all]">{item.title}</h2>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[12px] font-semibold text-ink-mute">
        <span>상태 {STATE_LABELS[item.state]}</span>
        <span>{item.dueAt ? `기한 ${formatDateTime(item.dueAt)}` : "기한 없음"}</span>
      </div>
      <DetailSection title="직원이 정리한 내용"><p className="whitespace-pre-wrap text-[14px] leading-relaxed text-ink-soft">{item.summary || "추가 요약이 없습니다."}</p></DetailSection>
      <DetailSection title="권장 처리"><p className="whitespace-pre-wrap text-[14px] font-semibold leading-relaxed text-ink">{item.recommendedAction || "내용을 확인한 뒤 처리해 주세요."}</p></DetailSection>

      {!completed && (
        <div className="mt-4 grid grid-cols-2 gap-2">
          {item.state !== "in_progress" && <ActionButton primary disabled={disabled} onClick={() => onAction(item, { type: "progress" })}>진행 시작</ActionButton>}
          <ActionButton disabled={disabled} onClick={() => onAction(item, { type: "snooze", snoozedUntil: oneHourLater() })}>1시간 미루기</ActionButton>
          {item.priority === "p0" && <ActionButton disabled={disabled} onClick={() => onAction(item, { type: "ack_p0" })}>P0 확인했어요</ActionButton>}
          <ActionButton primary disabled={disabled} onClick={() => onAction(item, { type: "request_resolve" })}>완료 확인 요청</ActionButton>
          <ActionButton disabled={disabled} onClick={() => onAction(item, { type: "dismiss" })}>업무 아님</ActionButton>
        </div>
      )}
      {busy && <p className="mt-3 text-center text-[12px] font-semibold text-ink-mute">처리 요청 중…</p>}
      {disabled && !busy && !completed && <p className="mt-3 text-center text-[12px] font-semibold text-attention-fg">최신 목록을 확인한 뒤 처리할 수 있습니다.</p>}
    </article>
  );
}

function DetailSection({ title, children }: { title: string; children: ReactNode }) {
  return <section className="mt-4 rounded-xl bg-paper/70 p-3.5 ring-1 ring-line/60"><h3 className="mb-1.5 text-[11px] font-extrabold tracking-wide text-ink-mute">{title}</h3>{children}</section>;
}

function ActionButton({ children, disabled, onClick, primary = false }: { children: ReactNode; disabled: boolean; onClick: () => void; primary?: boolean }) {
  return <button type="button" disabled={disabled} onClick={onClick} className={`tap min-h-[46px] rounded-xl px-3 text-[13px] font-extrabold disabled:cursor-not-allowed disabled:opacity-40 ${primary ? "bg-brand-600 text-white" : "bg-white text-ink-soft ring-1 ring-line"}`}>{children}</button>;
}

function EmptyDetail() {
  return <div className="rounded-xl2 border border-dashed border-line bg-white py-16 text-center text-[13px] font-bold text-ink-mute">왼쪽에서 업무를 선택해 주세요.</div>;
}
