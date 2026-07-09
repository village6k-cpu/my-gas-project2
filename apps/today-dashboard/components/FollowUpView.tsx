"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { authFetch } from "@/lib/data/authFetch";
import { ViewHeader } from "@/components/ViewHeader";
import { Check, Refresh } from "@/components/icons";

// 후속조치(카톡 AI봇) 보드 — 실제 follow-up-dashboard(index.html) 구조를 네이티브로 이식.
// 4레인 칸반 + 상세카드(추천조치/답변초안/근거) + 벌크 + 30초 폴링 + 상태 PATCH + 답변 전송.
// 디자인은 통합앱 토큰(ink/brand/checkout·checkin·attention·warn)으로 녹임.

type Item = {
  id: string;
  customer_name?: string;
  room_key?: string;
  type?: string;
  priority?: string;
  status?: string;
  title?: string;
  summary?: string;
  recommended_action?: string;
  suggested_reply_draft?: string;
  evidence?: string[];
  blocking_reason?: string;
  created_at?: string;
};
type Summary = { open?: number; urgent?: number; high?: number };
type Payload = { items?: Item[]; summary?: Summary; updatedAt?: string };

const TYPE_LABELS: Record<string, string> = {
  reply_needed: "답변 필요",
  quote_send: "견적서 발송",
  tax_invoice: "세금계산서",
  schedule_check: "스케줄 확인",
  reservation_review: "예약 확인",
  price_review: "가격/할인",
  payment_check: "입금/결제",
  contract_document: "계약/서류",
  return_extension: "반납/연장",
  damage_repair: "파손/수리",
  sheet_duplicate_check: "시트 중복",
  completed_log: "처리 기록",
};
const PRIORITY_LABELS: Record<string, string> = { urgent: "긴급", high: "높음", normal: "보통", low: "낮음" };
const STATUS_LABELS: Record<string, string> = {
  open: "대기",
  in_progress: "진행중",
  waiting_customer: "고객 대기",
  waiting_internal: "내부 대기",
  done: "완료",
  dismissed: "무시",
};
const PRIORITY_ORDER: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
const CLOSED = new Set(["done", "dismissed"]);
const LOCAL_BRIDGE_URL = "http://127.0.0.1:8787";

const LANE_DEFS: { key: string; label: string; match: (x: Item) => boolean }[] = [
  { key: "now", label: "지금", match: (x) => x.priority === "urgent" || x.priority === "high" },
  { key: "reservation", label: "예약·스케줄", match: (x) => ["reservation_review", "schedule_check", "return_extension", "sheet_duplicate_check"].includes(x.type || "") },
  { key: "reply", label: "응답·견적", match: (x) => ["reply_needed", "quote_send", "price_review", "tax_invoice", "payment_check", "contract_document"].includes(x.type || "") },
  { key: "ops", label: "운영·기타", match: () => true },
];

// priority → 색 (앱 시맨틱 팔레트에 맞춤: 긴급 빨강 / 높음 브랜드 오렌지 / 보통 파랑 / 낮음 초록)
const DOT: Record<string, string> = { urgent: "bg-attention-fg", high: "bg-brand-500", normal: "bg-checkout-fg", low: "bg-checkin-fg" };
const BAR: Record<string, string> = { urgent: "bg-attention-fg", high: "bg-brand-500", normal: "bg-checkout-fg", low: "bg-checkin-fg" };
const PRIORITY_CHIP: Record<string, string> = {
  urgent: "bg-attention-bg text-attention-fg",
  high: "bg-brand-50 text-brand-600",
  normal: "bg-checkout-bg text-checkout-fg",
  low: "bg-checkin-bg text-checkin-fg",
};
const STATUS_CHIP: Record<string, string> = {
  in_progress: "bg-checkout-bg text-checkout-fg",
  waiting_customer: "bg-warn-bg text-warn-fg",
  waiting_internal: "bg-warn-bg text-warn-fg",
  done: "bg-line/40 text-ink-mute",
  dismissed: "bg-line/40 text-ink-mute",
};

function fmtRelative(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const min = Math.floor((Date.now() - d.getTime()) / 60000);
  if (min < 1) return "방금";
  if (min < 60) return `${min}분 전`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}시간 전`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}일 전`;
  return d.toLocaleDateString("ko-KR", { month: "numeric", day: "numeric" });
}
function fmtClock(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
}
function sortByPriorityThenNew(a: Item, b: Item): number {
  const pa = PRIORITY_ORDER[a.priority || ""] ?? 9;
  const pb = PRIORITY_ORDER[b.priority || ""] ?? 9;
  if (pa !== pb) return pa - pb;
  return (b.created_at || "").localeCompare(a.created_at || "");
}
function itemMeta(x: Item): string {
  const p: string[] = [];
  if (x.customer_name) p.push(x.customer_name);
  if (TYPE_LABELS[x.type || ""]) p.push(TYPE_LABELS[x.type || ""]);
  if (x.created_at) p.push(fmtRelative(x.created_at));
  return p.join(" · ");
}

function useWide(): boolean {
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1280px)");
    const on = () => setWide(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return wide;
}

export function FollowUpView() {
  const [data, setData] = useState<Payload | null>(null);
  const [status, setStatus] = useState("active");
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const loadingRef = useRef(false);
  const wide = useWide();

  const load = useCallback(async (st: string) => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    setError("");
    try {
      const res = await authFetch(`/api/follow-ups?status=${encodeURIComponent(st)}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "불러오기 실패");
      setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(status);
    const t = setInterval(() => load(status), 30000);
    return () => clearInterval(t);
  }, [status, load]);

  const items = useMemo(() => (Array.isArray(data?.items) ? data!.items! : []), [data]);
  const active = useMemo(() => items.filter((x) => !CLOSED.has(x.status || "")).slice().sort(sortByPriorityThenNew), [items]);
  const closed = useMemo(() => items.filter((x) => CLOSED.has(x.status || "")).slice().sort((a, b) => (b.created_at || "").localeCompare(a.created_at || "")), [items]);
  const lanes = useMemo(() => {
    const map: Record<string, Item[]> = Object.fromEntries(LANE_DEFS.map((l) => [l.key, []]));
    for (const it of active) {
      const lane = LANE_DEFS.find((d) => d.match(it)) || LANE_DEFS[LANE_DEFS.length - 1];
      map[lane.key].push(it);
    }
    return map;
  }, [active]);

  // 포커스 보정
  useEffect(() => {
    if (!items.length) {
      setFocusedId(null);
      return;
    }
    setFocusedId((cur) => (cur && items.some((it) => it.id === cur) ? cur : active[0]?.id || closed[0]?.id || null));
  }, [items, active, closed]);

  // 닫힌 선택 정리
  useEffect(() => {
    setSelected((prev) => {
      const live = new Set(active.map((x) => x.id));
      const next = new Set<string>();
      prev.forEach((id) => live.has(id) && next.add(id));
      return next.size === prev.size ? prev : next;
    });
  }, [active]);

  const patch = useCallback(
    async (ids: string[], st: string) => {
      try {
        const res = await authFetch("/api/follow-ups", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(ids.length === 1 ? { id: ids[0], status: st } : { ids, status: st }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json.error || "상태 변경 실패");
        setSelected((prev) => {
          const n = new Set(prev);
          ids.forEach((id) => n.delete(id));
          return n;
        });
        load(status);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [load, status],
  );

  const sendReply = useCallback(
    async (item: Item, text: string) => {
      const reply = text.trim();
      if (!reply) throw new Error("보낼 답변이 비어 있습니다");
      const res = await fetch(`${LOCAL_BRIDGE_URL}/manual-send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          followUpId: item.id,
          customerName: item.customer_name || "",
          roomTitle: item.customer_name ? `${item.customer_name} - 빌리지 - 카카오비즈니스 파트너센터` : "",
          text: reply,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.ok) throw new Error(json.error || json.result?.reason || "카카오 전송 실패");
      await patch([item.id], "done");
    },
    [patch],
  );

  const toggleSelect = (id: string) =>
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const toggleSectionSelect = useCallback((ids: string[]) => {
    const sectionIds = ids.filter(Boolean);
    if (!sectionIds.length) return;
    setSelected((prev) => {
      const allSelected = sectionIds.length > 0 && sectionIds.every((id) => prev.has(id));
      const next = new Set(prev);
      if (allSelected) sectionIds.forEach((id) => next.delete(id));
      else sectionIds.forEach((id) => next.add(id));
      return next;
    });
  }, []);

  const summary = data?.summary || {};
  const showClosed = (status === "done" || status === "dismissed" || status === "all") && closed.length > 0;
  const focused = items.find((it) => it.id === focusedId) || null;
  const empty = active.length === 0 && !(showClosed && closed.length);

  return (
    <div className="flex min-h-screen flex-col bg-paper">
      {/* 헤더 */}
      <header className="safe-top sticky top-0 z-40 bg-paper/90 backdrop-blur-md ring-1 ring-line/70">
        <ViewHeader title="후속조치">
          <select
            value={status}
            onChange={(e) => {
              setSelected(new Set());
              setFocusedId(null);
              setStatus(e.target.value);
            }}
            className="rounded-full border border-line bg-white px-3 py-1.5 text-[12.5px] font-semibold text-ink-soft outline-none"
          >
            <option value="active">열린 업무</option>
            <option value="all">전체</option>
            <option value="done">완료</option>
            <option value="dismissed">무시</option>
          </select>
          <button onClick={() => load(status)} className={`tap flex h-9 w-9 items-center justify-center rounded-full bg-white ring-1 ring-line/60 text-ink-soft ${loading ? "animate-spin" : ""}`} title="새로고침">
            <Refresh className="h-4 w-4" />
          </button>
        </ViewHeader>
        {data?.updatedAt && <div className="px-4 pb-1.5 text-[11px] text-ink-faint">마지막 업데이트 {fmtClock(data.updatedAt)}</div>}
      </header>

      <main className="flex-1 space-y-3.5 p-3 pb-24">
        {error && <div className="rounded-xl bg-attention-bg px-3.5 py-2.5 text-[13px] font-medium text-attention-fg ring-1 ring-attention-ring">{error}</div>}

        {/* 요약 3칸 */}
        <div className="grid grid-cols-3 gap-2.5">
          <Stat label="할 일" value={summary.open ?? 0} />
          <Stat label="긴급" value={summary.urgent ?? 0} tone={(summary.urgent ?? 0) > 0 ? "urgent" : undefined} />
          <Stat label="높음" value={summary.high ?? 0} tone={(summary.high ?? 0) > 0 ? "high" : undefined} />
        </div>

        {/* 벌크바 */}
        {selected.size > 0 && (
          <div className="sticky top-[60px] z-20 flex flex-col gap-2 rounded-xl bg-white/95 p-2.5 shadow-card ring-1 ring-line sm:flex-row sm:items-center sm:justify-between">
            <span className="text-[13px] font-extrabold text-ink-soft">{selected.size}개 선택</span>
            <div className="flex flex-wrap gap-1.5">
              <BulkBtn onClick={() => patch([...selected], "done")} primary>완료</BulkBtn>
              <BulkBtn onClick={() => patch([...selected], "in_progress")}>진행중</BulkBtn>
              <BulkBtn onClick={() => { if (confirm(`${selected.size}개 업무를 무시 처리할까요?`)) patch([...selected], "dismissed"); }} ghost>무시</BulkBtn>
              <BulkBtn onClick={() => setSelected(new Set())} ghost>선택 해제</BulkBtn>
            </div>
          </div>
        )}

        {/* 워크벤치: 보드(레인) + 상세 (xl 사이드 / 그 외 인라인) */}
        {active.length > 0 && (
          <div className={wide ? "grid grid-cols-[minmax(0,1fr)_360px] items-start gap-3.5" : ""}>
            <div className="grid min-w-0 grid-cols-1 gap-2.5 sm:grid-cols-2 2xl:grid-cols-4">
              {LANE_DEFS.map((def) => (
                <Lane
                  key={def.key}
                  label={def.label}
                  laneKey={def.key}
                  items={lanes[def.key] || []}
                  focusedId={focusedId}
                  selected={selected}
                  inlineDetail={!wide}
                  onFocus={setFocusedId}
                  onToggle={toggleSelect}
                  onToggleSection={toggleSectionSelect}
                  onPatch={patch}
                  onSend={sendReply}
                />
              ))}
            </div>
            {wide && (
              <aside className="sticky top-[80px] min-w-0">
                {focused ? (
                  <DetailCard item={focused} selected={selected.has(focused.id)} onToggle={toggleSelect} onPatch={patch} onSend={sendReply} />
                ) : (
                  <div className="rounded-xl2 border border-dashed border-line bg-white px-4 py-6 text-center text-[13px] font-semibold text-ink-faint">선택된 업무가 없습니다</div>
                )}
              </aside>
            )}
          </div>
        )}

        {/* 완료/무시 섹션 */}
        {showClosed && (
          <section className="space-y-2">
            <div className="flex items-baseline justify-between px-1">
              <h2 className="text-[14px] font-bold text-ink-soft">{status === "done" ? "완료" : status === "dismissed" ? "무시" : "완료·무시"}</h2>
              <span className="text-[12px] text-ink-mute">{closed.length}건</span>
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 2xl:grid-cols-3">
              {closed.map((it) => (
                <TaskRow key={it.id} item={it} closed focused={false} selected={false} inlineDetail={false} onFocus={() => {}} onToggle={() => {}} onPatch={patch} onSend={sendReply} />
              ))}
            </div>
          </section>
        )}

        {empty && (
          <div className="rounded-xl2 border border-dashed border-line bg-white py-16 text-center">
            <div className="text-[15px] font-extrabold text-ink-soft">{status === "active" ? "지금 할 일이 없습니다" : "표시할 항목이 없습니다"}</div>
            <div className="mt-1.5 text-[13px] text-ink-mute">{status === "active" ? "모든 후속조치가 정리되었습니다." : "필터를 바꿔보세요."}</div>
          </div>
        )}
      </main>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: "urgent" | "high" }) {
  const color = tone === "urgent" ? "text-attention-fg" : tone === "high" ? "text-brand-600" : "text-ink";
  return (
    <div className="rounded-xl bg-white p-3.5 shadow-card ring-1 ring-line/70">
      <div className="text-[12px] font-semibold text-ink-mute">{label}</div>
      <div className={`mt-1 text-[26px] font-extrabold leading-none tabular-nums ${color}`}>{value}</div>
    </div>
  );
}

function Lane({
  label, laneKey, items, focusedId, selected, inlineDetail, onFocus, onToggle, onToggleSection, onPatch, onSend,
}: {
  label: string; laneKey: string; items: Item[]; focusedId: string | null; selected: Set<string>; inlineDetail: boolean;
  onFocus: (id: string) => void; onToggle: (id: string) => void; onToggleSection: (ids: string[]) => void; onPatch: (ids: string[], st: string) => void; onSend: (i: Item, t: string) => Promise<void>;
}) {
  const sectionIds = items.map((it) => it.id);
  const allSelected = sectionIds.length > 0 && sectionIds.every((id) => selected.has(id));
  return (
    <section className="min-w-0 overflow-hidden rounded-xl bg-white ring-1 ring-line/70">
      <div className="flex min-h-[42px] items-center justify-between gap-2 border-b border-line/60 bg-paper/60 px-3 py-2.5">
        <h2 className="text-[13px] font-extrabold text-ink-soft">{label}</h2>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => onToggleSection(sectionIds)}
            disabled={items.length === 0}
            className={`tap flex h-[24px] w-[24px] items-center justify-center rounded-full ring-1 transition disabled:cursor-not-allowed disabled:bg-white disabled:text-ink-faint disabled:ring-line/70 ${
              allSelected ? "bg-brand-600 text-white ring-brand-600" : "bg-white text-ink-mute ring-line hover:bg-checkin-bg hover:text-checkin-fg hover:ring-checkin-ring"
            }`}
            aria-pressed={allSelected}
            aria-label={allSelected ? `${label} 섹션 선택 해제` : `${label} 섹션 선택`}
            title={allSelected ? `${label} 섹션 선택 해제` : `${label} 섹션 선택`}
          >
            <Check className="h-3.5 w-3.5" />
          </button>
          <span className={`inline-flex h-[22px] min-w-[22px] items-center justify-center rounded-full px-1.5 text-[12px] font-extrabold ${laneKey === "now" ? "bg-attention-bg text-attention-fg" : "bg-white text-ink-mute ring-1 ring-line"}`}>{items.length}</span>
        </div>
      </div>
      <div className="flex flex-col gap-2 p-2">
        {items.length === 0 ? (
          <div className="flex min-h-[64px] items-center justify-center text-[13px] font-semibold text-ink-faint">없음</div>
        ) : (
          items.map((it) => (
            <TaskRow
              key={it.id}
              item={it}
              closed={false}
              focused={focusedId === it.id}
              selected={selected.has(it.id)}
              inlineDetail={inlineDetail && focusedId === it.id}
              onFocus={onFocus}
              onToggle={onToggle}
              onPatch={onPatch}
              onSend={onSend}
            />
          ))
        )}
      </div>
    </section>
  );
}

function TaskRow({
  item, closed, focused, selected, inlineDetail, onFocus, onToggle, onPatch, onSend,
}: {
  item: Item; closed: boolean; focused: boolean; selected: boolean; inlineDetail: boolean;
  onFocus: (id: string) => void; onToggle: (id: string) => void; onPatch: (ids: string[], st: string) => void; onSend: (i: Item, t: string) => Promise<void>;
}) {
  const pr = item.priority || "normal";
  return (
    <div>
      <article
        onClick={() => !closed && onFocus(item.id)}
        className={`grid w-full cursor-pointer grid-cols-[22px_minmax(0,1fr)] gap-2 rounded-lg bg-white p-2.5 ring-1 transition ${
          focused ? "ring-2 ring-ink/30" : selected ? "ring-2 ring-brand-400" : "ring-line/70 hover:ring-line"
        }`}
      >
        {closed ? (
          <span aria-hidden />
        ) : (
          <input
            type="checkbox"
            checked={selected}
            onClick={(e) => e.stopPropagation()}
            onChange={() => onToggle(item.id)}
            className="mt-0.5 h-[18px] w-[18px] accent-brand-600"
            aria-label="선택"
          />
        )}
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className={`h-2 w-2 shrink-0 rounded-full ${DOT[pr] || DOT.normal}`} aria-hidden />
            <div className="truncate text-[13.5px] font-extrabold text-ink">{item.title || "제목 없음"}</div>
          </div>
          <div className="mt-0.5 truncate text-[11.5px] font-semibold text-ink-mute">{itemMeta(item) || "상세 정보 없음"}</div>
          {item.summary && <div className="mt-1 line-clamp-1 text-[12.5px] leading-snug text-ink-soft">{item.summary}</div>}
          {/* 행 빠른 액션 */}
          <div className="mt-2 flex gap-1.5">
            {closed ? (
              <MiniBtn onClick={() => onPatch([item.id], "open")}>되살리기</MiniBtn>
            ) : (
              <>
                <MiniBtn primary onClick={() => onPatch([item.id], "done")}>완료</MiniBtn>
                <MiniBtn onClick={() => onPatch([item.id], "in_progress")}>진행</MiniBtn>
              </>
            )}
          </div>
        </div>
      </article>
      {inlineDetail && <div className="ml-[30px] mt-1"><DetailCard item={item} selected={selected} onToggle={onToggle} onPatch={onPatch} onSend={onSend} /></div>}
    </div>
  );
}

function DetailCard({
  item, selected, onToggle, onPatch, onSend,
}: {
  item: Item; selected: boolean; onToggle: (id: string) => void; onPatch: (ids: string[], st: string) => void; onSend: (i: Item, t: string) => Promise<void>;
}) {
  const pr = item.priority || "normal";
  const st = item.status || "open";
  const closed = CLOSED.has(st);
  const evidence = Array.isArray(item.evidence) ? item.evidence : [];
  const [draft, setDraft] = useState(item.suggested_reply_draft || "");
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => setDraft(item.suggested_reply_draft || ""), [item.id, item.suggested_reply_draft]);

  return (
    <article className={`relative overflow-hidden rounded-xl2 bg-white p-3.5 shadow-card ring-1 ${selected ? "ring-2 ring-brand-400" : "ring-line/70"}`}>
      <span className={`absolute inset-y-0 left-0 w-1 ${BAR[pr] || BAR.normal}`} aria-hidden />
      <div className="flex items-start gap-2.5 pl-1">
        {!closed && <input type="checkbox" checked={selected} onChange={() => onToggle(item.id)} className="mt-0.5 h-6 w-6 shrink-0 accent-brand-600" aria-label="선택" />}
        <div className="min-w-0 flex-1">
          <div className="mb-2 flex flex-wrap gap-1.5">
            {TYPE_LABELS[item.type || ""] && <span className="rounded-full bg-paper px-2 py-0.5 text-[11px] font-bold text-ink-soft ring-1 ring-line/70">{TYPE_LABELS[item.type || ""]}</span>}
            <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${PRIORITY_CHIP[pr] || PRIORITY_CHIP.normal}`}>{PRIORITY_LABELS[pr] || pr}</span>
            <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${STATUS_CHIP[st] || "bg-line/40 text-ink-soft"}`}>{STATUS_LABELS[st] || st}</span>
          </div>
          <h3 className="text-[16px] font-bold leading-snug text-ink [word-break:keep-all]">{item.title || "제목 없음"}</h3>
          <div className="mt-1 text-[12px] text-ink-mute">
            {item.customer_name ? <b className="font-semibold text-ink-soft">{item.customer_name}</b> : <span>고객명 미상</span>}
            {item.created_at && ` · ${fmtRelative(item.created_at)}`}
          </div>
          {item.summary && <div className="mt-2.5 whitespace-pre-wrap break-words text-[14px] leading-relaxed text-ink-soft">{item.summary}</div>}

          {item.recommended_action && (
            <div className="mt-2.5 rounded-lg bg-warn-bg px-3 py-2.5 text-[13.5px] leading-relaxed text-warn-fg ring-1 ring-warn-ring">
              <span className="mb-1 block text-[11px] font-extrabold uppercase tracking-wide opacity-75">추천 조치</span>
              <div className="whitespace-pre-wrap break-words">{item.recommended_action}</div>
            </div>
          )}

          {item.suggested_reply_draft && !closed ? (
            <div className="mt-2.5 rounded-lg bg-paper p-3 ring-1 ring-line/70">
              <label className="mb-1.5 block text-[11px] font-extrabold tracking-wide text-ink-mute">답변 초안</label>
              <textarea value={draft} onChange={(e) => setDraft(e.target.value)} className="min-h-[92px] w-full resize-y rounded-lg border border-line bg-white p-2.5 text-[13.5px] leading-relaxed text-ink outline-none focus:border-brand-500" />
              {err && <div className="mt-1.5 text-[12px] font-medium text-attention-fg">{err}</div>}
              <button
                disabled={sending}
                onClick={() => {
                  setSending(true);
                  setErr("");
                  onSend(item, draft).catch((e) => setErr(e instanceof Error ? e.message : String(e))).finally(() => setSending(false));
                }}
                className="tap mt-2 w-full rounded-lg bg-brand-600 py-2.5 text-[13.5px] font-bold text-white disabled:opacity-50"
              >
                {sending ? "전송 중…" : "전송"}
              </button>
            </div>
          ) : item.suggested_reply_draft ? (
            <details className="mt-2.5">
              <summary className="cursor-pointer text-[12.5px] font-semibold text-ink-mute">답변 초안 보기</summary>
              <div className="mt-1.5 whitespace-pre-wrap break-words rounded-lg bg-paper/70 px-3 py-2 text-[13px] text-ink-soft">{item.suggested_reply_draft}</div>
            </details>
          ) : null}

          {(evidence.length > 0 || item.blocking_reason) && (
            <details className="mt-2.5">
              <summary className="cursor-pointer text-[12.5px] font-semibold text-ink-mute">근거{evidence.length ? ` (${evidence.length})` : ""}</summary>
              <div className="mt-1.5 space-y-1 pl-3 text-[12.5px] leading-relaxed text-ink-mute">
                {evidence.length ? evidence.map((e, i) => <p key={i}>• {e}</p>) : <p>근거 없음</p>}
                {item.blocking_reason && <p className="text-attention-fg"><b>보류 사유:</b> {item.blocking_reason}</p>}
              </div>
            </details>
          )}

          <div className="mt-3 flex flex-wrap gap-1.5">
            {closed ? (
              <ActBtn onClick={() => onPatch([item.id], "open")}>되살리기</ActBtn>
            ) : (
              <>
                <ActBtn primary onClick={() => onPatch([item.id], "done")}>완료</ActBtn>
                <ActBtn onClick={() => onPatch([item.id], "in_progress")}>진행중</ActBtn>
                <ActBtn ghost onClick={() => { if (confirm("이 업무를 무시 처리할까요?")) onPatch([item.id], "dismissed"); }}>무시</ActBtn>
              </>
            )}
          </div>
        </div>
      </div>
    </article>
  );
}

function MiniBtn({ children, onClick, primary }: { children: ReactNode; onClick: () => void; primary?: boolean }) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      className={`tap min-h-[28px] rounded-md px-2 text-[11.5px] font-extrabold ${primary ? "bg-brand-600 text-white" : "bg-paper text-ink-soft ring-1 ring-line/70"}`}
    >
      {children}
    </button>
  );
}
function BulkBtn({ children, onClick, primary, ghost }: { children: ReactNode; onClick: () => void; primary?: boolean; ghost?: boolean }) {
  return (
    <button onClick={onClick} className={`tap min-h-[34px] rounded-lg px-2.5 text-[12.5px] font-bold ${primary ? "bg-brand-600 text-white" : ghost ? "text-ink-mute" : "bg-paper text-ink-soft ring-1 ring-line/70"}`}>
      {children}
    </button>
  );
}
function ActBtn({ children, onClick, primary, ghost }: { children: ReactNode; onClick: () => void; primary?: boolean; ghost?: boolean }) {
  return (
    <button onClick={onClick} className={`tap min-h-[40px] flex-1 rounded-lg px-3.5 text-[13.5px] font-bold ${primary ? "bg-brand-600 text-white" : ghost ? "text-ink-mute ring-1 ring-line/70" : "bg-white text-ink-soft ring-1 ring-line"}`}>
      {children}
    </button>
  );
}
