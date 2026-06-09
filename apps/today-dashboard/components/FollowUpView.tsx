"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase/client";
import { TYPE_LABELS } from "@/lib/followups/logic";
import { AppSwitcher } from "@/components/AppSwitcher";
import { Check, Refresh } from "@/components/icons";

/* eslint-disable @typescript-eslint/no-explicit-any */
type FU = {
  id: string;
  type: string;
  priority?: string;
  status?: string;
  customer_name?: string;
  title?: string;
  summary?: string;
  recommended_action?: string;
  suggested_reply_draft?: string;
  evidence?: string[];
  due_hint?: string;
  created_at?: string;
};

const LABELS = TYPE_LABELS as Record<string, string>;
const TYPE_ORDER: string[] = Object.keys(LABELS);
const PRIORITY: Record<string, { label: string; cls: string }> = {
  urgent: { label: "긴급", cls: "bg-rose-100 text-rose-700" },
  high: { label: "높음", cls: "bg-amber-100 text-amber-700" },
  normal: { label: "보통", cls: "bg-black/[0.06] text-ink-mute" },
  low: { label: "낮음", cls: "bg-black/[0.04] text-ink-faint" },
};

async function authFetch(path: string, init?: RequestInit): Promise<Response> {
  let token = "";
  if (supabase) {
    const { data } = await supabase.auth.getSession();
    token = data.session?.access_token ?? "";
  }
  return fetch(path, {
    ...init,
    headers: { ...(init?.headers || {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
}

const STATUS_TABS: { v: "active" | "all" | "done"; label: string }[] = [
  { v: "active", label: "진행중" },
  { v: "all", label: "전체" },
  { v: "done", label: "완료" },
];

export function FollowUpView() {
  const [status, setStatus] = useState<"active" | "all" | "done">("active");
  const [data, setData] = useState<{ items: FU[]; summary: any } | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string>("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await authFetch(`/api/follow-ups?status=${status}`);
      const j = await r.json();
      if (j.ok) setData({ items: j.items, summary: j.summary });
      else setData({ items: [], summary: null });
    } catch {
      setData({ items: [], summary: null });
    }
    setLoading(false);
  }, [status]);

  useEffect(() => {
    load();
  }, [load]);

  async function act(id: string, newStatus: string) {
    setBusy(id);
    try {
      await authFetch("/api/follow-ups", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, status: newStatus }),
      });
      await load();
    } catch {
      /* noop */
    }
    setBusy("");
  }

  const groups = useMemo(() => {
    const by: Record<string, FU[]> = {};
    for (const it of data?.items ?? []) (by[it.type] ||= []).push(it);
    return TYPE_ORDER.filter((t) => by[t]?.length).map((t) => [t, by[t]] as const);
  }, [data]);

  const s = data?.summary;

  return (
    <div className="mx-auto flex min-h-screen max-w-2xl flex-col bg-[#f4f5f7]">
      <header className="safe-top sticky top-0 z-30 bg-white/90 backdrop-blur-md ring-1 ring-black/5">
        <div className="flex items-center justify-between px-4 pt-2.5">
          <AppSwitcher active="follow" />
          <button onClick={() => load()} className="tap flex h-9 w-9 items-center justify-center rounded-full bg-black/[0.04] text-ink-soft">
            <Refresh className="h-4 w-4" />
          </button>
        </div>
        <div className="flex items-center gap-2 px-4 pb-2.5 pt-2">
          <div className="flex items-center gap-0.5 rounded-lg bg-black/[0.05] p-0.5">
            {STATUS_TABS.map((t) => (
              <button
                key={t.v}
                onClick={() => setStatus(t.v)}
                className={`tap rounded-md px-2.5 py-1.5 text-[12.5px] font-bold ${status === t.v ? "bg-white text-brand-700 shadow-sm" : "text-ink-mute"}`}
              >
                {t.label}
              </button>
            ))}
          </div>
          {s && (
            <div className="flex items-center gap-1.5 text-[12px]">
              <span className="font-bold text-ink">미처리 {s.open}</span>
              {s.urgent > 0 && <span className="rounded bg-rose-100 px-1.5 py-0.5 font-bold text-rose-700">긴급 {s.urgent}</span>}
              {s.high > 0 && <span className="rounded bg-amber-100 px-1.5 py-0.5 font-bold text-amber-700">높음 {s.high}</span>}
            </div>
          )}
        </div>
      </header>

      <main className="flex-1 space-y-4 px-4 pb-20 pt-3">
        {loading && <div className="py-20 text-center text-[14px] text-ink-faint">불러오는 중…</div>}
        {!loading && groups.length === 0 && (
          <div className="rounded-xl2 bg-white py-16 text-center text-[14px] text-ink-faint shadow-card ring-1 ring-black/5">
            {status === "active" ? "처리할 후속조치가 없습니다 🎉" : "항목이 없습니다"}
          </div>
        )}
        {groups.map(([type, items]) => (
          <section key={type}>
            <div className="mb-1.5 flex items-center gap-2 pl-0.5">
              <h2 className="text-[13px] font-extrabold text-ink">{LABELS[type] || type}</h2>
              <span className="text-[12px] font-bold text-ink-faint">{items.length}</span>
            </div>
            <div className="space-y-2">
              {items.map((it) => (
                <FollowUpCard key={it.id} it={it} busy={busy === it.id} onAct={act} />
              ))}
            </div>
          </section>
        ))}
      </main>
    </div>
  );
}

function FollowUpCard({ it, busy, onAct }: { it: FU; busy: boolean; onAct: (id: string, s: string) => void }) {
  const [open, setOpen] = useState(false);
  const pr = PRIORITY[it.priority || "normal"] || PRIORITY.normal;
  const done = it.status === "done" || it.status === "dismissed";
  return (
    <div className={`rounded-xl2 bg-white p-3 shadow-card ring-1 ring-black/5 ${done ? "opacity-60" : ""}`}>
      <div className="flex items-start gap-2">
        <span className={`shrink-0 rounded-md px-1.5 py-0.5 text-[10.5px] font-bold ${pr.cls}`}>{pr.label}</span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            {it.customer_name && <span className="truncate text-[13.5px] font-extrabold text-ink">{it.customer_name}</span>}
            {it.due_hint && <span className="shrink-0 rounded bg-black/[0.05] px-1 text-[10.5px] text-ink-mute">{it.due_hint}</span>}
          </div>
          {it.title && <div className="mt-0.5 text-[13.5px] font-semibold text-ink-soft">{it.title}</div>}
        </div>
      </div>

      {it.summary && <p className="mt-2 whitespace-pre-wrap text-[13px] leading-relaxed text-ink-soft">{it.summary}</p>}

      {it.recommended_action && (
        <div className="mt-2 rounded-lg bg-brand-50 px-2.5 py-1.5 text-[12.5px] text-brand-700">
          <span className="font-bold">조치: </span>
          {it.recommended_action}
        </div>
      )}

      {(it.suggested_reply_draft || (it.evidence && it.evidence.length > 0)) && (
        <button onClick={() => setOpen((o) => !o)} className="tap mt-2 text-[12px] font-semibold text-ink-mute">
          {open ? "접기" : "답변 초안·근거 보기"}
        </button>
      )}
      {open && (
        <div className="mt-1.5 space-y-2">
          {it.suggested_reply_draft && (
            <div className="rounded-lg bg-black/[0.03] px-2.5 py-2">
              <div className="mb-1 text-[11px] font-bold text-ink-faint">답변 초안</div>
              <p className="whitespace-pre-wrap text-[12.5px] text-ink-soft">{it.suggested_reply_draft}</p>
              <button
                onClick={() => navigator.clipboard?.writeText(it.suggested_reply_draft || "")}
                className="tap mt-1.5 rounded-md bg-white px-2 py-1 text-[11.5px] font-bold text-brand-700 ring-1 ring-black/10"
              >
                복사
              </button>
            </div>
          )}
          {it.evidence && it.evidence.length > 0 && (
            <ul className="space-y-0.5 pl-1 text-[11.5px] text-ink-faint">
              {it.evidence.slice(0, 6).map((e, i) => (
                <li key={i}>· {e}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {!done && (
        <div className="mt-2.5 flex gap-2">
          <button
            onClick={() => onAct(it.id, "done")}
            disabled={busy}
            className="tap flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-checkin-fg py-2 text-[13px] font-bold text-white disabled:opacity-50"
          >
            <Check className="h-4 w-4" /> 완료
          </button>
          <button
            onClick={() => onAct(it.id, "dismissed")}
            disabled={busy}
            className="tap rounded-lg bg-black/[0.05] px-4 py-2 text-[13px] font-bold text-ink-mute disabled:opacity-50"
          >
            무시
          </button>
        </div>
      )}
      {done && (
        <button onClick={() => onAct(it.id, "open")} disabled={busy} className="tap mt-2 text-[12px] font-semibold text-ink-faint disabled:opacity-50">
          되돌리기
        </button>
      )}
    </div>
  );
}
