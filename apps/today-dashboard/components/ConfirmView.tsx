"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { authFetch } from "@/lib/data/authFetch";
import { useEquipmentCatalog } from "@/lib/data/equipmentCatalog";
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

type Equip = { 장비명: string; 수량: number; 결과?: string; 상세?: string; 비고?: string; 제외?: boolean; 순번?: number };
type ConfirmEquipmentRole = "set-header" | "set-component" | "single";
type ConfirmEquipmentRow = Equip & {
  role: ConfirmEquipmentRole;
  rowKey: string;
  sourceIndex: number;
  groupName?: string;
  componentCount?: number;
};
type ExcludedConfirmItem = { 장비명: string; 비고: string; 순번: number };
type Req = {
  reqID: string;
   반출일?: string;
   반출시간?: string;
   반납일?: string;
   반납시간?: string;
   예약자명?: string;
   연락처?: string;
   업체명?: string;
   할인유형?: string;
   장비목록?: Equip[];
   추가요청?: string;
   등록상태?: string;
};

// 확인요청 M열(할인유형) 선택값. 단골/제휴는 보통 고객DB로 자동 판정되지만,
// 사장이 직접 지정할 수 있어야 하므로 전부 노출한다.
const DISCOUNT_OPTIONS = ["일반", "학생", "개인사업자/프리랜서", "단골", "제휴"];

const EMPTY_CONFIRM_EQUIPS: Equip[] = [];
const CONFIRM_LIST_CACHE_KEY = "village-confirm-list-cache-v1";

function readConfirmListCache(): Req[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.sessionStorage.getItem(CONFIRM_LIST_CACHE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.items) ? parsed.items : [];
  } catch {
    return [];
  }
}

function writeConfirmListCache(items: Req[]) {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(CONFIRM_LIST_CACHE_KEY, JSON.stringify({ items, cachedAt: Date.now() }));
  } catch {
    // 저장소가 막혀도 확인요청 자체는 계속 동작해야 한다.
  }
}

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

function normalizeRegisterStatus(status?: string) {
  const s = (status || "").trim().replace(/^⏳\s*/, "").replace(/\s+/g, " ");
  if (/^등록\s*대기/.test(s) || s === "등록대기") return "등록대기";
  if (/^등록\s*처리\s*중/.test(s) || /^등록\s*처리중/.test(s)) return "등록대기";
  return s;
}

function isConfirmRequestTerminalStatus(status?: string) {
  const s = normalizeRegisterStatus(status);
  return /^등록완료/.test(s) || s === "거절" || s === "보류" || /^⚠️?\s*이미 등록/.test(s);
}

function isConfirmRequestWorkingStatus(status?: string) {
  const s = normalizeRegisterStatus(status);
  return /개고생2\.0|계약서|입력\s*중|생성\s*중/.test(s);
}

function canEditConfirmRequest(status?: string) {
  const s = normalizeRegisterStatus(status);
  if (!s || s === "대기" || s === "AI_REVIEW" || s === "등록대기") return true;
  if (isConfirmRequestTerminalStatus(s) || isConfirmRequestWorkingStatus(s)) return false;
  return true;
}

function statusBarClass(status?: string) {
  const s = normalizeRegisterStatus(status);
  if (STATUS_BAR[s] !== undefined) return STATUS_BAR[s];
  if (/^❌|등록\s*불가|등록\s*실패/.test(s)) return "bg-attention-fg";
  if (/모델|미등록|필요|부족|중복|날짜|연락처|예약자/.test(s)) return "bg-warn-fg";
  return "bg-checkout-fg";
}

function statusChipClass(status?: string) {
  const s = normalizeRegisterStatus(status);
  if (STATUS_CHIP[s] !== undefined) return STATUS_CHIP[s];
  if (/^❌|등록\s*불가|등록\s*실패/.test(s)) return "bg-attention-bg text-attention-fg";
  if (/모델|미등록|필요|부족|중복|날짜|연락처|예약자/.test(s)) return "bg-warn-bg text-warn-fg";
  return "bg-checkout-bg text-checkout-fg";
}

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
        sourceIndex: index,
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
      sourceIndex: index,
      groupName: parent?.장비명,
    });
  });

  return rows;
}

export function ConfirmView() {
  const [items, setItems] = useState<Req[]>(() => readConfirmListCache());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [busyReqIDs, setBusyReqIDs] = useState<Set<string>>(() => new Set());
  const [queuedRegisterIDs, setQueuedRegisterIDs] = useState<string[]>([]);
  const [showKakaoInput, setShowKakaoInput] = useState(false);
  const [edit, setEdit] = useState<Req | null>(null);
  const [itemEdit, setItemEdit] = useState<{ req: Req; item: Equip } | null>(null);
  const loadingRef = useRef(false);
  const registerQueueRef = useRef<Promise<void>>(Promise.resolve());
  const queuedRegisterSetRef = useRef<Set<string>>(new Set());

  const setReqBusy = useCallback((reqID: string, nextBusy: boolean) => {
    setBusyReqIDs((prev) => {
      const next = new Set(prev);
      if (nextBusy) next.add(reqID);
      else next.delete(reqID);
      return next;
    });
  }, []);

  const load = useCallback(async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    setError("");
    try {
      const res = await authFetch("/api/confirm?action=list");
      const json = await res.json();
      if (!res.ok || (json.status && json.status !== "OK")) throw new Error(json.error || json.message || "불러오기 실패");
      const nextItems = Array.isArray(json.items) ? json.items : [];
      setItems(nextItems);
      writeConfirmListCache(nextItems);
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
      setReqBusy(reqID, true);
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
        setReqBusy(reqID, false);
      }
    },
    [setReqBusy],
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
  const registerSelectedNow = useCallback(
    async (req: Req, excludedItems: ExcludedConfirmItem[]) => {
      setReqBusy(req.reqID, true);
      setError("");
      try {
        for (const excluded of excludedItems) {
          await runFunc("updateRequestItem", {
            reqID: req.reqID,
            장비명: excluded.장비명,
            비고: excluded.비고,
            순번: excluded.순번,
            제외: true,
          });
        }
        const res = await authFetch("/api/confirm", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "registerAsync", reqID: req.reqID }),
        });
        const json = await res.json().catch(() => ({}));
        const ok = json.status === "OK" || json.success === true;
        if (!res.ok || !ok) throw new Error(json.message || json.error || "등록 대기열 등록 실패");
        await load();
        setTimeout(() => void load(), 3_000);
        setTimeout(() => {
          void load();
          void pollSheetChangesNow();
        }, 15_000);
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
        setReqBusy(req.reqID, false);
      }
    },
    [runFunc, load, setReqBusy],
  );

  const registerSelected = useCallback(
    (req: Req, excludedItems: ExcludedConfirmItem[]) => {
      if (queuedRegisterSetRef.current.has(req.reqID)) {
        setError(`${req.reqID}는 이미 등록 대기열에 들어가 있습니다.`);
        return;
      }
      queuedRegisterSetRef.current.add(req.reqID);
      setQueuedRegisterIDs((prev) => [...prev, req.reqID]);
      registerQueueRef.current = registerQueueRef.current
        .catch(() => undefined)
        .then(async () => {
          await registerSelectedNow(req, excludedItems);
        })
        .finally(() => {
          queuedRegisterSetRef.current.delete(req.reqID);
          setQueuedRegisterIDs((prev) => prev.filter((id) => id !== req.reqID));
        });
    },
    [registerSelectedNow],
  );

  const act = useCallback(
    async (action: string, reqID: string) => {
      const ok = await doAction(action, reqID);
      if (ok) setTimeout(load, 600);
    },
    [doAction, load],
  );

  const handleKakaoRequestCreated = useCallback(async () => {
    await load();
    setShowKakaoInput(false);
  }, [load]);

  const cards = useMemo(
    () =>
      items.map((req) => (
        <ConfirmCard
          key={req.reqID}
          req={req}
          busy={busyReqIDs.has(req.reqID)}
          queueIndex={queuedRegisterIDs.indexOf(req.reqID)}
          onAct={act}
          onRegisterSelected={registerSelected}
          onEdit={() => setEdit(req)}
          onItemSaved={load}
          runFunc={runFunc}
        />
      )),
    [items, busyReqIDs, queuedRegisterIDs, act, registerSelected, load, runFunc],
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
        {showKakaoInput ? (
          <KakaoReservationInput onRequestCreated={handleKakaoRequestCreated} />
        ) : (
          <button
            type="button"
            onClick={() => setShowKakaoInput(true)}
            className="tap flex w-full items-center justify-between rounded-xl2 bg-white px-3.5 py-3 text-left shadow-card ring-1 ring-line/70"
          >
            <span>
              <span className="block text-[13px] font-extrabold text-ink">카톡 예약입력</span>
              <span className="block text-[12px] font-semibold text-ink-faint">필요할 때만 열어서 확인요청 목록을 빠르게 유지합니다</span>
            </span>
            <span className="rounded-full bg-brand-50 px-2.5 py-1 text-[12px] font-extrabold text-brand-700">열기</span>
          </button>
        )}
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
  req, busy, queueIndex, onAct, onRegisterSelected, onEdit, onItemSaved, runFunc,
}: {
  req: Req;
  busy: boolean;
  queueIndex: number;
  onAct: (action: string, reqID: string) => void;
  onRegisterSelected: (req: Req, excludedItems: ExcludedConfirmItem[]) => void;
  onEdit: () => void;
  onItemSaved: () => void | Promise<void>;
  runFunc: (func: string, args: Record<string, unknown>) => Promise<boolean>;
}) {
  // 같은 장비명이 여러 행일 때 정확한 행을 지정하기 위한 동명 순번 (시트 행 순서 = 장비목록 순서)
  const itemOrdinal = useCallback((row: ConfirmEquipmentRow) => {
    const list = req.장비목록 || [];
    return list.slice(0, row.sourceIndex).filter((e) => e.장비명 === row.장비명 && String(e.비고 || "") === String(row.비고 || "")).length;
  }, [req.장비목록]);
  const equips = req.장비목록 || EMPTY_CONFIRM_EQUIPS;
  const equipmentRows = useMemo(() => buildConfirmEquipmentRows(equips), [equips]);
  const status = normalizeRegisterStatus(req.등록상태);
  const queuedStatus = status === "등록대기";
  const actionable = queuedStatus || canEditConfirmRequest(status);
  const hasResult = equips.some((e) => e.결과 && e.결과 !== "");
  // 체크 상태: 기본 = 가용0/❌ 아닌 것만 체크
  const defaultCheckedKeys = useMemo(
    () => equipmentRows.filter((row) => row.role !== "set-header" && !isFail(row.결과) && !row.제외).map((row) => row.rowKey),
    [equipmentRows]
  );
  // 기본선택의 "내용" 시그니처 — 30초 폴링/타 카드 액션으로 load()가 새 배열을 내려도
  // 장비 구성(선택 대상 rowKey 집합)이 실제로 바뀌지 않았으면 사용자가 손으로 해제한
  // '등록 제외' 체크가 유지되도록 한다. 예전엔 배열 identity가 바뀔 때마다 무조건 리셋됐다.
  const defaultSig = useMemo(() => [...defaultCheckedKeys].sort().join("|"), [defaultCheckedKeys]);
  const [checked, setChecked] = useState<Set<string>>(() => new Set(defaultCheckedKeys));
  const [editingRowKey, setEditingRowKey] = useState<string | null>(null);
  const prevSigRef = useRef<string>(defaultSig);

  useEffect(() => {
    if (prevSigRef.current !== defaultSig) {
      prevSigRef.current = defaultSig;
      setChecked(new Set(defaultCheckedKeys));
    }
  }, [defaultSig, defaultCheckedKeys]);

  useEffect(() => {
    setEditingRowKey(null);
  }, [req.reqID, req.장비목록]);

  const openInlineItemEdit = (row: ConfirmEquipmentRow) => setEditingRowKey(row.rowKey);

  const toggle = useCallback((key: string) =>
    setChecked((prev) => {
      const n = new Set(prev);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    }), []);

  const selectableEquips = useMemo(() => equipmentRows.filter((row) => row.role !== "set-header"), [equipmentRows]);
  const excludedItems = useMemo(
    () =>
      selectableEquips
        .filter((row) => !checked.has(row.rowKey))
        .map((row) => ({ 장비명: row.장비명, 비고: String(row.비고 || ""), 순번: itemOrdinal(row) })),
    [selectableEquips, checked, itemOrdinal],
  );
  const excludedLabels = useMemo(() => excludedItems.map((item) => item.장비명), [excludedItems]);

  const barCls = statusBarClass(status);
  const chipCls = statusChipClass(status);
  const isQueued = queueIndex >= 0;

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
              {isQueued && <span className="rounded-full bg-brand-50 px-2 py-0.5 text-[11px] font-bold text-brand-700">앱 대기 {queueIndex + 1}</span>}
            </div>
            <div className="mt-0.5 text-[11.5px] text-ink-faint">
              {req.reqID}
              {req.업체명 && req.업체명 !== "일반" ? ` · ${req.업체명}` : ""}
              {req.연락처 ? ` · ${req.연락처}` : ""}
            </div>
          </div>
          {actionable && !busy && !isQueued && (
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
            const sel = !isSetHeader && checked.has(row.rowKey);
            const editableItem = { ...row, 순번: itemOrdinal(row) };
            const canEditItem = actionable && !busy && !isQueued;
            const canOpenRow = canEditItem && !isSetHeader;
            const isEditingRow = editingRowKey === row.rowKey;
            const rowOpensInlineEdit = canOpenRow && !isEditingRow;
            const needsModelChoice = /모델|미등록|❓/.test(`${row.결과 || ""} ${row.상세 || ""}`);
            const rowCls = isSetHeader
              ? "border border-line/60 bg-brand-50 px-3 py-2"
              : isSetComponent
                ? "ml-3 border border-line/70 border-l-2 border-l-brand-200 bg-white px-2.5 py-2"
                : "bg-paper/60 px-2 py-1.5";
            return (
              <div
                key={row.rowKey}
                data-confirm-role={row.role}
                onClick={rowOpensInlineEdit ? () => openInlineItemEdit(row) : undefined}
                onKeyDown={rowOpensInlineEdit ? (e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    openInlineItemEdit(row);
                  }
                } : undefined}
                role={rowOpensInlineEdit ? "button" : undefined}
                tabIndex={rowOpensInlineEdit ? 0 : undefined}
                aria-label={rowOpensInlineEdit ? `${row.장비명} 행에서 바로 수정` : undefined}
                className={`flex items-start gap-2 rounded-xl ${rowCls} ${rowOpensInlineEdit ? "cursor-pointer transition hover:ring-2 hover:ring-brand-200 focus:outline-none focus:ring-2 focus:ring-brand-400" : ""}`}
              >
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
                    {canEditItem && (
                      <button onClick={onEdit} className="tap shrink-0 rounded-md px-1.5 py-1 text-[12px] font-bold text-brand-700/70" aria-label="세트 수정(전체 편집)">✎</button>
                    )}
                  </>
                ) : (
                  <>
                    {actionable && hasResult && !row.제외 && !busy && !isQueued ? (
                      <input type="checkbox" checked={sel} onClick={(e) => e.stopPropagation()} onChange={() => toggle(row.rowKey)} className="mt-0.5 h-[16px] w-[16px] shrink-0 accent-brand-600" aria-label="등록 선택" />
                    ) : (
                      <span className="mt-0.5 w-[16px] shrink-0" aria-hidden />
                    )}
                    {isEditingRow ? (
                      <InlineItemEditor
                        req={req}
                        item={editableItem}
                        onCancel={() => setEditingRowKey(null)}
                        onSaved={async () => {
                          setEditingRowKey(null);
                          await onItemSaved();
                        }}
                        runFunc={runFunc}
                      />
                    ) : (
                      <>
                        <div className="min-w-0 flex-1">
                          <div className="flex min-w-0 items-baseline gap-1.5">
                            <span className={`truncate text-[13.5px] font-semibold ${row.제외 ? "text-ink-faint line-through" : isSetComponent ? "text-ink-soft" : "text-ink"}`}>{row.장비명}</span>
                            <span className="shrink-0 text-[12px] font-bold tabular-nums text-ink-soft">×{row.수량}</span>
                          </div>
                          {row.상세 && <div className="truncate text-[11px] text-ink-faint">{row.상세}</div>}
                        </div>
                        {row.제외 && <span className="shrink-0 rounded-full bg-attention-bg px-2 py-0.5 text-[10.5px] font-bold text-attention-fg">제외</span>}
                        {!row.제외 && row.결과 && (
                          canEditItem && needsModelChoice ? (
                            <button onClick={(e) => { e.stopPropagation(); openInlineItemEdit(row); }} className={`tap shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-bold ${RESULT_CLS[tone]}`} aria-label="모델 선택">
                              {row.결과}
                            </button>
                          ) : (
                            <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-bold ${RESULT_CLS[tone]}`}>{row.결과}</span>
                          )
                        )}
                        {canEditItem && (
                          <button onClick={(e) => { e.stopPropagation(); openInlineItemEdit(row); }} className={`tap shrink-0 rounded-md px-1.5 py-1 text-[12px] font-bold ${needsModelChoice ? "text-warn-fg" : "text-ink-faint"}`} aria-label={needsModelChoice ? "모델 선택/품목 수정" : "품목 수정"}>
                            {needsModelChoice ? "수정" : "✎"}
                          </button>
                        )}
                      </>
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
              <>
                <Btn primary disabled={busy} onClick={() => onAct("확인", req.reqID)}>{busy ? "처리 중…" : "확인 (가용성 체크)"}</Btn>
                <Btn
                  disabled={busy || isQueued}
                  onClick={() => {
                    if (confirm(`가용성 확인을 건너뛰고 ${req.예약자명 || "이 요청"}을(를) 바로 등록할까요?\n(세트 전개·날짜 검증은 등록 과정에서 자동 처리됩니다)`)) onRegisterSelected(req, []);
                  }}
                >
                  {isQueued ? `등록 대기 ${queueIndex + 1}` : "바로 등록"}
                </Btn>
              </>
            ) : (
              <>
                <Btn
                  primary
                  disabled={busy || isQueued}
                  onClick={() => {
                    const total = selectableEquips.length;
                    const sel = total - excludedItems.length;
                    const msg = excludedItems.length ? `${sel}/${total}개 장비를 등록 대기열에 넣습니다.\n제외: ${excludedLabels.join(", ")}` : `${total}개 장비를 모두 등록 대기열에 넣습니다.`;
                    if (confirm(msg)) onRegisterSelected(req, excludedItems);
                  }}
                >
                  {busy ? "처리 중…" : isQueued ? `등록 대기 ${queueIndex + 1}` : excludedItems.length ? `선택 등록 (${selectableEquips.length - excludedItems.length})` : "전체 등록"}
                </Btn>
                <Btn disabled={busy || isQueued} onClick={() => onAct("보류", req.reqID)}>전체 보류</Btn>
                <Btn ghost disabled={busy || isQueued} onClick={() => { if (confirm("이 요청을 거절할까요?")) onAct("거절", req.reqID); }}>전체 거절</Btn>
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
  // 할인유형(M열) — 목록 API는 값을 업체명/할인유형 두 키로 모두 내려준다(레거시 호환).
  const [discount, setDiscount] = useState(req.할인유형 || req.업체명 || "");
  // 시간은 전용 필드(반출시간/반납시간)가 정답 — 반출일에 붙은 시간 토막은
  // 시트 타임존 어긋남에서 온 쓰레기(16:00)였던 적이 있어 폴백으로만 사용
  const [outD, setOutD] = useState(out.d);
  const [outT, setOutT] = useState(req.반출시간 || out.t);
  const [retD, setRetD] = useState(ret.d);
  const [retT, setRetT] = useState(req.반납시간 || ret.t);
  // 세트는 세트명(헤더)으로 보존하고 구성품은 제외 — 저장 시 GAS가 세트를 다시 전개하므로
  // 구성품을 단품으로 보내면 세트 구조·세트 단가가 소실된다
  const [equips, setEquips] = useState<{ 이름: string; 수량: string }[]>(
    buildConfirmEquipmentRows(req.장비목록 || [])
      .filter((r) => r.role !== "set-component")
      .map((r) => ({ 이름: r.장비명, 수량: String(r.수량 || 1) })),
  );
  const [saving, setSaving] = useState(false);
  const catalog = useEquipmentCatalog();

  const setEq = (i: number, k: "이름" | "수량", v: string) => setEquips((prev) => prev.map((e, j) => (j === i ? { ...e, [k]: v } : e)));
  const addEq = () => setEquips((prev) => [...prev, { 이름: "", 수량: "1" }]);
  const delEq = (i: number) => setEquips((prev) => prev.filter((_, j) => j !== i));

  const save = async (opts?: { skipCheckAndRegister?: boolean }) => {
    setSaving(true);
    setError("");
    try {
      const args: Record<string, unknown> = {
        reqID: req.reqID,
        예약자명: name,
        연락처: phone,
        할인유형: discount,
        반출일: outD,
        반출시간: outT,
        반납일: retD,
        반납시간: retT,
        장비: equips.filter((e) => e.이름.trim()).map((e) => ({ 이름: e.이름.trim(), 수량: e.수량 })),
      };
      if (opts?.skipCheckAndRegister) args.skipCheck = true; // 가용확인 생략(등록 시 자동 처리)
      await runFunc("updateRequest", args);
      if (opts?.skipCheckAndRegister) {
        // 저장 후 곧바로 등록 대기열에 넣는다 — 확인 단계를 건너뛴다.
        const res = await authFetch("/api/confirm", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "registerAsync", reqID: req.reqID }),
        });
        const json = await res.json().catch(() => ({}));
        const ok = json.status === "OK" || json.success === true;
        if (!res.ok || !ok) throw new Error(json.message || json.error || "바로 등록 실패");
      }
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
          <Field label="할인유형">
            <select value={discount} onChange={(e) => setDiscount(e.target.value)} className="inp">
              <option value="">선택 안 함(자동)</option>
              {DISCOUNT_OPTIONS.map((d) => (
                <option key={d} value={d}>{d}</option>
              ))}
            </select>
          </Field>
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
                  <EquipNameInput value={e.이름} onChange={(v) => setEq(i, "이름", v)} names={catalog.names} placeholder="장비명" />
                  {/* 수량칸은 고정폭. 인라인 style로 .inp의 width:100%를 덮어써야 장비명칸이 0으로 찌그러지지 않는다. */}
                  <input value={e.수량} onChange={(ev) => setEq(i, "수량", ev.target.value)} className="inp text-center" style={{ width: "3.25rem", flex: "0 0 3.25rem" }} inputMode="numeric" aria-label="수량" />
                  <button onClick={() => delEq(i)} className="tap shrink-0 px-1.5 text-ink-faint" aria-label="삭제">✕</button>
                </div>
              ))}
            </div>
            <p className="mt-1.5 text-[11px] text-ink-faint">‘재확인’은 장비를 다시 입력하고 가용성을 확인합니다. 재고를 이미 아는 장비는 ‘바로 등록’으로 확인을 건너뛰세요.</p>
          </div>
          <div className="mt-1 grid grid-cols-2 gap-2">
            <button disabled={saving} onClick={() => save()} className="tap rounded-xl bg-white py-3 text-[13.5px] font-extrabold text-ink-soft ring-1 ring-line disabled:opacity-50">
              {saving ? "저장 중…" : "저장 + 재확인"}
            </button>
            <button disabled={saving} onClick={() => { if (confirm("가용성 확인을 건너뛰고 저장한 뒤 바로 등록할까요?\n(세트 전개·날짜 검증은 등록 과정에서 자동 처리됩니다)")) void save({ skipCheckAndRegister: true }); }} className="tap rounded-xl bg-brand-600 py-3 text-[13.5px] font-extrabold text-white disabled:opacity-50">
              {saving ? "처리 중…" : "저장 후 바로 등록"}
            </button>
          </div>
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

/** 품목 행 내부 편집 — 화면을 덮지 않고 시트처럼 해당 행에서 바로 수정한다. */
function InlineItemEditor({
  req, item, onCancel, onSaved, runFunc,
}: {
  req: Req; item: Equip; onCancel: () => void; onSaved: () => void; runFunc: (func: string, args: Record<string, unknown>) => Promise<boolean>;
}) {
  const [name, setName] = useState(item.장비명);
  const [qty, setQty] = useState(String(item.수량 || 1));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const catalog = useEquipmentCatalog();

  const call = async (args: Record<string, unknown>) => {
    setBusy(true);
    setErr("");
    try {
      await runFunc("updateRequestItem", { reqID: req.reqID, 장비명: item.장비명, 비고: String(item.비고 || ""), 순번: item.순번 || 0, ...args });
      await onSaved();
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
    <div className="min-w-0 flex-1 rounded-lg bg-white p-2 shadow-sm ring-2 ring-brand-300" onClick={(e) => e.stopPropagation()}>
      <div className="flex min-w-0 items-start gap-1.5">
        <EquipNameInput value={name} onChange={setName} names={catalog.names} placeholder="장비명" />
        <input
          value={qty}
          onChange={(e) => setQty(e.target.value)}
          className="h-9 w-14 shrink-0 rounded-md border border-black/10 px-2 text-center text-[13px] font-bold text-ink outline-none focus:border-brand-600"
          inputMode="numeric"
          aria-label="수량"
        />
      </div>
      {err && <p className="mt-1 text-[12px] font-bold text-attention-fg">{err}</p>}
      <div className="mt-2 flex flex-wrap gap-1.5">
        <button disabled={busy} onClick={save} className="tap min-h-8 flex-[2] rounded-lg bg-brand-600 px-2 text-[12px] font-extrabold text-white disabled:opacity-50">
          {busy ? "처리 중..." : "저장 + 이 품목만 재확인"}
        </button>
        <button disabled={busy} onClick={onCancel} className="tap min-h-8 flex-1 rounded-lg bg-white px-2 text-[12px] font-extrabold text-ink-soft ring-1 ring-line disabled:opacity-50">
          취소
        </button>
        {item.제외 ? (
          <button disabled={busy} onClick={() => void call({ 제외: false })} className="tap min-h-8 flex-1 rounded-lg bg-paper px-2 text-[12px] font-extrabold text-ink-soft ring-1 ring-line disabled:opacity-50">
            제외 해제 (다시 등록 대상에 포함)
          </button>
        ) : (
          <button disabled={busy} onClick={() => void call({ 제외: true })} className="tap min-h-8 flex-1 rounded-lg bg-attention-bg px-2 text-[12px] font-extrabold text-attention-fg disabled:opacity-50">
            이 품목 제외
          </button>
        )}
      </div>
    </div>
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
  const catalog = useEquipmentCatalog();

  const call = async (args: Record<string, unknown>) => {
    setBusy(true);
    setErr("");
    try {
      await runFunc("updateRequestItem", { reqID: req.reqID, 장비명: item.장비명, 비고: String(item.비고 || ""), 순번: item.순번 || 0, ...args });
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
            <EquipNameInput value={name} onChange={setName} names={catalog.names} placeholder="장비명" />
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

/** 장비명 입력 + 드롭다운 자동완성 — 확인요청 시트 F열 드롭다운과 같은 목록(세트마스터 기준) */
function EquipNameInput({
  value, onChange, names, placeholder,
}: {
  value: string; onChange: (v: string) => void; names: string[]; placeholder?: string;
}) {
  const [focused, setFocused] = useState(false);
  const q = value.trim().toLowerCase();
  const suggestions = useMemo(
    () => (q ? names.filter((n) => n.toLowerCase().includes(q)).slice(0, 8) : names.slice(0, 8)),
    [names, q],
  );
  const known = !value.trim() || names.includes(value.trim());
  return (
    <div className="relative min-w-0 flex-1">
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setTimeout(() => setFocused(false), 120)}
        placeholder={placeholder}
        className={`w-full rounded-[0.6rem] border px-2.5 py-2 text-[13.5px] text-ink outline-none focus:border-brand-600 ${known ? "border-black/10" : "border-warn-ring"}`}
      />
      {!known && <div className="px-1 pt-0.5 text-[10.5px] font-bold text-warn-fg">목록에 없는 이름</div>}
      {focused && suggestions.length > 0 && (
        <div className="absolute left-0 right-0 top-[calc(100%+4px)] z-50 max-h-52 overflow-y-auto rounded-xl bg-white py-1 shadow-card ring-1 ring-line">
          {suggestions.map((n) => (
            <button
              key={n}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                onChange(n);
                setFocused(false);
              }}
              className="block w-full px-3 py-2 text-left text-[13px] font-semibold text-ink hover:bg-brand-50"
            >
              {n}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
