"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabase/client";
import { ViewHeader } from "@/components/ViewHeader";
import { Check, Refresh, Search } from "@/components/icons";

// 재고 — village.equipment_ledger(재고관리대장) 뷰 + 실물 확인(검증) 플로우.
// 275행 전체 1회 로드(페이지네이션 불필요) → 칩 필터/검색 + 옵티미스틱 업데이트 + equipment_events 이력.
// 원장 테이블이 아직 없으면(마이그레이션 전) 안내 문구만 — 크래시 금지.

type VerifyStatus = "unverified" | "verified" | "attention";

type OpenIssue = { label: string; tradeId?: string; at?: string };

type LedgerRow = {
  equipment_id: string;
  major: string | null;
  category: string | null;
  name: string;
  aliases: string[];
  stock_total: number | null;
  stock_maint: number;
  price: number | null;
  state: string;
  note: string | null;
  verify_status: VerifyStatus;
  last_verified_at: string | null;
  last_verified_by: string | null;
  last_activity_at: string | null;
  open_issues: OpenIssue[];
};

type FilterKey = "all" | "attention" | "unverified" | "verified";

type VerifyDraft = { count: string; issueOn: boolean; issueLabel: string };

const STATUS_LABEL: Record<VerifyStatus, string> = {
  attention: "주의",
  unverified: "미검증",
  verified: "확인됨",
};
const STATUS_CHIP: Record<VerifyStatus, string> = {
  attention: "bg-attention-bg text-attention-fg",
  unverified: "bg-line/40 text-ink-mute",
  verified: "bg-checkin-bg text-checkin-fg",
};

function asVerifyStatus(v: unknown): VerifyStatus {
  return v === "verified" || v === "attention" ? v : "unverified";
}
function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => String(x ?? "")).filter(Boolean) : [];
}
function asIssues(v: unknown): OpenIssue[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
    .map((x) => ({
      label: String(x.label ?? ""),
      tradeId: x.tradeId != null ? String(x.tradeId) : undefined,
      at: x.at != null ? String(x.at) : undefined,
    }))
    .filter((x) => x.label);
}
/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
function rowFromDb(r: any): LedgerRow {
  return {
    equipment_id: String(r.equipment_id ?? ""),
    major: r.major ?? null,
    category: r.category ?? null,
    name: String(r.name ?? ""),
    aliases: asStringArray(r.aliases),
    stock_total: r.stock_total ?? null,
    stock_maint: Number(r.stock_maint) || 0,
    price: r.price ?? null,
    state: String(r.state ?? "정상"),
    note: r.note ?? null,
    verify_status: asVerifyStatus(r.verify_status),
    last_verified_at: r.last_verified_at ?? null,
    last_verified_by: r.last_verified_by ?? null,
    last_activity_at: r.last_activity_at ?? null,
    open_issues: asIssues(r.open_issues),
  };
}

function fmtMd(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

// 오늘 확인할 장비 우선순위: 주의(단가 높은 순) → 미검증(단가 높은 순) → 확인됨(확인이 오래된 순 = 롤링 재점검)
const byPriceDesc = (a: LedgerRow, b: LedgerRow) => (b.price ?? -1) - (a.price ?? -1);
const byOldestVerified = (a: LedgerRow, b: LedgerRow) => (a.last_verified_at ?? "").localeCompare(b.last_verified_at ?? "");
function todayPicks(rows: LedgerRow[], limit = 10): LedgerRow[] {
  const attention = rows.filter((r) => r.verify_status === "attention").sort(byPriceDesc);
  const unverified = rows.filter((r) => r.verify_status === "unverified").sort(byPriceDesc);
  const verified = rows.filter((r) => r.verify_status === "verified").sort(byOldestVerified);
  return [...attention, ...unverified, ...verified].slice(0, limit);
}

export function InventoryView() {
  const [rows, setRows] = useState<LedgerRow[]>([]);
  const [phase, setPhase] = useState<"loading" | "ready" | "unavailable">("loading");
  const [filter, setFilter] = useState<FilterKey>("all");
  const [q, setQ] = useState("");
  const [userEmail, setUserEmail] = useState<string | null>(null);

  // 확인(검증) 인라인 스테퍼 — 한 번에 한 행만 펼침. 같은 장비가 두 섹션에 보여도 누른 쪽만 펼침("섹션:장비ID")
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [draft, setDraft] = useState<VerifyDraft>({ count: "0", issueOn: false, issueLabel: "" });

  // 토스트 (뷰 로컬 — 스토어 저장 토스트와 동일 룩)
  const [toast, setToast] = useState<{ id: number; text: string; ok: boolean } | null>(null);
  const toastSeq = useRef(0);
  const showToast = useCallback((text: string, ok = true) => {
    const id = ++toastSeq.current;
    setToast({ id, text, ok });
    window.setTimeout(() => setToast((t) => (t?.id === id ? null : t)), 2000);
  }, []);

  const load = useCallback(async () => {
    if (!supabase) {
      setPhase("unavailable");
      return;
    }
    try {
      const { data, error } = await supabase.from("equipment_ledger").select("*").order("equipment_id");
      // 테이블 미생성(PGRST205/42P01) 포함 모든 에러 → 안내 문구로 강등 (크래시 금지)
      if (error) throw error;
      setRows((data ?? []).map(rowFromDb));
      setPhase("ready");
    } catch (e) {
      console.error("[inventory] 원장 로드 실패", e);
      setPhase("unavailable");
    }
  }, []);

  useEffect(() => {
    load();
    supabase?.auth.getSession().then(({ data }) => setUserEmail(data.session?.user?.email ?? null)).catch(() => {});
  }, [load]);

  const counts = useMemo(
    () => ({
      all: rows.length,
      attention: rows.filter((r) => r.verify_status === "attention").length,
      unverified: rows.filter((r) => r.verify_status === "unverified").length,
      verified: rows.filter((r) => r.verify_status === "verified").length,
    }),
    [rows],
  );
  const verifiedPct = counts.all ? Math.round((counts.verified / counts.all) * 100) : 0;

  const picks = useMemo(() => todayPicks(rows), [rows]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows.filter((r) => {
      if (filter !== "all" && r.verify_status !== filter) return false;
      if (!needle) return true;
      return (
        r.name.toLowerCase().includes(needle) ||
        r.equipment_id.toLowerCase().includes(needle) ||
        r.aliases.some((a) => a.toLowerCase().includes(needle))
      );
    });
  }, [rows, filter, q]);

  const openVerify = useCallback((section: string, r: LedgerRow) => {
    setOpenKey(`${section}:${r.equipment_id}`);
    setDraft({ count: String(r.stock_total ?? 0), issueOn: false, issueLabel: "" });
  }, []);

  const submitVerify = useCallback(
    async (row: LedgerRow) => {
      if (!supabase) return;
      const counted = Number(draft.count);
      if (!Number.isInteger(counted) || counted < 0) {
        showToast("수량을 숫자로 입력해주세요", false);
        return;
      }
      const nowIso = new Date().toISOString();
      const issueLabel = draft.issueOn ? draft.issueLabel.trim() || "문제 있음" : "";
      const nextStatus: VerifyStatus = draft.issueOn ? "attention" : "verified";
      const nextIssues = draft.issueOn ? [...row.open_issues, { label: issueLabel, at: nowIso }] : row.open_issues;
      const countChanged = row.stock_total !== counted;
      const before = { stock_total: row.stock_total, verify_status: row.verify_status };

      // 옵티미스틱 반영 + 스테퍼 닫기
      const prevRows = rows;
      setRows((prev) =>
        prev.map((r) =>
          r.equipment_id === row.equipment_id
            ? { ...r, stock_total: counted, verify_status: nextStatus, last_verified_at: nowIso, last_verified_by: userEmail, open_issues: nextIssues }
            : r,
        ),
      );
      setOpenKey(null);

      try {
        const { error } = await supabase
          .from("equipment_ledger")
          .update({
            stock_total: counted,
            verify_status: nextStatus,
            last_verified_at: nowIso,
            last_verified_by: userEmail,
            open_issues: nextIssues,
          })
          .eq("equipment_id", row.equipment_id);
        if (error) throw error;
        showToast(`확인 완료: ${row.name}`);
        // 이력은 부가 기록 — 실패해도 원장 반영은 유지 (콘솔에만 남김)
        const { error: evError } = await supabase.from("equipment_events").insert({
          equipment_id: row.equipment_id,
          type: countChanged ? "count_fixed" : "verified",
          payload: {
            before,
            after: { stock_total: counted, verify_status: nextStatus },
            ...(draft.issueOn ? { issue: issueLabel } : {}),
          },
          actor: userEmail,
        });
        if (evError) console.error("[inventory] 이벤트 기록 실패", evError);
      } catch (e) {
        console.error("[inventory] 확인 저장 실패", e);
        setRows(prevRows); // 롤백
        showToast("저장에 실패했어요 — 다시 시도해주세요", false);
      }
    },
    [draft, rows, userEmail, showToast],
  );

  return (
    <div className="flex min-h-screen flex-col bg-paper">
      <header className="safe-top sticky top-0 z-40 bg-paper/90 backdrop-blur-md ring-1 ring-line/70">
        <ViewHeader title="재고">
          <span className="hidden text-[12px] text-ink-faint sm:inline">재고관리대장</span>
          <button
            onClick={load}
            className={`tap flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white ring-1 ring-line/60 text-ink-soft ${phase === "loading" ? "animate-spin" : ""}`}
            title="새로고침"
          >
            <Refresh className="h-4 w-4" />
          </button>
        </ViewHeader>

        {phase === "ready" && (
          <div className="space-y-2 px-4 pb-2.5 pt-1">
            {/* 상태 칩 = 필터 */}
            <div className="flex flex-wrap items-center gap-1.5">
              <FilterChip label="전체" count={counts.all} active={filter === "all"} onClick={() => setFilter("all")} />
              <FilterChip label="주의" count={counts.attention} tone="attention" active={filter === "attention"} onClick={() => setFilter("attention")} />
              <FilterChip label="미검증" count={counts.unverified} tone="mute" active={filter === "unverified"} onClick={() => setFilter("unverified")} />
              <FilterChip label="확인됨" count={counts.verified} tone="ok" active={filter === "verified"} onClick={() => setFilter("verified")} />
            </div>

            {/* 검증률 진행바 */}
            <div>
              <div className="flex items-baseline justify-between text-[11.5px]">
                <span className="font-semibold text-ink-mute">대장 검증률</span>
                <span className="font-bold tabular-nums text-ink-soft">{verifiedPct}%</span>
              </div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-line/40">
                <div className="h-full rounded-full bg-checkin-fg" style={{ width: `${verifiedPct}%` }} />
              </div>
            </div>

            {/* 검색 */}
            <div className="flex items-center gap-2 rounded-lg bg-white px-3 py-2 ring-1 ring-line/60">
              <Search className="h-4 w-4 text-ink-faint" />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="장비명·ID·별칭 검색"
                className="flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-faint"
              />
              {q && <button onClick={() => setQ("")} className="text-ink-faint">✕</button>}
            </div>
          </div>
        )}
      </header>

      <main className="flex-1 space-y-3.5 p-3 pb-24">
        {phase === "loading" && <div className="py-16 text-center text-[14px] text-ink-faint">불러오는 중…</div>}

        {phase === "unavailable" && (
          <div className="rounded-xl bg-warn-bg px-3.5 py-4 ring-1 ring-warn-ring">
            <div className="text-[13.5px] font-bold text-warn-fg">재고 원장이 아직 준비되지 않았어요. 관리자에게 문의해주세요.</div>
            <button onClick={load} className="tap mt-2.5 rounded-lg bg-white px-3 py-1.5 text-[12.5px] font-bold text-ink-soft ring-1 ring-line/70">
              다시 시도
            </button>
          </div>
        )}

        {phase === "ready" && (
          <>
            {/* 오늘 확인할 장비 — 우선순위 10개 */}
            {filter === "all" && !q.trim() && picks.length > 0 && (
              <section>
                <div className="mb-2 flex items-baseline justify-between px-1">
                  <h2 className="text-[14px] font-bold text-ink-soft">오늘 확인할 장비</h2>
                  <span className="text-[12px] text-ink-mute">{picks.length}개</span>
                </div>
                <div className="overflow-hidden rounded-xl bg-white shadow-card ring-1 ring-line/70">
                  <div className="divide-y divide-line/60">
                    {picks.map((r) => (
                      <div key={r.equipment_id}>
                        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2.5 px-3 py-2.5">
                          <div className="min-w-0">
                            <div className="flex min-w-0 items-baseline gap-1.5">
                              <StatusChip status={r.verify_status} />
                              <span className="truncate text-[14px] font-bold text-ink">{r.name}</span>
                            </div>
                            <div className="mt-0.5 flex flex-wrap gap-x-2 text-[11.5px] text-ink-mute">
                              <span className="font-semibold text-ink-faint">{r.equipment_id}</span>
                              <span>{r.stock_total == null ? "보유 미기록" : `보유 ${r.stock_total}대`}</span>
                            </div>
                            {r.note && <div className="mt-0.5 truncate text-[11.5px] text-ink-mute">{r.note}</div>}
                          </div>
                          <VerifyButton onClick={() => openVerify("today", r)} />
                        </div>
                        {openKey === `today:${r.equipment_id}` && (
                          <VerifyPanel row={r} draft={draft} setDraft={setDraft} onCancel={() => setOpenKey(null)} onSubmit={() => submitVerify(r)} />
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              </section>
            )}

            {/* 전체 목록 */}
            <section>
              <div className="mb-2 flex items-baseline justify-between px-1">
                <h2 className="text-[14px] font-bold text-ink-soft">전체 장비</h2>
                <span className="text-[12px] text-ink-mute">{filtered.length}개</span>
              </div>
              <div className="overflow-hidden rounded-xl bg-white shadow-card ring-1 ring-line/70">
                {filtered.length === 0 ? (
                  <div className="px-3 py-5 text-center text-[12.5px] font-semibold text-ink-faint">조건에 맞는 장비가 없어요</div>
                ) : (
                  <div className="divide-y divide-line/60">
                    {filtered.map((r) => {
                      const issues = r.open_issues.map((i) => i.label).join(" · ");
                      return (
                        <div key={r.equipment_id}>
                          <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2.5 px-3 py-2.5">
                            <StatusChip status={r.verify_status} />
                            <div className="min-w-0">
                              <div className="flex min-w-0 items-baseline gap-1.5">
                                <span className="truncate text-[14px] font-bold text-ink">{r.name}</span>
                                <span className="shrink-0 text-[11px] font-semibold text-ink-faint">{r.equipment_id}</span>
                              </div>
                              <div className="mt-0.5 flex flex-wrap gap-x-2 text-[11.5px] text-ink-mute">
                                <span>{r.stock_total == null ? "보유 미기록" : `보유 ${r.stock_total}대`}</span>
                                {r.stock_maint > 0 && <span className="font-semibold text-warn-fg">정비 {r.stock_maint}대</span>}
                                {r.last_verified_at && <span>{fmtMd(r.last_verified_at)} 확인</span>}
                              </div>
                              {(r.note || issues) && (
                                <div className="mt-0.5 truncate text-[11.5px]">
                                  {issues && <span className="font-semibold text-attention-fg">{issues}</span>}
                                  {issues && r.note && <span className="text-ink-faint"> · </span>}
                                  {r.note && <span className="text-ink-mute">{r.note}</span>}
                                </div>
                              )}
                            </div>
                            <VerifyButton onClick={() => openVerify("list", r)} />
                          </div>
                          {openKey === `list:${r.equipment_id}` && (
                            <VerifyPanel row={r} draft={draft} setDraft={setDraft} onCancel={() => setOpenKey(null)} onSubmit={() => submitVerify(r)} />
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </section>
          </>
        )}
      </main>

      {toast && (
        <div
          key={toast.id}
          className={`animate-toast pointer-events-none fixed bottom-24 left-1/2 z-[60] flex -translate-x-1/2 items-center gap-2 rounded-full px-4 py-2 text-[13px] font-semibold text-white shadow-pop ${toast.ok ? "bg-ink" : "bg-attention-fg"}`}
        >
          {toast.ok && (
            <span className="flex h-4 w-4 items-center justify-center rounded-full bg-checkin-fg">
              <Check className="h-3 w-3" />
            </span>
          )}
          {toast.text}
        </div>
      )}
    </div>
  );
}

function StatusChip({ status }: { status: VerifyStatus }) {
  return <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold ${STATUS_CHIP[status]}`}>{STATUS_LABEL[status]}</span>;
}

function VerifyButton({ onClick }: { onClick: () => void }) {
  return (
    <button onClick={onClick} className="tap min-h-[32px] shrink-0 rounded-lg bg-brand-600 px-3 text-[12.5px] font-bold text-white">
      확인
    </button>
  );
}

function FilterChip({
  label, count, tone, active, onClick,
}: {
  label: string; count: number; tone?: "attention" | "mute" | "ok"; active: boolean; onClick: () => void;
}) {
  const toneCls =
    tone === "attention" ? "text-attention-fg" : tone === "ok" ? "text-checkin-fg" : tone === "mute" ? "text-ink-mute" : "text-ink-soft";
  return (
    <button
      onClick={onClick}
      className={`tap rounded-full px-2.5 py-1.5 text-[12px] font-bold ring-1 ${
        active ? "bg-brand-50 text-brand-700 ring-brand-200" : `bg-white ring-line/60 ${toneCls}`
      }`}
    >
      {label} <span className="tabular-nums">{count}</span>
    </button>
  );
}

// 확인 스테퍼 — 인라인 펼침. 수량 확인(기본 = 현재 보유수량) + 문제 있음 토글 + 확인 완료.
function VerifyPanel({
  row, draft, setDraft, onCancel, onSubmit,
}: {
  row: LedgerRow;
  draft: VerifyDraft;
  setDraft: React.Dispatch<React.SetStateAction<VerifyDraft>>;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const counted = Number(draft.count);
  const valid = Number.isInteger(counted) && counted >= 0 && draft.count.trim() !== "";
  const changed = valid && counted !== (row.stock_total ?? null);
  const step = (delta: number) =>
    setDraft((d) => {
      const cur = Number(d.count);
      const base = Number.isInteger(cur) ? cur : row.stock_total ?? 0;
      return { ...d, count: String(Math.max(0, base + delta)) };
    });

  return (
    <div className="animate-pop border-t border-line/60 bg-paper/70 px-3 py-3">
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="text-[12px] font-bold text-ink-mute">실물 수량</span>
        <div className="flex items-center gap-0.5 rounded-lg bg-white p-0.5 ring-1 ring-line/60">
          <button onClick={() => step(-1)} className="tap h-9 w-9 rounded-md text-[17px] font-black text-ink-soft" aria-label="수량 줄이기">−</button>
          <input
            inputMode="numeric"
            value={draft.count}
            onChange={(e) => setDraft((d) => ({ ...d, count: e.target.value.replace(/[^\d]/g, "") }))}
            className="w-12 bg-transparent text-center text-[16px] font-extrabold tabular-nums text-ink outline-none"
            aria-label="실물 수량"
          />
          <button onClick={() => step(1)} className="tap h-9 w-9 rounded-md text-[17px] font-black text-ink-soft" aria-label="수량 늘리기">＋</button>
        </div>
        <span className="text-[11.5px] text-ink-faint">
          {row.stock_total == null ? "장부 미기록" : `장부 ${row.stock_total}대`}
          {changed && <b className="ml-1 text-warn-fg">→ {counted}대로 수정</b>}
        </span>
        <button
          onClick={() => setDraft((d) => ({ ...d, issueOn: !d.issueOn }))}
          className={`tap min-h-[32px] rounded-lg px-2.5 text-[12px] font-bold ring-1 ${
            draft.issueOn ? "bg-attention-bg text-attention-fg ring-attention-ring" : "bg-white text-ink-mute ring-line/60"
          }`}
        >
          문제 있음
        </button>
      </div>

      {draft.issueOn && (
        <input
          value={draft.issueLabel}
          onChange={(e) => setDraft((d) => ({ ...d, issueLabel: e.target.value }))}
          placeholder="어떤 문제인가요? 예) 배터리 커버 파손"
          className="mt-2.5 w-full rounded-lg bg-white px-3 py-2.5 text-[13px] text-ink outline-none ring-1 ring-attention-ring placeholder:text-ink-faint"
          autoFocus
        />
      )}

      <div className="mt-2.5 flex gap-2">
        <button
          onClick={onSubmit}
          disabled={!valid}
          className="tap min-h-[38px] flex-1 rounded-lg bg-brand-600 px-3.5 text-[13.5px] font-bold text-white disabled:cursor-not-allowed disabled:opacity-50"
        >
          확인 완료
        </button>
        <button onClick={onCancel} className="tap min-h-[38px] rounded-lg px-3.5 text-[13.5px] font-bold text-ink-mute ring-1 ring-line/70">
          취소
        </button>
      </div>
    </div>
  );
}
