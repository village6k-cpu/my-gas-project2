"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { authFetch } from "@/lib/data/authFetch";
import { pollSheetChangesNow } from "@/lib/data/store";
import { ViewHeader } from "@/components/ViewHeader";
import { Refresh } from "@/components/icons";

const KakaoReservationInput = dynamic(
  () => import("@/components/KakaoReservationInput").then((mod) => mod.KakaoReservationInput),
  {
    ssr: false,
    loading: () => (
      <div className="rounded-xl2 bg-white p-3 text-[13px] font-bold text-ink-mute shadow-card ring-1 ring-line/70">
        카톡 예약입력 준비 중...
      </div>
    ),
  },
);

// 확인요청 관리 — GAS Schedule API(/api/confirm)를 네이티브로. 대기/보류 카드 목록 + 장비별 가용성 결과
// + 확인(가용성체크)/선택등록/전체보류/전체거절/수정. 디자인은 통합앱 토큰.

type Equip = { 장비명: string; 수량: number; 결과?: string; 상세?: string; 비고?: string; 제외?: boolean };
type ConfirmEquipmentRole = "set-header" | "set-component" | "single";
type ConfirmEquipmentRow = Equip & {
  role: ConfirmEquipmentRole;
  rowKey: string;
  groupName?: string;
  componentCount?: number;
};
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

const EMPTY_CONFIRM_EQUIPS: Equip[] = [];

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
  unknown: "bg-line/40 text-ink-mute",
  set: "bg-brand-50 text-brand-700",
  none: "bg-line/30 text-ink-faint",
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

function buildConfirmEquipmentRows(equips: Equip[]): ConfirmEquipmentRow[] {
  const rows: ConfirmEquipmentRow[] = [];
  let currentSetIndex = -1;

  equips.forEach((equip, index) => {
    if (equip.결과 === "세트") {
      currentSetIndex = rows.length;
      rows.push({
        ...equip,
        role: "set-header",
        rowKey: `set-header-${index}-${equip.장비명}`,
        groupName: equip.장비명,
        componentCount: 0,
      });
      return;
    }

    // 비고 마커("[세트]...")가 있으면 그것이 정답 — 순서 추정은 세트 뒤에 오는 단품을 구성품으로 오인함
    const hasMarkerInfo = typeof equip.비고 === "string";
    const markedComponent = hasMarkerInfo && equip.비고!.startsWith("[세트]");
    const parentCandidate = currentSetIndex >= 0 ? rows[currentSetIndex] : undefined;
    const isComponent = hasMarkerInfo ? markedComponent && !!parentCandidate : !!parentCandidate;
    if (hasMarkerInfo && !markedComponent) currentSetIndex = -1; // 단품 확정 → 세트 묶음 종료
    const parent = isComponent ? parentCandidate : undefined;
    if (parent) parent.componentCount = (parent.componentCount || 0) + 1;

    rows.push({
      ...equip,
      role: parent ? "set-component" : "single",
      rowKey: `${parent ? "set-component" : "single"}-${index}-${equip.장비명}`,
      groupName: parent?.장비명,
    });
  });

  return rows;
}

export function ConfirmView() {
  const [items, setItems] = useState<Req[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [edit, setEdit] = useState<Req | null>(null);
  const [itemEdit, setItemEdit] = useState<{ req: Req; item: Equip } | null>(null);
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
        void pollSheetChangesNow(); // 신규 거래를 오늘일정·검색에 즉시 반영
      } catch (e) {
        // 등록은 GAS에서 계속 진행되는데 응답만 시간초과로 끊기는 경우가 잦다 —
        // "실패"로 단정하지 말고 확인 안내 + 자동 재확인
        const msg = e instanceof Error ? e.message : String(e);
        const looksTimeout = /timeout|timed?\s?out|aborted|네트워크|fetch|504|502/i.test(msg);
        if (looksTimeout) {
          setError(`⏳ ${req.reqID} 등록 응답이 늦어지고 있어요. 등록 자체는 계속 진행 중일 수 있으니 잠시 후 목록이 자동 갱신되면 확인해주세요.`);
          setTimeout(() => {
            void load();
            void pollSheetChangesNow();
          }, 10_000);
        } else {
          setError(msg);
        }
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

  const cards = useMemo(
    () =>
      items.map((req) => (
        <ConfirmCard key={req.reqID} req={req} busy={busy === req.reqID} onAct={act} onRegisterSelected={registerSelected} onEdit={() => setEdit(req)} onItemEdit={(item) => setItemEdit({ req, item })} />
      )),
    [items, busy, act, registerSelected],
  );

  return (
    <div className="flex min-h-screen flex-col bg-paper">
      <header className="safe-top sticky top-0 z-40 bg-paper/90 backdrop-blur-md ring-1 ring-line/70">
        <ViewHeader title="확인요청">
          <span className="rounded-full bg-checkout-bg px-2.5 py-1 text-[12px] font-bold text-checkout-fg">대기 {items.length}건</span>
          <button onClick={load} className={`tap flex h-9 w-9 items-center justify-center rounded-full bg-white ring-1 ring-line/60 text-ink-soft ${loading ? "animate-spin" : ""}`} title="새로고침">
            <Refresh className="h-4 w-4" />
          </button>
        </ViewHeader>
      </header>

      <main className="flex-1 space-y-2.5 p-3 pb-24">
        <KakaoReservationInput onRequestCreated={load} />
        {error && <div className="rounded-xl bg-attention-bg px-3.5 py-2.5 text-[13px] font-medium text-attention-fg ring-1 ring-attention-ring">{error}</div>}
        {!items.length && !loading && !error && (
          <div className="rounded-xl2 border border-dashed border-line bg-white py-16 text-center">
            <div className="text-[15px] font-extrabold text-ink-soft">대기 중인 확인요청이 없습니다</div>
            <div className="mt-1.5 text-[13px] text-ink-mute">새 예약 요청이 들어오면 여기에 표시됩니다.</div>
          </div>
        )}
        {loading && !items.length && <div className="py-16 text-center text-[14px] text-ink-faint">불러오는 중…</div>}

        {cards}
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

      {itemEdit && (
        <ItemEditSheet
          req={itemEdit.req}
          item={itemEdit.item}
          onClose={() => setItemEdit(null)}
          onSaved={async () => {
            setItemEdit(null);
            await load();
          }}
          runFunc={runFunc}
        />
      )}
    </div>
  );
}

function ConfirmCard({
  req, busy, onAct, onRegisterSelected, onEdit, onItemEdit,
}: {
  req: Req; busy: boolean; onAct: (action: string, reqID: string) => void; onRegisterSelected: (req: Req, excluded: string[]) => void; onEdit: () => void; onItemEdit: (item: Equip) => void;
}) {
  const equips = req.장비목록 || EMPTY_CONFIRM_EQUIPS;
  const equipmentRows = useMemo(() => buildConfirmEquipmentRows(equips), [equips]);
  const status = (req.등록상태 || "").trim();
  const actionable = status === "대기" || status === "" || status === "AI_REVIEW" || status === "등록대기";
  const hasResult = equips.some((e) => e.결과 && e.결과 !== "");
  // 체크 상태: 기본 = 가용0/❌ 아닌 것만 체크
  const defaultChecked = useMemo(() => new Set(equipmentRows.filter((row) => row.role !== "set-header" && !isFail(row.결과) && !row.제외).map((row) => row.장비명)), [equipmentRows]);
  const [checked, setChecked] = useState<Set<string>>(defaultChecked);

  useEffect(() => {
    setChecked(defaultChecked);
  }, [defaultChecked]);

  const toggle = useCallback((name: string) =>
    setChecked((prev) => {
      const n = new Set(prev);
      if (n.has(name)) n.delete(name);
      else n.add(name);
      return n;
    }), []);

  const selectableEquips = useMemo(() => equipmentRows.filter((row) => row.role !== "set-header"), [equipmentRows]);
  const excluded = useMemo(() => selectableEquips.filter((e) => !checked.has(e.장비명)).map((e) => e.장비명), [selectableEquips, checked]);

  const barCls = STATUS_BAR[status] ?? "bg-checkout-fg";
  const chipCls = STATUS_CHIP[status] ?? "bg-checkout-bg text-checkout-fg";

  return (
    <article className="relative overflow-hidden rounded-xl2 bg-white p-3.5 shadow-card ring-1 ring-line/70">
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
            <button onClick={onEdit} className="tap shrink-0 rounded-lg bg-paper ring-1 ring-line/60 px-2.5 py-1.5 text-[12px] font-bold text-ink-soft">✎ 수정</button>
          )}
        </div>

        {/* 기간 */}
        {(req.반출일 || req.반납일) && (
          <div className="mt-2 rounded-lg bg-paper/70 px-3 py-2 text-[12.5px] font-semibold text-ink-soft">
            {req.반출일 || "?"} <span className="text-ink-faint">→</span> {req.반납일 || "?"}
          </div>
        )}

        {/* 장비 목록 */}
        <div className="mt-2 space-y-1.5">
          {equipmentRows.map((row) => {
            const tone = resultTone(row.결과);
            const isSetHeader = row.role === "set-header";
            const isSetComponent = row.role === "set-component";
            const sel = !isSetHeader && checked.has(row.장비명);
            const rowCls = isSetHeader
              ? "border border-line/60 bg-brand-50 px-3 py-2"
              : isSetComponent
                ? "ml-3 border border-line/70 border-l-2 border-l-brand-200 bg-white px-2.5 py-2"
                : "bg-paper/60 px-2 py-1.5";
            return (
              <div key={row.rowKey} data-confirm-role={row.role} className={`flex items-start gap-2 rounded-xl ${rowCls}`}>
                {isSetHeader ? (
                  <>
                    <span className="shrink-0 rounded-md bg-brand-600 px-2 py-0.5 text-[11px] font-extrabold text-white">세트</span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-1.5">
                        <span className="truncate text-[13.5px] font-extrabold text-brand-700">{row.장비명}</span>
                        {row.수량 > 1 && <span className="shrink-0 text-[12px] font-bold tabular-nums text-brand-700/80">×{row.수량}</span>}
                      </div>
                      {row.componentCount ? <div className="mt-0.5 text-[11px] font-semibold text-brand-700/65">구성품 {row.componentCount}개</div> : null}
                    </div>
                    {actionable && (
                      <button onClick={onEdit} className="tap shrink-0 rounded-md px-1.5 py-1 text-[12px] font-bold text-brand-700/70" aria-label="세트 수정(전체 편집)">✎</button>
                    )}
                  </>
                ) : (
                  <>
                    {actionable && hasResult && !row.제외 ? (
                      <input type="checkbox" checked={sel} onChange={() => toggle(row.장비명)} className="mt-0.5 h-[16px] w-[16px] shrink-0 accent-brand-600" aria-label="등록 선택" />
                    ) : (
                      <span className="mt-0.5 w-[16px] shrink-0" aria-hidden />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-baseline gap-1.5">
                        <span className={`truncate text-[13.5px] font-semibold ${row.제외 ? "text-ink-faint line-through" : isSetComponent ? "text-ink-soft" : "text-ink"}`}>{row.장비명}</span>
                        <span className="shrink-0 text-[12px] font-bold tabular-nums text-ink-soft">×{row.수량}</span>
                      </div>
                      {row.상세 && <div className="truncate text-[11px] text-ink-faint">{row.상세}</div>}
                    </div>
                    {row.제외 && <span className="shrink-0 rounded-full bg-attention-bg px-2 py-0.5 text-[10.5px] font-bold text-attention-fg">제외</span>}
                    {!row.제외 && row.결과 && <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-bold ${RESULT_CLS[tone]}`}>{row.결과}</span>}
                    {actionable && (
                      <button onClick={() => onItemEdit(row)} className="tap shrink-0 rounded-md px-1.5 py-1 text-[12px] font-bold text-ink-faint" aria-label="품목 수정">✎</button>
                    )}
                  </>
                )}
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
      className={`tap min-h-[38px] flex-1 rounded-lg px-3 text-[13px] font-bold disabled:opacity-50 ${primary ? "bg-brand-600 text-white" : ghost ? "text-attention-fg ring-1 ring-attention-ring" : "bg-white text-ink-soft ring-1 ring-line"}`}
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
  // 세트는 세트명(헤더)으로 보존하고 구성품은 제외 — 저장 시 GAS가 세트를 다시 전개하므로
  // 구성품을 단품으로 보내면 세트 구조·세트 단가가 소실된다
  const [equips, setEquips] = useState<{ 이름: string; 수량: string }[]>(
    buildConfirmEquipmentRows(req.장비목록 || [])
      .filter((r) => r.role !== "set-component")
      .map((r) => ({ 이름: r.장비명, 수량: String(r.수량 || 1) })),
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
          color: #1a1a1a;
          outline: none;
        }
        .inp:focus {
          border-color: #e8593c;
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

/** 품목 한 줄만 수정 — 이름/수량 변경 시 그 품목만 가용성 재확인, 제외(보류) 토글 (오늘 대시보드와 동일 UX) */
function ItemEditSheet({
  req, item, onClose, onSaved, runFunc,
}: {
  req: Req; item: Equip; onClose: () => void; onSaved: () => void; runFunc: (func: string, args: Record<string, unknown>) => Promise<boolean>;
}) {
  const [name, setName] = useState(item.장비명);
  const [qty, setQty] = useState(String(item.수량 || 1));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const call = async (args: Record<string, unknown>) => {
    setBusy(true);
    setErr("");
    try {
      await runFunc("updateRequestItem", { reqID: req.reqID, 장비명: item.장비명, ...args });
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const save = () => {
    const q = Number(qty);
    if (!name.trim() || !Number.isFinite(q) || q < 1) {
      setErr("이름과 1 이상의 수량을 입력하세요");
      return;
    }
    void call({ 새이름: name.trim(), 수량: q });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40" onClick={onClose}>
      <div className="animate-pop w-full max-w-lg rounded-t-2xl bg-white p-4 pb-8" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="truncate text-[15px] font-extrabold text-ink">품목 수정 · {item.장비명}</h3>
          <button onClick={onClose} className="tap rounded-lg px-2 py-1 text-ink-faint">✕</button>
        </div>
        <div className="space-y-2.5">
          <div className="flex items-center gap-1.5">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="장비명" className="itm-inp flex-1" />
            <input value={qty} onChange={(e) => setQty(e.target.value)} className="itm-inp w-16 text-center" inputMode="numeric" aria-label="수량" />
          </div>
          {err && <p className="text-[12px] font-bold text-attention-fg">{err}</p>}
          <button disabled={busy} onClick={save} className="tap w-full rounded-xl bg-brand-600 py-3 text-[14px] font-extrabold text-white disabled:opacity-50">
            {busy ? "처리 중…" : "저장 + 이 품목만 재확인"}
          </button>
          {item.제외 ? (
            <button disabled={busy} onClick={() => void call({ 제외: false })} className="tap w-full rounded-xl bg-paper py-3 text-[14px] font-extrabold text-ink-soft ring-1 ring-line disabled:opacity-50">
              제외 해제 (다시 등록 대상에 포함)
            </button>
          ) : (
            <button disabled={busy} onClick={() => void call({ 제외: true })} className="tap w-full rounded-xl bg-attention-bg py-3 text-[14px] font-extrabold text-attention-fg disabled:opacity-50">
              이 품목 제외 (등록에서 빼기)
            </button>
          )}
          <p className="text-[11px] text-ink-faint">이름·수량을 바꾸면 이 품목만 다시 가용성을 확인합니다. 다른 품목 결과는 그대로 유지됩니다.</p>
        </div>
      </div>
      <style jsx>{`
        .itm-inp {
          border: 1px solid rgba(0, 0, 0, 0.12);
          border-radius: 0.6rem;
          padding: 0.55rem 0.7rem;
          font-size: 13.5px;
          color: #1a1a1a;
          outline: none;
        }
        .itm-inp:focus {
          border-color: #e8593c;
        }
      `}</style>
    </div>
  );
}
