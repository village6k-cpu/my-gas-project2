"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { supabase } from "@/lib/supabase/client";
import { TYPE_LABELS } from "@/lib/followups/logic";
import { AppSwitcher } from "@/components/AppSwitcher";
import { Refresh } from "@/components/icons";

/* eslint-disable @typescript-eslint/no-explicit-any */
type FU = {
  id: string; type: string; priority?: string; status?: string;
  customer_name?: string; title?: string; summary?: string;
  recommended_action?: string; suggested_reply_draft?: string;
  evidence?: string[]; blocking_reason?: string; created_at?: string;
};

const LABELS = TYPE_LABELS as Record<string, string>;
const LANE_DEFS: { key: string; label: string; match: (x: FU) => boolean }[] = [
  { key: "now", label: "지금", match: (x) => x.priority === "urgent" || x.priority === "high" },
  { key: "reservation", label: "예약·스케줄", match: (x) => ["reservation_review", "schedule_check", "return_extension", "sheet_duplicate_check"].includes(x.type) },
  { key: "reply", label: "응답·견적", match: (x) => ["reply_needed", "quote_send", "price_review", "tax_invoice", "payment_check", "contract_document"].includes(x.type) },
  { key: "ops", label: "운영·기타", match: () => true },
];
const PRIORITY_ORDER: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
const PRIORITY_LABEL: Record<string, string> = { urgent: "긴급", high: "높음", normal: "보통", low: "낮음" };
// 우선순위별 [점/띠색, 칩 배경, 칩 글자]
const PRI: Record<string, { dot: string; bg: string; ink: string }> = {
  urgent: { dot: "#dc2626", bg: "#fef2f2", ink: "#991b1b" },
  high: { dot: "#ea580c", bg: "#fff7ed", ink: "#9a3412" },
  normal: { dot: "#0284c7", bg: "#f0f9ff", ink: "#0c4a6e" },
  low: { dot: "#16a34a", bg: "#f0fdf4", ink: "#14532d" },
};

async function authFetch(path: string, init?: RequestInit): Promise<Response> {
  let token = "";
  if (supabase) {
    const { data } = await supabase.auth.getSession();
    token = data.session?.access_token ?? "";
  }
  return fetch(path, { ...init, headers: { ...(init?.headers || {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
}

function fmtRel(iso?: string): string {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1) return "방금";
  if (m < 60) return `${m}분 전`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}시간 전`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}일 전`;
  const dt = new Date(iso);
  return `${dt.getMonth() + 1}/${dt.getDate()}`;
}

const STATUS_TABS = [
  { v: "active", label: "진행중" },
  { v: "all", label: "전체" },
  { v: "done", label: "완료" },
] as const;

export function FollowUpView({ embedded, headerLeft }: { embedded?: boolean; headerLeft?: ReactNode } = {}) {
  const [status, setStatus] = useState<"active" | "all" | "done">("active");
  const [data, setData] = useState<{ items: FU[]; summary: any } | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [focused, setFocused] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await authFetch(`/api/follow-ups?status=${status}`);
      const j = await r.json();
      setData(j.ok ? { items: j.items, summary: j.summary } : { items: [], summary: null });
    } catch {
      setData({ items: [], summary: null });
    }
    setLoading(false);
  }, [status]);

  useEffect(() => {
    setLoading(true);
    load();
    const t = setInterval(load, 30000); // 30초 폴링
    return () => clearInterval(t);
  }, [load]);

  async function act(id: string, newStatus: string) {
    if (newStatus === "dismissed" && !confirm("이 업무를 무시 처리할까요?")) return;
    setBusy(id);
    try {
      await authFetch("/api/follow-ups", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, status: newStatus }) });
      await load();
    } catch { /* noop */ }
    setBusy("");
  }

  const lanes = useMemo(() => {
    const byLane: Record<string, FU[]> = {};
    for (const def of LANE_DEFS) byLane[def.key] = [];
    for (const it of data?.items ?? []) {
      const def = LANE_DEFS.find((d) => d.match(it));
      if (def) byLane[def.key].push(it);
    }
    for (const k of Object.keys(byLane)) {
      byLane[k].sort((a, b) => (PRIORITY_ORDER[a.priority || "normal"] - PRIORITY_ORDER[b.priority || "normal"]) || (new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime()));
    }
    return byLane;
  }, [data]);

  const s = data?.summary;

  return (
    <div className={`flex flex-col bg-[#f1f4f9] ${embedded ? "min-h-full" : "mx-auto min-h-screen max-w-6xl"}`}>
      <header className="safe-top sticky top-0 z-30 bg-[#f1f4f9]/92 backdrop-blur-md ring-1 ring-[#e2e8f0]">
        <div className="flex items-center justify-between px-4 pt-2.5">
          {headerLeft ?? <AppSwitcher active="follow" />}
          <div className="flex items-center gap-2">
            <select
              value={status}
              onChange={(e) => { setStatus(e.target.value as any); setFocused(null); }}
              className="rounded-lg border border-[#e2e8f0] bg-white px-2 py-1 text-[12.5px] font-semibold text-[#334155] outline-none"
            >
              {STATUS_TABS.map((t) => <option key={t.v} value={t.v}>{t.label}</option>)}
            </select>
            <button onClick={() => load()} className="tap flex h-9 w-9 items-center justify-center rounded-full bg-black/[0.04] text-[#334155]">
              <Refresh className="h-4 w-4" />
            </button>
          </div>
        </div>
        {s && (
          <div className="flex items-center gap-2 px-4 pb-2.5 pt-2 text-[12px]">
            <span className="rounded-md bg-white px-2 py-1 font-bold text-[#0f172a] ring-1 ring-[#e2e8f0]">할 일 {s.open}</span>
            {s.urgent > 0 && <span className="rounded-md bg-[#fef2f2] px-2 py-1 font-bold text-[#991b1b] ring-1 ring-[#fecaca]">긴급 {s.urgent}</span>}
            {s.high > 0 && <span className="rounded-md bg-[#fff7ed] px-2 py-1 font-bold text-[#9a3412] ring-1 ring-[#fed7aa]">높음 {s.high}</span>}
          </div>
        )}
      </header>

      <main className="flex-1 p-3">
        {loading && <div className="py-20 text-center text-[14px] text-[#64748b]">불러오는 중…</div>}
        {!loading && (data?.items.length ?? 0) === 0 && (
          <div className="rounded-lg bg-white py-16 text-center text-[14px] text-[#64748b] ring-1 ring-[#e2e8f0]">
            {status === "active" ? "지금 할 일이 없습니다 🎉" : "표시할 항목이 없습니다"}
          </div>
        )}
        {!loading && (data?.items.length ?? 0) > 0 && (
          <div className="grid gap-3 xl:grid-cols-2 2xl:grid-cols-4">
            {LANE_DEFS.map((def) => {
              const items = lanes[def.key] || [];
              if (!items.length) return null;
              const isNow = def.key === "now";
              return (
                <section key={def.key} className="rounded-xl bg-[#f8fafc] p-2 ring-1 ring-[#eef2f7]">
                  <div className="mb-1.5 flex items-center gap-2 px-1">
                    <h2 className="text-[12.5px] font-extrabold text-[#0f172a]">{def.label}</h2>
                    <span className={`rounded-full px-1.5 text-[11px] font-bold tabular-nums ${isNow ? "bg-[#fef2f2] text-[#991b1b] ring-1 ring-[#fecaca]" : "bg-white text-[#64748b] ring-1 ring-[#e2e8f0]"}`}>{items.length}</span>
                  </div>
                  <div className="space-y-1.5">
                    {items.map((it) => (
                      <TaskRow key={it.id} it={it} open={focused === it.id} onToggle={() => setFocused(focused === it.id ? null : it.id)} busy={busy === it.id} onAct={act} />
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}

function TaskRow({ it, open, onToggle, busy, onAct }: { it: FU; open: boolean; onToggle: () => void; busy: boolean; onAct: (id: string, s: string) => void }) {
  const p = PRI[it.priority || "normal"] || PRI.normal;
  const done = it.status === "done" || it.status === "dismissed";
  return (
    <article className={`overflow-hidden rounded-md bg-white ring-1 ${open ? "ring-[#0f172a]" : "ring-[#eef2f7]"} ${done ? "opacity-60" : ""}`} style={{ boxShadow: "0 1px 2px rgba(15,23,42,0.03)" }}>
      <button onClick={onToggle} className="flex w-full items-start gap-2 px-2.5 py-2 text-left">
        <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full" style={{ background: p.dot }} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13.5px] font-extrabold text-[#0f172a]">{it.title || "제목 없음"}</div>
          <div className="mt-0.5 truncate text-[11.5px] font-semibold text-[#64748b]">
            {[it.customer_name, LABELS[it.type] || it.type, fmtRel(it.created_at)].filter(Boolean).join(" · ")}
          </div>
          {!open && it.summary && <div className="mt-0.5 line-clamp-1 text-[12px] text-[#64748b]">{it.summary}</div>}
        </div>
      </button>

      {open && (
        <div className="space-y-2 border-t border-[#eef2f7] px-2.5 py-2.5">
          <div className="flex flex-wrap gap-1">
            <Chip>{LABELS[it.type] || it.type}</Chip>
            <Chip bg={p.bg} ink={p.ink}>{PRIORITY_LABEL[it.priority || "normal"]}</Chip>
          </div>
          {it.summary && <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-[#334155]">{it.summary}</p>}
          {it.recommended_action && (
            <div className="rounded-md border border-[#fde68a] bg-[#fffbeb] px-2.5 py-1.5 text-[12.5px] text-[#713f12]">
              <span className="font-bold">추천 조치 · </span>{it.recommended_action}
            </div>
          )}
          {it.suggested_reply_draft && (
            <div className="rounded-md bg-[#f8fafc] p-2 ring-1 ring-[#eef2f7]">
              <div className="mb-1 text-[11px] font-bold text-[#94a3b8]">답변 초안</div>
              <p className="whitespace-pre-wrap text-[12.5px] text-[#334155]">{it.suggested_reply_draft}</p>
              <button onClick={() => navigator.clipboard?.writeText(it.suggested_reply_draft || "")} className="tap mt-1.5 rounded-md bg-white px-2 py-1 text-[11.5px] font-bold text-[#0f172a] ring-1 ring-[#e2e8f0]">복사</button>
            </div>
          )}
          {((it.evidence && it.evidence.length > 0) || it.blocking_reason) && (
            <details className="rounded-md bg-[#f8fafc] px-2 py-1.5 ring-1 ring-[#eef2f7]">
              <summary className="cursor-pointer text-[11.5px] font-bold text-[#64748b]">근거 {it.evidence?.length ? `(${it.evidence.length})` : ""}</summary>
              <div className="mt-1 space-y-0.5 text-[11.5px] text-[#64748b]">
                {(it.evidence || []).slice(0, 8).map((e, i) => <p key={i}>• {e}</p>)}
                {it.blocking_reason && <p className="text-[#9a3412]"><b>보류 사유:</b> {it.blocking_reason}</p>}
              </div>
            </details>
          )}
          {!done ? (
            <div className="flex gap-1.5">
              <button onClick={() => onAct(it.id, "done")} disabled={busy} className="tap flex-1 rounded-md bg-[#0f172a] py-2 text-[12.5px] font-bold text-white disabled:opacity-50">완료</button>
              <button onClick={() => onAct(it.id, "in_progress")} disabled={busy} className="tap rounded-md bg-white px-3 py-2 text-[12.5px] font-bold text-[#334155] ring-1 ring-[#e2e8f0] disabled:opacity-50">진행</button>
              <button onClick={() => onAct(it.id, "dismissed")} disabled={busy} className="tap rounded-md bg-white px-3 py-2 text-[12.5px] font-bold text-[#94a3b8] ring-1 ring-[#e2e8f0] disabled:opacity-50">무시</button>
            </div>
          ) : (
            <button onClick={() => onAct(it.id, "open")} disabled={busy} className="tap text-[12px] font-semibold text-[#94a3b8] disabled:opacity-50">되살리기</button>
          )}
        </div>
      )}
    </article>
  );
}

function Chip({ children, bg, ink }: { children: ReactNode; bg?: string; ink?: string }) {
  return (
    <span className="inline-flex rounded-full px-2 py-0.5 text-[11px] font-bold ring-1 ring-[#eef2f7]" style={{ background: bg || "#f8fafc", color: ink || "#334155" }}>
      {children}
    </span>
  );
}
