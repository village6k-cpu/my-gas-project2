"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  InventoryAuditReview as Review,
  InventoryAuditReviewDecision,
  InventoryAuditReviewItem,
  InventoryAuditRentalGroup,
} from "@/lib/inventory-audit/review";
import { authFetch } from "@/lib/data/authFetch";

type Props = {
  sessionId: string;
  onClose(): void;
  onChanged(): Promise<void> | void;
};

type FinalCountDraft = {
  finalStockTotal: string;
  finalStockMaintenance: string;
};

async function readJson(response: Response) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(typeof body.error === "string" ? body.error : "처리하지 못했습니다.");
  }
  return body;
}

const CLASS_LABEL: Record<InventoryAuditReviewItem["classification"], string> = {
  approved: "사장님 확정",
  match: "원장 일치",
  quantity_difference: "수량 차이",
  condition_or_component_issue: "상태·구성품 문제",
  uncounted: "미계수",
  ambiguous_rental: "대여 확인 필요",
};

export function InventoryAuditReview({ sessionId, onClose, onChanged }: Props) {
  const [review, setReview] = useState<Review | null>(null);
  const [actions, setActions] = useState<Record<string, InventoryAuditReviewDecision>>({});
  const [finalCounts, setFinalCounts] = useState<Record<string, FinalCountDraft>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [confirmed, setConfirmed] = useState(false);

  // 사장님이 손댄(아직 서버에 저장 안 된) 판정·수량 키 — 재조회가 서버 기본값으로 덮어쓰지 않게 보존
  const dirtyDecisionKeys = useRef<Set<string>>(new Set());
  const dirtyCountKeys = useRef<Set<string>>(new Set());
  const clearDirtyKeys = useCallback(() => {
    dirtyDecisionKeys.current.clear();
    dirtyCountKeys.current.clear();
  }, []);

  const load = useCallback(async (options?: { silent?: boolean }) => {
    // silent: 대여명 판정 등 부분 갱신 뒤 재조회 — 화면을 '불러오는 중…'으로 리셋하지 않는다
    if (!options?.silent) setLoading(true);
    setError("");
    try {
      const next = (await readJson(
        await authFetch(`/api/inventory-audits/${sessionId}/review`, { cache: "no-store" }),
      )) as Review;
      setReview(next);
      // 미저장 판정 보존: 서버 기본값으로 재구성하되 사장님이 수정한(dirty) 키는 로컬 값 유지.
      // 확정(checkpoint)된 장비는 항상 서버 기본값을 따른다.
      setActions((current) =>
        Object.fromEntries(next.items.map((item) => [
          item.equipmentId,
          item.checkpointApprovedAt === null &&
          dirtyDecisionKeys.current.has(item.equipmentId) &&
          current[item.equipmentId] !== undefined
            ? current[item.equipmentId]
            : item.defaultDecision,
        ])),
      );
      setFinalCounts((current) =>
        Object.fromEntries(next.items.map((item) => {
          const serverDraft: FinalCountDraft = {
            finalStockTotal: item.reviewStockTotal === null ? "" : String(item.reviewStockTotal),
            finalStockMaintenance: String(item.reviewStockMaintenance),
          };
          const keepLocal =
            item.checkpointApprovedAt === null &&
            dirtyCountKeys.current.has(item.equipmentId) &&
            current[item.equipmentId] !== undefined;
          return [item.equipmentId, keepLocal ? current[item.equipmentId] : serverDraft];
        })),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "검토 자료를 불러오지 못했습니다.");
    } finally {
      if (!options?.silent) setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    void load();
  }, [load]);

  const unresolvedGroups = useMemo(
    () => review?.rentalGroups.filter((group) => group.resolution === null) ?? [],
    [review?.rentalGroups],
  );
  const isDraft = review?.session.status === "draft";
  const visibleItems = useMemo(
    () =>
      (review?.items ?? []).filter(
        (item) =>
          showAll ||
          (isDraft
            ? item.physicalTotal !== null && !item.checkpointApprovedAt
            : item.classification !== "match"),
      ),
    [isDraft, review?.items, showAll],
  );
  const hasRecount = Object.values(actions).includes("recount");

  const decisionInput = (item: InventoryAuditReviewItem) => {
    const counts = finalCounts[item.equipmentId];
    return {
      equipmentId: item.equipmentId,
      decision: actions[item.equipmentId] ?? item.defaultDecision,
      finalStockTotal: counts?.finalStockTotal,
      finalStockMaintenance: counts?.finalStockMaintenance,
      reviewNote: "",
    };
  };

  const resolveRental = async (
    group: InventoryAuditRentalGroup,
    resolution: "existing_equipment" | "not_inventory",
    equipmentId?: string,
  ) => {
    if (resolution === "not_inventory" && !window.confirm(`‘${group.rawName}’ 묶음을 재고 장비가 아닌 구성품·메모로 처리할까요?`)) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      await readJson(
        await authFetch(`/api/inventory-audits/${sessionId}/rental-exceptions`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            exceptionIds: group.exceptionIds,
            resolution,
            equipmentId: resolution === "existing_equipment" ? equipmentId : null,
          }),
        }),
      );
      setNotice(`‘${group.rawName}’ ${group.occurrenceCount}건을 한 번에 처리했습니다.`);
      // 그룹 해소는 연결 장비의 실사합계·분류를 바꾸므로 서버 재계산이 필요하다.
      // silent 재조회 + dirty 보존으로 미저장 판정·수량 입력은 초기화하지 않는다.
      await load({ silent: true });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "대여명 분류를 저장하지 못했습니다.");
    } finally {
      setSaving(false);
    }
  };

  const persistDecisions = async () => {
    if (!review) throw new Error("검토 자료를 먼저 불러와 주세요.");
    const result = await readJson(
      await authFetch(`/api/inventory-audits/${sessionId}/decisions`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          decisions: review.items.map(decisionInput),
        }),
      }),
    );
    return result;
  };

  const saveDecisions = async () => {
    setSaving(true);
    setError("");
    setNotice("");
    try {
      await persistDecisions();
      clearDirtyKeys();
      setNotice("장비별 검토 결과를 저장했습니다. 아직 원장은 바뀌지 않았습니다.");
      await load({ silent: true });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "검토 결과를 저장하지 못했습니다.");
    } finally {
      setSaving(false);
    }
  };

  const checkpoint = async () => {
    if (!review || !confirmed) return;
    const decisions = review.items
      .filter((item) => item.physicalTotal !== null && !item.checkpointApprovedAt)
      .map(decisionInput);
    const approvingCount = decisions.filter((item) => item.decision !== "recount").length;
    if (
      approvingCount === 0 ||
      !window.confirm(
        `현재 완료된 장비 ${approvingCount}개를 확정할까요? 확정된 장비는 원장에 반영되고 다음 직원이 다시 수정할 수 없습니다.`,
      )
    ) return;

    setSaving(true);
    setError("");
    setNotice("");
    try {
      const result = await readJson(
        await authFetch(`/api/inventory-audits/${sessionId}/checkpoint`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ decisions }),
        }),
      );
      setConfirmed(false);
      clearDirtyKeys();
      setNotice(
        `현재 완료분 ${Number(result.approved_equipment_count) || approvingCount}개를 확정했습니다. 나머지는 다음 직원이 이어서 셉니다.`,
      );
      await onChanged();
      await load({ silent: true });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "현재 완료분을 확정하지 못했습니다.");
    } finally {
      setSaving(false);
    }
  };

  const requestRecount = async () => {
    if (!confirmed || !window.confirm("재실사로 표시한 장비만 새 실사 작업으로 넘길까요?")) return;
    setSaving(true);
    setError("");
    try {
      await persistDecisions();
      clearDirtyKeys();
      await readJson(
        await authFetch(`/api/inventory-audits/${sessionId}/recount`, { method: "POST" }),
      );
      await onChanged();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "재실사를 요청하지 못했습니다.");
    } finally {
      setSaving(false);
    }
  };

  const approve = async () => {
    if (!confirmed || !window.confirm("이 결과로 총보유수량과 상태를 확정할까요? 승인 즉시 재고 원장이 변경됩니다.")) return;
    setSaving(true);
    setError("");
    try {
      await persistDecisions();
      clearDirtyKeys();
      await readJson(
        await authFetch(`/api/inventory-audits/${sessionId}/approve`, { method: "POST" }),
      );
      let mirrorSynced = true;
      try {
        await readJson(
          await authFetch(`/api/inventory-audits/${sessionId}/mirror`, { method: "POST" }),
        );
      } catch {
        mirrorSynced = false;
      }
      window.alert(
        mirrorSynced
          ? "기준 재고를 확정했고 시트에도 반영했습니다."
          : "기준 재고는 확정했습니다. 시트 반영은 자동 재시도가 필요합니다.",
      );
      await onChanged();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "기준 재고를 확정하지 못했습니다.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[110] flex flex-col bg-paper">
      <header className="safe-top flex items-center justify-between border-b border-line bg-white px-3 py-3">
        <div>
          <div className="text-[15px] font-bold text-ink">{isDraft ? "현재 저장분 사장님 검토" : "전체 실사 사장님 검토"}</div>
          <div className="text-[11.5px] text-ink-mute">{isDraft ? "확정한 장비만 원장에 반영되고, 나머지는 다음 직원이 이어서 셉니다." : "직원 입력은 승인 전까지 원장을 바꾸지 않습니다."}</div>
        </div>
        <button disabled={saving} onClick={onClose} className="tap rounded-lg px-3 py-2 text-[12px] font-bold ring-1 ring-line disabled:opacity-50">닫기</button>
      </header>

      <main className="flex-1 overflow-y-auto p-3 pb-40">
        {loading && <div className="rounded-xl bg-white p-4 text-[13px] font-semibold text-ink-mute ring-1 ring-line">검토 자료 불러오는 중…</div>}
        {error && <div className="mb-3 rounded-lg bg-attention-bg p-3 text-[12px] font-semibold text-attention-fg">{error}</div>}
        {notice && <div className="mb-3 rounded-lg bg-checkin-bg p-3 text-[12px] font-semibold text-checkin-fg">{notice}</div>}

        {review && (
          <>
            <section className="grid grid-cols-3 gap-2">
              <Summary label="전체" value={review.summary.total} />
              <Summary label="미계수" value={review.summary.uncounted} warn={review.summary.uncounted > 0} />
              <Summary label="수량 차이" value={review.summary.differences} warn={review.summary.differences > 0} />
              <Summary label="상태 문제" value={review.summary.issues} warn={review.summary.issues > 0} />
              <Summary label="원장 일치" value={review.summary.matching} />
              <Summary label={isDraft ? "사장님 확정" : "판정 저장"} value={isDraft ? review.summary.checkpointApproved : review.summary.savedDecisionCount} />
            </section>

            {unresolvedGroups.length > 0 && (
              <section className="mt-4 rounded-xl bg-white p-3 ring-1 ring-warn-fg/30">
                <div className="text-[14px] font-bold text-ink">1. 대여명 불일치 · {unresolvedGroups.length}묶음</div>
                <div className="mt-1 text-[11.5px] text-ink-mute">같은 이름으로 반복된 대여 건을 한 번만 판정합니다. 실제 장비는 원장 장비에 연결하고, 구성품 묶음·메모는 재고 아님으로 처리해 주세요.</div>
                <div className="mt-3 space-y-2">
                  {unresolvedGroups.map((group) => (
                    <div key={group.key} className="rounded-lg bg-paper p-3 ring-1 ring-line">
                      <div className="text-[13px] font-bold text-ink">{group.rawName}</div>
                      <div className="mt-0.5 text-[11px] text-ink-mute">{group.occurrenceCount}건 · 대여수량 합계 {group.totalQty}</div>
                      <select
                        disabled={saving}
                        defaultValue=""
                        onChange={(event) => {
                          if (event.target.value) void resolveRental(group, "existing_equipment", event.target.value);
                        }}
                        className="mt-2 w-full rounded-lg bg-white px-3 py-2.5 text-[12px] ring-1 ring-line"
                      >
                        <option value="">기존 장비에 연결…</option>
                        {review.items.map((item) => <option key={item.equipmentId} value={item.equipmentId}>{item.name} · {item.equipmentId}</option>)}
                      </select>
                      <button disabled={saving} onClick={() => void resolveRental(group, "not_inventory")} className="tap mt-2 w-full rounded-lg bg-white px-3 py-2 text-[12px] font-bold text-ink-mute ring-1 ring-line disabled:opacity-50">재고 장비 아님</button>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {review.summary.temporaryObservationCount > 0 && (
              <div className="mt-4 rounded-lg bg-attention-bg p-3 text-[12px] font-semibold text-attention-fg">목록 외·식별 불확실 장비 {review.summary.temporaryObservationCount}건은 별도 장비 등록 판정이 필요해 아직 승인할 수 없습니다.</div>
            )}

            <section className="mt-4">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-[14px] font-bold text-ink">2. 장비별 판정</div>
                  <div className="text-[11.5px] text-ink-mute">{isDraft ? "현재 계수가 끝난 장비만 표시합니다. 재실사는 다음 직원에게 남습니다." : "차이·문제·미계수 항목을 먼저 표시합니다."}</div>
                </div>
                <button onClick={() => setShowAll((value) => !value)} className="tap rounded-lg bg-white px-3 py-2 text-[11.5px] font-bold ring-1 ring-line">{showAll ? "문제만 보기" : "전체 보기"}</button>
              </div>
              <div className="mt-2 space-y-2">
                {visibleItems.map((item) => (
                  <ReviewItemCard
                    key={item.equipmentId}
                    item={item}
                    isDraft={isDraft}
                    decision={actions[item.equipmentId] ?? item.defaultDecision}
                    counts={finalCounts[item.equipmentId] ?? { finalStockTotal: "", finalStockMaintenance: "0" }}
                    onDecision={(decision) => {
                      dirtyDecisionKeys.current.add(item.equipmentId);
                      setActions((current) => ({ ...current, [item.equipmentId]: decision }));
                      setConfirmed(false);
                    }}
                    onCountsChange={(counts) => {
                      dirtyCountKeys.current.add(item.equipmentId);
                      setFinalCounts((current) => ({ ...current, [item.equipmentId]: counts }));
                      setConfirmed(false);
                    }}
                  />
                ))}
                {visibleItems.length === 0 && <div className="rounded-lg bg-checkin-bg p-3 text-[12px] font-semibold text-checkin-fg">{isDraft ? "새로 확정할 완료 장비가 없습니다." : "수량 차이·문제·미계수 항목이 없습니다."}</div>}
              </div>
            </section>

            <label className="mt-4 flex gap-2 rounded-lg bg-white p-3 text-[12px] font-semibold text-ink-soft ring-1 ring-line">
              <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
              {isDraft ? "현재 완료된 장비와 선택한 판정을 확인했습니다." : "수량 차이·상태 문제·미계수 항목과 선택한 판정을 확인했습니다."}
            </label>
          </>
        )}
      </main>

      {review && (
        <div className="safe-bottom fixed inset-x-0 bottom-0 border-t border-line bg-white p-3 shadow-card">
          {isDraft ? (
            <button disabled={saving || !review.summary.canCheckpoint || !confirmed} onClick={() => void checkpoint()} className="tap w-full rounded-lg bg-brand-600 px-4 py-3 text-[14px] font-bold text-white disabled:opacity-40">{saving ? "처리 중…" : `현재 완료분 ${review.summary.checkpointReady}개 확정`}</button>
          ) : (
            <>
              <button disabled={saving || !review.summary.canApprove} onClick={() => void saveDecisions()} className="tap w-full rounded-lg bg-white px-4 py-2.5 text-[12px] font-bold text-brand-700 ring-1 ring-brand-200 disabled:opacity-40">검토안 저장 · 원장 변경 없음</button>
              {hasRecount ? (
                <button disabled={saving || !review.summary.canApprove || !confirmed} onClick={() => void requestRecount()} className="tap mt-2 w-full rounded-lg bg-warn-fg px-4 py-3 text-[14px] font-bold text-white disabled:opacity-40">선택 장비 재실사 요청</button>
              ) : (
                <button disabled={saving || !review.summary.canApprove || !confirmed} onClick={() => void approve()} className="tap mt-2 w-full rounded-lg bg-brand-600 px-4 py-3 text-[14px] font-bold text-white disabled:opacity-40">{saving ? "처리 중…" : "기준 재고 확정"}</button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Summary({ label, value, warn = false }: { label: string; value: number; warn?: boolean }) {
  return <div className={`rounded-lg p-2.5 text-center ring-1 ${warn ? "bg-warn-bg text-warn-fg ring-warn-fg/20" : "bg-white text-ink ring-line"}`}><div className="text-[10.5px] font-semibold opacity-75">{label}</div><div className="mt-0.5 text-[17px] font-bold tabular-nums">{value}</div></div>;
}

function ReviewItemCard({ item, isDraft, decision, counts, onDecision, onCountsChange }: { item: InventoryAuditReviewItem; isDraft: boolean; decision: InventoryAuditReviewDecision; counts: FinalCountDraft; onDecision(value: InventoryAuditReviewDecision): void; onCountsChange(value: FinalCountDraft): void }) {
  const locked = item.checkpointApprovedAt !== null;
  const unavailable = locked || (isDraft && item.physicalTotal === null);
  const countDisabled = unavailable || decision !== "apply_audit";
  return (
    <div className="rounded-xl bg-white p-3 ring-1 ring-line">
      <div className="flex items-start justify-between gap-2">
        <div><div className="text-[13.5px] font-bold text-ink">{item.name}</div><div className="text-[10.5px] text-ink-mute">{item.equipmentId} · {item.locations.join(", ") || "위치 기록 없음"}</div></div>
        <span className={`shrink-0 rounded-full px-2 py-1 text-[10.5px] font-bold ${["match", "approved"].includes(item.classification) ? "bg-checkin-bg text-checkin-fg" : "bg-attention-bg text-attention-fg"}`}>{CLASS_LABEL[item.classification]}</span>
      </div>
      <div className="mt-2 grid grid-cols-4 gap-1 text-center text-[10.5px]">
        <Metric label="원장" value={item.ledgerStockTotal} />
        <Metric label="매장" value={item.physicalTotal} />
        <Metric label="대여중" value={item.matchedActiveRentalQty + item.resolvedOffsiteQty} />
        <Metric label="실사합계" value={item.candidateTotal} />
      </div>
      <div className="mt-2 rounded-lg bg-brand-50 p-2.5 ring-1 ring-brand-200">
        <div className="mb-2 text-[11px] font-bold text-brand-700">사장님 최종 확정 수량</div>
        <div className="grid grid-cols-2 gap-2">
          <label className="text-[10.5px] font-semibold text-ink-soft">
            최종 총수량
            <input
              type="number"
              inputMode="numeric"
              min="0"
              step="1"
              disabled={countDisabled}
              value={counts.finalStockTotal}
              onChange={(event) => onCountsChange({ ...counts, finalStockTotal: event.target.value })}
              className="mt-1 w-full rounded-lg bg-white px-3 py-2 text-[15px] font-bold tabular-nums text-ink ring-1 ring-line disabled:bg-line/30 disabled:text-ink-mute"
            />
          </label>
          <label className="text-[10.5px] font-semibold text-ink-soft">
            정비수량
            <input
              type="number"
              inputMode="numeric"
              min="0"
              step="1"
              disabled={countDisabled}
              value={counts.finalStockMaintenance}
              onChange={(event) => onCountsChange({ ...counts, finalStockMaintenance: event.target.value })}
              className="mt-1 w-full rounded-lg bg-white px-3 py-2 text-[15px] font-bold tabular-nums text-ink ring-1 ring-line disabled:bg-line/30 disabled:text-ink-mute"
            />
          </label>
        </div>
        <div className="mt-1.5 text-[10px] text-brand-700">`실사 적용` 선택 시 이 숫자가 기준재고에 반영됩니다.</div>
      </div>
      {item.finalOpenIssues.length > 0 && <div className="mt-2 rounded-lg bg-attention-bg px-2.5 py-2 text-[11px] font-semibold text-attention-fg">{item.finalOpenIssues.map((issue) => issue.label).join(" · ")}</div>}
      <div className="mt-2 grid grid-cols-3 gap-1.5">
        {(["apply_audit", "keep_ledger", "recount"] as const).map((value) => (
          <button disabled={unavailable} key={value} onClick={() => onDecision(value)} className={`tap rounded-lg px-2 py-2 text-[11px] font-bold ring-1 disabled:opacity-40 ${decision === value ? "bg-brand-50 text-brand-700 ring-brand-200" : "bg-white text-ink-mute ring-line"}`}>{{ apply_audit: "실사 적용", keep_ledger: "기존 원장 유지", recount: isDraft ? "다음 근무자 재확인" : "재실사" }[value]}</button>
        ))}
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number | null }) {
  return <div className="rounded-md bg-paper px-1 py-1.5"><div className="text-ink-mute">{label}</div><div className="mt-0.5 text-[13px] font-bold text-ink tabular-nums">{value ?? "-"}</div></div>;
}
