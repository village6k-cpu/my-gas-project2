"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { authFetch } from "@/lib/data/authFetch";
import { ViewHeader } from "@/components/ViewHeader";
import { Refresh } from "@/components/icons";

// 확인요청 관리 — GAS Schedule API(/api/confirm)를 네이티브로. 대기/보류 카드 목록 + 장비별 가용성 결과
// + 확인(가용성체크)/선택등록/전체보류/전체거절/수정. 디자인은 통합앱 토큰.

type Equip = { 장비명: string; 수량: number; 결과?: string; 상세?: string };
type Req = {
  reqID: string;
   반출일?: string;
   반납일?: string;
   예약자명?: string;
   연락처?: string;
   업체명?: string;
   장비목록?: Equip[];
   추가요청?: string;
   등록상태?: string;
};

function resultTone(r?: string): "ok" | "warn" | "fail" | "unknown" | "set" | "none" {
  if (!r) return "none";
  if (r === "세트") return "set";
  if (/❌|가용0|없음/.test(r)) return "fail";
  if (/❓|미등록|모델/.test(r)) return "unknown";
  if (/⚠|부족|겹침/.test(r)) return "warn";
  if (/✅|가용/.test(r)) return "ok";
  return "none";
}
const RESULT_CLS: Record<string, string> = {
  ok: "bg-checkin-bg text-checkin-fg",
  warn: "bg-warn-bg text-warn-fg",
  fail: "bg-attention-bg text-attention-fg",
  unknown: "bg-black/[0.05] text-ink-mute",
  set: "bg-brand-50 text-brand-700",
  none: "bg-black/[0.03] text-ink-faint",
};
const STATUS_BAR: Record<string, string> = {
  대기: "bg-checkout-fg",
  "": "bg-checkout-fg",
  보류: "bg-warn-fg",
  AI_REVIEW: "bg-brand-500",
  등록대기: "bg-checkout-fg",
};
const STATUS_CHIP: Record<string, string> = {
  대기: "bg-checkout-bg text-checkout-fg",
  "": "bg-checkout-bg text-checkout-fg",
  보류: "bg-warn-bg text-warn-fg",
  AI_REVIEW: "bg-brand-50 text-brand-700",
  등록대기: "bg-checkout-bg text-checkout-fg",
};

function isFail(r?: string) {
  return /❌|가용0/.test(r || "");
}

export function ConfirmView() {
  const [items, setItems] = useState<Req[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [edit, setEdit] = useState<Req | null>(null);
  const loadingRef = useRef(false);

  const load = useCallback(async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    setError("");
    try {
      const res = await authFetch("/api/confirm?action=list");
      const json = await res.json();
      if (!res.ok || (json.status && json.status !== "OK")) throw new Error(json.error || json.message || "불러오기 실패");
      setItems(Array.isArray(json.items) ? json.items : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // 액션 실행 (확인/등록/보류/거절) — POST /api/confirm
  const doAction = useCallback(
    async (action: string, reqID: string): Promise<boolean> => {
      setBusy(reqID);
      setError("");
      try {
        const res = await authFetch("/api/confirm", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action, reqID }),
        });
        const json = await res.json().catch(() => ({}));
        const ok = json.status === "OK" || json.success;
        if (!res.ok || !ok) throw new Error(json.message || json.error || `${action} 실패`);
        return true;
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        return false;
      } finally {
        setBusy(null);
      }
    },
    [],
  );

  const runFunc = useCallback(async (func: string, args: Record<string, unknown>): Promise<boolean> => {
    const res = await authFetch("/api/confirm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "run", func, args }),
    });
    const json = await res.json().catch(() => ({}));
    const ok = json.success || json.status === "OK" || json.result?.status === "OK";
    if (!res.ok || !ok) throw new Error(json.error || json.message || `${func} 실패`);
    return true;
  }, []);

  // 선택 등록: 제외 장비 보류 처리 후 등록
  const registerSelected = useCallback(
    async (req: Req, excluded: string[]) => {
      setBusy(req.reqID);
      setError("");
      try {
        if (excluded.length) await runFunc("excludeEquipFromRequest", { reqID: req.reqID, 제외장비: excluded });
        const res = await authFetch("/api/confirm", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "등록", reqID: req.reqID }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok || json.status !== "OK") throw new Error(json.message || json.error || "등록 실패");
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(null);
      }
    },
    [runFunc, load],
  );

  const act = useCallback(
    async (action: string, reqID: string) => {
      const ok = await doAction(action, reqID);
      if (ok) setTimeout(load, 600);
    },
    [doAction, load],
  );

  return (
    <div className="flex min-h-screen flex-col bg-[#f6f5f2]">
      <header className="safe-top sticky top-0 z-40 bg-white/90 backdrop-blur-md ring-1 ring-black/5">
        <ViewHeader title="확인요청">
          <span className="rounded-full bg-checkout-bg px-2.5 py-1 text-[12px] font-bold text-checkout-fg">대기 {items.length}건</span>
          <button onClick={load} className={`tap flex h-9 w-9 items-center justify-center rounded-full bg-black/[0.04] text-ink-soft ${loading ? "animate-spin" : ""}`} title="새로고침">
            <Refresh className="h-4 w-4" />
          </button>
        </ViewHeader>
      </header>

      <main className="flex-1 space-y-2.5 p-3 pb-24">
        {error && <div className="rounded-xl bg-attention-bg px-3.5 py-2.5 text-[13px] font-medium text-attention-fg ring-1 ring-attention-ring">{error}</div>}
        {!items.length && !loading && !error && (
          <div className="rounded-xl2 border border-dashed border-black/10 bg-white py-16 text-center">
            <div className="text-[15px] font-extrabold text-ink-soft">대기 중인 확인요청이 없습니다</div>
            <div className="mt-1.5 text-[13px] text-ink-mute">새 예약 요청이 들어오면 여기에 표시됩니다.</div>
          </div>
        )}
        {loading && !items.length && <div className="py-16 text-center text-[14px] text-ink-faint">불러오는 중…</div>}

        {items.map((req) => (
          <ConfirmCard key={req.reqID} req={req} busy={busy === req.reqID} onAct={act} onRegisterSelected={registerSelected} onEdit={() => setEdit(req)} />
        ))}
      </main>

      {edit && (
        <EditPanel
          req={edit}
          onClose={() => setEdit(null)}
          onSaved={async () => {
            setEdit(null);
            await load();
          }}
          runFunc={runFunc}
          setError={setError}
        />
      )}
    </div>
  );
}

function ConfirmCard({
  req, busy, onAct, onRegisterSelected, onEdit,
}: {
  req: Req; busy: boolean; onAct: (action: string, reqID: string) => void; onRegisterSelected: (req: Req, excluded: string[]) => void; onEdit: () => void;
}) {
  const equips = req.장비목록 || [];
  const status = (req.등록상태 || "").trim();
  const actionable = status === "대기" || status === "" || status === "AI_REVIEW" || status === "등록대기";
  const hasResult = equips.some((e) => e.결과 && e.결과 !== "");
  // 체크 상태: 기본 = 가용0/❌ 아닌 것만 체크
  const [checked, setChecked] = useState<Set<string>>(() => new Set(equips.filter((e) => e.결과 !== "세트" && !isFail(e.결과)).map((e) => e.장비명)));

  const toggle = (name: string) =>
    setChecked((prev) => {
      const n = new Set(prev);
      if (n.has(name)) n.delete(name);
      else n.add(name);
      return n;
    });

  const selectableEquips = equips.filter((e) => e.결과 !== "세트");
  const excluded = selectableEquips.filter((e) => !checked.has(e.장비명)).map((e) => e.장비명);

  const barCls = STATUS_BAR[status] ?? "bg-checkout-fg";
  const chipCls = STATUS_CHIP[status] ?? "bg-checkout-bg text-checkout-fg";

  return (
    <article className="relative overflow-hidden rounded-xl2 bg-white p-3.5 shadow-card ring-1 ring-black/5">
      <span className={`absolute inset-y-0 left-0 w-1 ${barCls}`} aria-hidden />
      <div className="pl-1.5">
        {/* 헤더 */}
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-[15px] font-extrabold text-ink">{req.예약자명 || "예약자 미상"}</span>
              <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${chipCls}`}>{status || "대기"}</span>
            </div>
            <div className="mt-0.5 text-[11.5px] text-ink-faint">
              {req.reqID}
              {req.업체명 && req.업체명 !== "일반" ? ` · ${req.업체명}` : ""}
              {req.연락처 ? ` · ${req.연락처}` : ""}
            </div>
          </div>
          {actionable && (
            <button onClick={onEdit} className="tap shrink-0 rounded-lg bg-black/[0.04] px-2.5 py-1.5 text-[12px] font-bold text-ink-soft">✎ 수정</button>
          )}
        </div>

        {/* 기간 */}
        {(req.반출일 || req.반납일) && (
          <div className="mt-2 rounded-lg bg-black/[0.02] px-3 py-2 text-[12.5px] font-semibold text-ink-soft">
            {req.반출일 || "?"} <span className="text-ink-faint">→</span> {req.반납일 || "?"}
          </div>
        )}

        {/* 장비 목록 */}
        <div className="mt-2 space-y-1">
          {equips.map((e, i) => {
            const tone = resultTone(e.결과);
            const isSet = e.결과 === "세트";
            const sel = !isSet && checked.has(e.장비명);
            return (
              <div key={i} className={`flex items-start gap-2 rounded-lg px-2 py-1.5 ${isSet ? "bg-brand-50/50" : "bg-black/[0.015]"}`}>
                {actionable && hasResult && !isSet ? (
                  <input type="checkbox" checked={sel} onChange={() => toggle(e.장비명)} className="mt-0.5 h-[16px] w-[16px] shrink-0 accent-brand-600" aria-label="등록 선택" />
                ) : (
                  <span className="mt-0.5 w-[16px] shrink-0" aria-hidden />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-1.5">
                    <span className={`truncate text-[13.5px] ${isSet ? "font-extrabold text-brand-700" : "font-semibold text-ink"}`}>{e.장비명}</span>
                    <span className="shrink-0 text-[12px] font-bold tabular-nums text-ink-soft">×{e.수량}</span>
                  </div>
                  {e.상세 && <div className="truncate text-[11px] text-ink-faint">{e.상세}</div>}
                </div>
                {e.결과 && <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-bold ${RESULT_CLS[tone]}`}>{e.결과}</span>}
              </div>
            );
          })}
        </div>

        {req.추가요청 && <div className="mt-2 rounded-lg bg-warn-bg/60 px-3 py-2 text-[12px] text-warn-fg ring-1 ring-warn-ring">추가요청: {req.추가요청}</div>}

        {/* 액션 */}
        {actionable && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {!hasResult ? (
              <Btn primary disabled={busy} onClick={() => onAct("확인", req.reqID)}>{busy ? "처리 중…" : "확인 (가용성 체크)"}</Btn>
            ) : (
              <>
                <Btn
                  primary
                  disabled={busy}
                  onClick={() => {
                    const total = selectableEquips.length;
                    const sel = total - excluded.length;
                    const msg = excluded.length ? `${sel}/${total}개 장비를 등록합니다.\n제외: ${excluded.join(", ")}` : `${total}개 장비를 모두 등록합니다.`;
                    if (confirm(msg)) onRegisterSelected(req, excluded);
                  }}
                >
                  {busy ? "처리 중…" : excluded.length ? `선택 등록 (${selectableEquips.length - excluded.length})` : "전체 등록"}
                </Btn>
                <Btn disabled={busy} onClick={() => onAct("보류", req.reqID)}>전체 보류</Btn>
                <Btn ghost disabled={busy} onClick={() => { if (confirm("이 요청을 거절할까요?")) onAct("거절", req.reqID); }}>전체 거절</Btn>
              </>
            )}
          </div>
        )}
      </div>
    </article>
  );
}

function Btn({ children, onClick, primary, ghost, disabled }: { children: ReactNode; onClick: () => void; primary?: boolean; ghost?: boolean; disabled?: boolean }) {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      className={`tap min-h-[38px] flex-1 rounded-lg px-3 text-[13px] font-bold disabled:opacity-50 ${primary ? "bg-brand-600 text-white" : ghost ? "text-attention-fg ring-1 ring-attention-ring" : "bg-white text-ink-soft ring-1 ring-black/10"}`}
    >
      {children}
    </button>
  );
}

// 수정 패널 (바텀시트)
function EditPanel({
  req, onClose, onSaved, runFunc, setError,
}: {
  req: Req; onClose: () => void; onSaved: () => void; runFunc: (func: string, args: Record<string, unknown>) => Promise<boolean>; setError: (s: string) => void;
}) {
  const splitDT = (s?: string) => {
    const [d, t] = String(s || "").split(" ");
    return { d: d || "", t: t || "" };
  };
  const out = splitDT(req.반출일);
  const ret = splitDT(req.반납일);
  const [name, setName] = useState(req.예약자명 || "");
  const [phone, setPhone] = useState(req.연락처 || "");
  const [outD, setOutD] = useState(out.d);
  const [outT, setOutT] = useState(out.t);
  const [retD, setRetD] = useState(ret.d);
  const [retT, setRetT] = useState(ret.t);
  const [equips, setEquips] = useState<{ 이름: string; 수량: string }[]>(
    (req.장비목록 || []).filter((e) => e.결과 !== "세트").map((e) => ({ 이름: e.장비명, 수량: String(e.수량 || 1) })),
  );
  const [saving, setSaving] = useState(false);

  const setEq = (i: number, k: "이름" | "수량", v: string) => setEquips((prev) => prev.map((e, j) => (j === i ? { ...e, [k]: v } : e)));
  const addEq = () => setEquips((prev) => [...prev, { 이름: "", 수량: "1" }]);
  const delEq = (i: number) => setEquips((prev) => prev.filter((_, j) => j !== i));

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      const args: Record<string, unknown> = {
        reqID: req.reqID,
        예약자명: name,
        연락처: phone,
        반출일: outD,
        반출시간: outT,
        반납일: retD,
        반납시간: retT,
        장비: equips.filter((e) => e.이름.trim()).map((e) => ({ 이름: e.이름.trim(), 수량: e.수량 })),
      };
      await runFunc("updateRequest", args);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40" onClick={onClose}>
      <div className="animate-pop max-h-[88vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-white p-4 pb-8" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-[16px] font-extrabold text-ink">요청 수정 · {req.예약자명}</h3>
          <button onClick={onClose} className="tap rounded-lg px-2 py-1 text-ink-faint">✕</button>
        </div>
        <div className="space-y-2.5">
          <Field label="예약자명"><input value={name} onChange={(e) => setName(e.target.value)} className="inp" /></Field>
          <Field label="연락처"><input value={phone} onChange={(e) => setPhone(e.target.value)} className="inp" /></Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="반출일"><input type="date" value={outD} onChange={(e) => setOutD(e.target.value)} className="inp" /></Field>
            <Field label="반출시간"><input type="time" value={outT} onChange={(e) => setOutT(e.target.value)} className="inp" /></Field>
            <Field label="반납일"><input type="date" value={retD} onChange={(e) => setRetD(e.target.value)} className="inp" /></Field>
            <Field label="반납시간"><input type="time" value={retT} onChange={(e) => setRetT(e.target.value)} className="inp" /></Field>
          </div>
          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-[12px] font-bold text-ink-mute">장비 목록</span>
              <button onClick={addEq} className="tap rounded-md bg-brand-50 px-2 py-1 text-[12px] font-bold text-brand-700">+ 추가</button>
            </div>
            <div className="space-y-1.5">
              {equips.map((e, i) => (
                <div key={i} className="flex items-center gap-1.5">
                  <input value={e.이름} onChange={(ev) => setEq(i, "이름", ev.target.value)} placeholder="장비명" className="inp flex-1" />
                  <input value={e.수량} onChange={(ev) => setEq(i, "수량", ev.target.value)} className="inp w-16 text-center" inputMode="numeric" />
                  <button onClick={() => delEq(i)} className="tap px-2 text-ink-faint">✕</button>
                </div>
              ))}
            </div>
            <p className="mt-1.5 text-[11px] text-ink-faint">장비를 바꾸면 기존 행을 지우고 다시 입력 후 가용성을 재확인합니다.</p>
          </div>
          <button disabled={saving} onClick={save} className="tap mt-1 w-full rounded-xl bg-brand-600 py-3 text-[14px] font-extrabold text-white disabled:opacity-50">
            {saving ? "저장 중…" : "저장 + 가용성 재확인"}
          </button>
        </div>
      </div>
      <style jsx>{`
        .inp {
          width: 100%;
          border: 1px solid rgba(0, 0, 0, 0.12);
          border-radius: 0.6rem;
          padding: 0.55rem 0.7rem;
          font-size: 13.5px;
          color: #16181d;
          outline: none;
        }
        .inp:focus {
          border-color: #6366f1;
        }
      `}</style>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[12px] font-bold text-ink-mute">{label}</span>
      {children}
    </label>
  );
}
