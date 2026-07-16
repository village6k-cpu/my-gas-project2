"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { authFetch } from "@/lib/data/authFetch";
import { compressInventoryAuditEvidence } from "@/lib/inventory-audit/compressEvidence";
import { normalizeAuditLocation } from "@/lib/inventory-audit/mvp";
import { InventoryAuditReview } from "@/components/inventory-audit/InventoryAuditReview";

type Session = { id: string; status: string; startedByEmail?: string | null };
type CatalogItem = {
  equipmentId: string;
  name: string;
  aliases: string[];
  major: string | null;
  category: string | null;
  progress: "uncounted" | "counted" | "issue" | "approved";
  observationCount: number;
  lockedByOwner: boolean;
};
type Observation = {
  id: string;
  equipmentId: string | null;
  temporaryCode: string | null;
  temporaryLabel: string | null;
  location: string;
  countNormal: number;
  countMaintenance: number;
  countDamaged: number;
  countConditionUnknown: number;
  missingComponents: string[];
  note: string;
  identificationStatus: "confirmed" | "uncertain" | "unlisted";
  clientUpdatedAt: string;
};
type Workspace = {
  isOwner: boolean;
  globalDraft: { active: boolean; ownedByCaller: boolean };
  activeDraft: Session | null;
  latestCallerSession: Session | null;
  catalog: CatalogItem[];
  observations: Observation[];
  ownerQueue: Session[];
};

type Draft = {
  location: string;
  normal: string;
  maintenance: string;
  damaged: string;
  unknown: string;
  missing: string;
  note: string;
  temporaryLabel: string;
  identificationStatus: "confirmed" | "uncertain" | "unlisted";
  zeroConfirmed: boolean;
};

const EMPTY_DRAFT: Draft = {
  location: "",
  normal: "0",
  maintenance: "0",
  damaged: "0",
  unknown: "0",
  missing: "",
  note: "",
  temporaryLabel: "",
  identificationStatus: "confirmed",
  zeroConfirmed: false,
};

function nextTimestamp(previous?: string): string {
  const previousMs = previous ? Date.parse(previous) : 0;
  return new Date(Math.max(Date.now(), Number.isFinite(previousMs) ? previousMs + 1 : 0)).toISOString();
}

/** 응답 본문(code, currentObservation 등)을 버리지 않고 실어 나르는 에러 — 409 stale_write 복구에 사용 */
class ApiError extends Error {
  readonly code: string | null;
  readonly body: Record<string, unknown>;

  constructor(message: string, code: string | null, body: Record<string, unknown>) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.body = body;
  }
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new ApiError(
      typeof body.error === "string" ? body.error : "처리하지 못했습니다.",
      typeof body.code === "string" ? body.code : null,
      body,
    );
  }
  return body;
}

/** 409 응답의 currentObservation(서버 직렬화 관측)을 안전하게 복원 */
function observationFromBody(value: unknown): Observation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  return typeof row.id === "string" && typeof row.clientUpdatedAt === "string"
    ? (row as unknown as Observation)
    : null;
}

function countsFromDraft(draft: Draft): [number, number, number, number] | null {
  const values = [draft.normal, draft.maintenance, draft.damaged, draft.unknown].map((value) => Number(value));
  return values.every((value) => Number.isInteger(value) && value >= 0)
    ? (values as [number, number, number, number])
    : null;
}

export function InventoryAuditMvp({ onLockChange }: { onLockChange(locked: boolean): void }) {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "uncounted" | "counted" | "issue">("all");
  const [selected, setSelected] = useState<CatalogItem | null>(null);
  const [editing, setEditing] = useState<Observation | null>(null);
  // 신규 관측 id는 폼을 열 때 한 번만 발급 — 저장 재시도가 같은 관측을 재사용하게 해 중복 생성을 막는다
  const [draftObservationId, setDraftObservationId] = useState("");
  const [temporary, setTemporary] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [photo, setPhoto] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [routeDone, setRouteDone] = useState(false);
  const [savedNotice, setSavedNotice] = useState("");
  const [ownerReviewSessionId, setOwnerReviewSessionId] = useState<string | null>(null);

  // 일시 오류 자동 재시도 (백오프) — 수동 '다시 시도' 버튼과 별개로 최대 3회
  const retryTimer = useRef<number | null>(null);
  const retryAttempts = useRef(0);
  const hasLoadedOnce = useRef(false);

  const load = useCallback(async () => {
    if (retryTimer.current !== null) {
      window.clearTimeout(retryTimer.current);
      retryTimer.current = null;
    }
    setLoading(true);
    setError("");
    try {
      const data = (await readJson(await authFetch("/api/inventory-audits", { cache: "no-store" }))) as unknown as Workspace;
      retryAttempts.current = 0;
      hasLoadedOnce.current = true;
      setWorkspace(data);
      onLockChange(data.globalDraft.active);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "실사 상태를 불러오지 못했습니다.");
      // 실사 상태 조회 실패가 재고 탭 전체를 잠그지 않도록 격리 — 실제 원장 쓰기 잠금은
      // 서버 RLS(inventory_audit_ledger_writes_allowed)가 강제하므로 UI는 열어 두고
      // 실사 카드에만 오류 + 재시도를 띄운다. 한 번이라도 읽은 뒤의 재조회 실패는
      // 마지막으로 알던 잠금 상태를 유지한다(진행 중 실사를 오판으로 풀지 않음).
      if (!hasLoadedOnce.current) onLockChange(false);
      if (retryAttempts.current < 3) {
        const delay = 5_000 * 2 ** retryAttempts.current;
        retryAttempts.current += 1;
        retryTimer.current = window.setTimeout(() => {
          retryTimer.current = null;
          void load();
        }, delay);
      }
    } finally {
      setLoading(false);
    }
  }, [onLockChange]);

  const retry = useCallback(() => {
    retryAttempts.current = 0;
    void load();
  }, [load]);

  useEffect(() => {
    void load();
    return () => {
      if (retryTimer.current !== null) window.clearTimeout(retryTimer.current);
    };
  }, [load]);

  const start = async () => {
    setSaving(true);
    setError("");
    try {
      const data = (await readJson(
        await authFetch("/api/inventory-audits/start", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ movementFrozen: true }),
        }),
      )) as unknown as Workspace & { start?: unknown };
      setWorkspace(data);
      onLockChange(true);
      setOpen(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "실사를 시작하지 못했습니다.");
    } finally {
      setSaving(false);
    }
  };

  const observationsByEquipment = useMemo(() => {
    const map = new Map<string, Observation[]>();
    for (const observation of workspace?.observations ?? []) {
      if (!observation.equipmentId) continue;
      const rows = map.get(observation.equipmentId) ?? [];
      rows.push(observation);
      map.set(observation.equipmentId, rows);
    }
    return map;
  }, [workspace?.observations]);

  const catalog = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (workspace?.catalog ?? []).filter((item) => {
      if (filter !== "all" && item.progress !== filter) return false;
      if (!needle) return true;
      return [item.equipmentId, item.name, ...item.aliases].some((value) => value.toLowerCase().includes(needle));
    });
  }, [workspace?.catalog, search, filter]);

  const progress = useMemo(() => {
    const all = workspace?.catalog.length ?? 0;
    const counted = (workspace?.catalog ?? []).filter((item) => item.progress !== "uncounted").length;
    const issue = (workspace?.catalog ?? []).filter((item) => item.progress === "issue").length;
    return { all, counted, issue, uncounted: all - counted };
  }, [workspace?.catalog]);

  const openNewObservation = (item: CatalogItem) => {
    if (item.lockedByOwner) return;
    setSelected(item);
    setEditing(null);
    setDraftObservationId(crypto.randomUUID());
    setTemporary(false);
    setDraft(EMPTY_DRAFT);
    setPhoto(null);
  };

  const openExistingObservation = (item: CatalogItem, observation: Observation) => {
    if (item.lockedByOwner) return;
    setSelected(item);
    setEditing(observation);
    setDraftObservationId(observation.id);
    setTemporary(false);
    setDraft({
      location: observation.location,
      normal: String(observation.countNormal),
      maintenance: String(observation.countMaintenance),
      damaged: String(observation.countDamaged),
      unknown: String(observation.countConditionUnknown),
      missing: observation.missingComponents.join(", "),
      note: observation.note,
      temporaryLabel: "",
      identificationStatus: "confirmed",
      zeroConfirmed: true,
    });
    setPhoto(null);
  };

  const openTemporary = () => {
    setSelected(null);
    setEditing(null);
    setDraftObservationId(crypto.randomUUID());
    setTemporary(true);
    setDraft({ ...EMPTY_DRAFT, identificationStatus: "unlisted" });
    setPhoto(null);
  };

  /** 저장된 관측 1건을 워크스페이스(관측 목록 + 카탈로그 진행 상태)에 병합 */
  const applyObservationToWorkspace = useCallback((saved: Observation) => {
    setWorkspace((current) => {
      if (!current) return current;
      const observations = current.observations.some((row) => row.id === saved.id)
        ? current.observations.map((row) => (row.id === saved.id ? saved : row))
        : [...current.observations, saved];
      const catalog = current.catalog.map((item) => {
        if (item.equipmentId !== saved.equipmentId) return item;
        const rows = observations.filter((row) => row.equipmentId === item.equipmentId);
        const issue = rows.some((row) =>
          row.countMaintenance > 0 || row.countDamaged > 0 || row.countConditionUnknown > 0 || row.missingComponents.length > 0,
        );
        const progress: CatalogItem["progress"] = issue ? "issue" : "counted";
        return { ...item, progress, observationCount: rows.length };
      });
      return { ...current, observations, catalog };
    });
  }, []);

  const saveObservation = async (closeAfter = false) => {
    const counts = countsFromDraft(draft);
    if (!counts) return setError("네 가지 수량을 0 이상의 정수로 입력해 주세요.");
    if (counts.every((count) => count === 0) && !draft.zeroConfirmed) {
      return setError("실물이 0개임을 직접 확인했다는 체크가 필요합니다.");
    }
    if (temporary && !draft.temporaryLabel.trim()) return setError("장비를 알아볼 수 있는 설명을 입력해 주세요.");
    const sessionId = workspace?.activeDraft?.id;
    if (!sessionId) return setError("진행 중인 실사를 찾지 못했습니다.");

    setSaving(true);
    setError("");
    try {
      // 신규 관측도 폼을 열 때 발급한 id를 재사용 — 저장 재시도가 새 관측을 만들지 않는다
      const id = editing?.id ?? (draftObservationId || crypto.randomUUID());
      const putObservation = async (base: Observation | null) =>
        readJson(
          await authFetch(`/api/inventory-audits/${sessionId}/observations`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              id,
              equipmentId: temporary ? null : selected?.equipmentId ?? null,
              temporaryCode: temporary ? `TMP-${id}` : null,
              temporaryLabel: temporary ? draft.temporaryLabel.trim() : null,
              location: normalizeAuditLocation(draft.location),
              countNormal: counts[0],
              countMaintenance: counts[1],
              countDamaged: counts[2],
              countConditionUnknown: counts[3],
              missingComponents: draft.missing.split(",").map((value) => value.trim()).filter(Boolean),
              note: draft.note.trim(),
              identificationStatus: temporary ? draft.identificationStatus : "confirmed",
              clientUpdatedAt: nextTimestamp(base?.clientUpdatedAt),
              expectedClientUpdatedAt: base?.clientUpdatedAt ?? null,
            }),
          }),
        );

      let result: Record<string, unknown>;
      try {
        result = await putObservation(editing);
      } catch (cause) {
        // 409(stale_write) 복구: 서버가 실어준 현재 관측으로 기준을 맞춘 뒤 1회 자동 재시도 —
        // 낡은 expectedClientUpdatedAt 때문에 사용자가 영구히 저장 불가에 빠지지 않게 한다
        const current =
          cause instanceof ApiError && cause.code === "stale_write"
            ? observationFromBody(cause.body.currentObservation)
            : null;
        if (!current) throw cause;
        applyObservationToWorkspace(current);
        setEditing(current);
        result = await putObservation(current);
      }
      const saved = result.observation as Observation;

      // 관측 저장 성공은 사진 업로드 결과와 무관하게 즉시 로컬 상태에 반영한다
      applyObservationToWorkspace(saved);
      setEditing(saved);

      if (photo) {
        try {
          const blob = await compressInventoryAuditEvidence(photo);
          const evidenceId = crypto.randomUUID();
          const form = new FormData();
          form.set("observationId", saved.id);
          form.set("evidenceId", evidenceId);
          form.set("file", blob, `${evidenceId}.jpg`);
          await readJson(
            await authFetch(`/api/inventory-audits/${sessionId}/evidence`, {
              method: "POST",
              body: form,
            }),
          );
        } catch (cause) {
          // 관측은 이미 저장됨 — 폼을 열어 둔 채 같은 관측 id로 사진만 다시 시도하게 한다
          const detail = cause instanceof Error && cause.message ? ` (${cause.message})` : "";
          setError(`항목은 저장됐고 사진만 실패했습니다${detail}. 다시 저장하면 사진만 다시 전송됩니다.`);
          return;
        }
      }

      setSelected(null);
      setEditing(null);
      setTemporary(false);
      setDraft(EMPTY_DRAFT);
      setPhoto(null);
      setSavedNotice(photo ? "항목과 사진 저장 완료" : "항목 저장 완료");
      if (closeAfter) setOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "저장하지 못했습니다.");
    } finally {
      setSaving(false);
    }
  };

  const submit = async () => {
    const sessionId = workspace?.activeDraft?.id;
    if (!sessionId || !routeDone) return;
    if (!window.confirm(`전체 매장 확인을 마치고 제출합니다. 미계수 ${progress.uncounted}개가 포함됩니다. 제출할까요?`)) return;
    setSaving(true);
    setError("");
    try {
      await readJson(
        await authFetch(`/api/inventory-audits/${sessionId}/submit`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ pendingObservationWrites: 0, pendingEvidenceUploads: 0 }),
        }),
      );
      setOpen(false);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "제출하지 못했습니다.");
    } finally {
      setSaving(false);
    }
  };

  const submitted = workspace?.latestCallerSession && ["submitted", "in_review", "recount_requested"].includes(workspace.latestCallerSession.status);
  const ownedDraft = workspace?.activeDraft && workspace.globalDraft.ownedByCaller;

  return (
    <>
      <section className="rounded-xl bg-white p-3.5 shadow-card ring-1 ring-brand-200">
        <div className="text-[14px] font-bold text-ink">전체 재고 실사</div>
        {workspace?.isOwner && workspace.ownerQueue.length > 0 && (
          <button onClick={() => setOwnerReviewSessionId(workspace.ownerQueue[0].id)} className="tap mt-2 w-full rounded-lg bg-attention-bg px-4 py-3 text-[13px] font-bold text-attention-fg ring-1 ring-attention-fg/20">
            사장님 검토 · {workspace.ownerQueue.length}건
          </button>
        )}
        {workspace?.isOwner && workspace.activeDraft && (
          <button onClick={() => setOwnerReviewSessionId(workspace.activeDraft!.id)} className="tap mt-2 w-full rounded-lg bg-warn-bg px-4 py-3 text-[13px] font-bold text-warn-fg ring-1 ring-warn-fg/20">
            현재 저장분 검토 · {workspace.catalog.filter((item) => item.progress !== "uncounted" && item.progress !== "approved").length}개
          </button>
        )}
        {loading ? (
          <div className="mt-1 text-[12px] text-ink-mute">실사 상태 확인 중…</div>
        ) : error && !workspace ? (
          <div className="mt-2">
            <div className="text-[12px] font-semibold text-attention-fg">{error}</div>
            <button onClick={retry} className="tap mt-2 rounded-lg bg-white px-3 py-2 text-[12px] font-bold ring-1 ring-line">다시 시도</button>
          </div>
        ) : submitted ? (
          <div className="mt-2 rounded-lg bg-checkin-bg px-3 py-2 text-[13px] font-bold text-checkin-fg">제출 완료 · 사장님 승인 대기</div>
        ) : workspace?.globalDraft.active && !ownedDraft ? (
          <div className="mt-2 text-[12.5px] font-semibold text-ink-mute">다른 직원이 전체 실사를 진행 중입니다.</div>
        ) : ownedDraft ? (
          <button onClick={() => setOpen(true)} className="tap mt-2 w-full rounded-lg bg-brand-600 px-4 py-3 text-[14px] font-bold text-white">전체 재고 실사 이어하기 · {workspace?.observations.length ?? 0}건 저장됨</button>
        ) : (
          <>
            <div className="mt-1 text-[12px] text-ink-mute">반출·반납·자리 이동을 모두 멈춘 뒤 시작해 주세요.</div>
            <button disabled={saving} onClick={start} className="tap mt-2 w-full rounded-lg bg-brand-600 px-4 py-3 text-[14px] font-bold text-white disabled:opacity-50">장비 이동 중지 확인 · 실사 시작</button>
          </>
        )}
      </section>

      {open && ownedDraft && (
        <div className="fixed inset-0 z-[100] flex flex-col bg-paper">
          <header className="safe-top flex items-center justify-between border-b border-line bg-white px-3 py-3">
            <div>
              <div className="text-[15px] font-bold text-ink">전체 재고 실사</div>
              <div className="text-[11.5px] text-ink-mute">완료 {progress.counted}/{progress.all} · 미계수 {progress.uncounted} · 문제 {progress.issue}</div>
            </div>
            <button
              disabled={saving}
              onClick={() => {
                if (selected || temporary) void saveObservation(true);
                else setOpen(false);
              }}
              className="tap rounded-lg px-3 py-2 text-[12px] font-bold text-ink-mute ring-1 ring-line disabled:opacity-50"
            >
              저장하고 나가기
            </button>
          </header>

          {selected || temporary ? (
            <div className="flex-1 overflow-y-auto p-3 pb-40">
              <button onClick={() => { setSelected(null); setEditing(null); setTemporary(false); setError(""); }} className="tap mb-3 text-[13px] font-bold text-brand-700">← 목록으로</button>
              <div className="rounded-xl bg-white p-4 shadow-card ring-1 ring-line">
                <div className="text-[16px] font-bold text-ink">{temporary ? "식별 불확실·목록 외 장비" : selected?.name}</div>
                {!temporary && <div className="mt-0.5 text-[11.5px] text-ink-mute">{selected?.equipmentId}</div>}
                {temporary && (
                  <>
                    <label className="mt-3 block text-[12px] font-bold text-ink-mute">식별 상태</label>
                    <select value={draft.identificationStatus} onChange={(event) => setDraft((value) => ({ ...value, identificationStatus: event.target.value as Draft["identificationStatus"] }))} className="mt-1 w-full rounded-lg px-3 py-2.5 ring-1 ring-line">
                      <option value="unlisted">목록에 없음</option>
                      <option value="uncertain">식별 불확실</option>
                    </select>
                    <AuditInput label="장비 설명·모델명" value={draft.temporaryLabel} onChange={(value) => setDraft((row) => ({ ...row, temporaryLabel: value }))} />
                  </>
                )}
                <AuditInput label="현재 위치" value={draft.location} onChange={(value) => setDraft((row) => ({ ...row, location: value }))} placeholder="예: A 선반, 창고" />
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <CountInput label="정상" value={draft.normal} onChange={(value) => setDraft((row) => ({ ...row, normal: value, zeroConfirmed: false }))} />
                  <CountInput label="정비중" value={draft.maintenance} onChange={(value) => setDraft((row) => ({ ...row, maintenance: value, zeroConfirmed: false }))} />
                  <CountInput label="파손·격리" value={draft.damaged} onChange={(value) => setDraft((row) => ({ ...row, damaged: value, zeroConfirmed: false }))} />
                  <CountInput label="상태 미확인" value={draft.unknown} onChange={(value) => setDraft((row) => ({ ...row, unknown: value, zeroConfirmed: false }))} />
                </div>
                {countsFromDraft(draft)?.every((count) => count === 0) && (
                  <label className="mt-3 flex gap-2 rounded-lg bg-warn-bg p-3 text-[12px] font-semibold text-warn-fg">
                    <input type="checkbox" checked={draft.zeroConfirmed} onChange={(event) => setDraft((row) => ({ ...row, zeroConfirmed: event.target.checked }))} />
                    해당 위치를 직접 확인했고 실물이 없었습니다.
                  </label>
                )}
                <AuditInput label="누락 구성품" value={draft.missing} onChange={(value) => setDraft((row) => ({ ...row, missing: value }))} placeholder="쉼표로 구분" />
                <AuditInput label="특이사항" value={draft.note} onChange={(value) => setDraft((row) => ({ ...row, note: value }))} placeholder="파손 위치, 시리얼 등" />
                <label className="mt-3 block text-[12px] font-bold text-ink-mute">사진</label>
                <input type="file" accept="image/*" capture="environment" onChange={(event) => setPhoto(event.target.files?.[0] ?? null)} className="mt-1 block w-full text-[12px]" />
                {photo && <div className="mt-2 rounded-lg bg-checkin-bg px-3 py-2 text-[12px] font-bold text-checkin-fg">사진 선택됨 · 저장 버튼을 누르면 함께 저장됩니다.</div>}
                {error && <div className="mt-3 rounded-lg bg-attention-bg p-2.5 text-[12px] font-semibold text-attention-fg">{error}</div>}
              </div>
              <div className="safe-bottom fixed inset-x-0 bottom-0 z-20 border-t border-line bg-white p-3 shadow-card">
                <div className="mb-2 text-center text-[11.5px] font-semibold text-ink-mute">저장된 항목은 앱을 닫아도 유지됩니다.</div>
                <div className="grid grid-cols-2 gap-2">
                  <button disabled={saving} onClick={() => void saveObservation(false)} className="tap rounded-lg bg-brand-600 px-3 py-3 text-[13px] font-bold text-white disabled:opacity-50">{saving ? "저장 중…" : "현재 항목 저장"}</button>
                  <button disabled={saving} onClick={() => void saveObservation(true)} className="tap rounded-lg bg-ink px-3 py-3 text-[13px] font-bold text-white disabled:opacity-50">저장하고 나가기</button>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto p-3 pb-32">
              <div className="sticky top-0 z-10 space-y-2 bg-paper pb-2">
                <div className="rounded-lg bg-checkin-bg px-3 py-2 text-[12px] font-bold text-checkin-fg">
                  현재 {workspace?.observations.length ?? 0}건 서버 저장 완료 · 앱을 닫아도 유지됩니다.
                  {savedNotice && <div className="mt-0.5">{savedNotice}</div>}
                </div>
                <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="장비명·ID·별칭 검색" className="w-full rounded-lg bg-white px-3 py-3 text-[13px] ring-1 ring-line" />
                <div className="flex gap-1.5 overflow-x-auto">
                  {(["all", "uncounted", "counted", "issue"] as const).map((value) => (
                    <button key={value} onClick={() => setFilter(value)} className={`shrink-0 rounded-full px-3 py-1.5 text-[12px] font-bold ring-1 ${filter === value ? "bg-brand-50 text-brand-700 ring-brand-200" : "bg-white text-ink-mute ring-line"}`}>
                      {{ all: "전체", uncounted: "미계수", counted: "계수완료", issue: "문제" }[value]}
                    </button>
                  ))}
                </div>
                <button onClick={openTemporary} className="tap w-full rounded-lg bg-white px-3 py-2.5 text-[13px] font-bold text-brand-700 ring-1 ring-brand-200">＋ 식별 불확실·목록 외 장비 추가</button>
              </div>

              <div className="space-y-2">
                {catalog.map((item) => {
                  const rows = observationsByEquipment.get(item.equipmentId) ?? [];
                  return (
                    <div key={item.equipmentId} className="rounded-xl bg-white p-3 ring-1 ring-line">
                      <button disabled={item.lockedByOwner} onClick={() => openNewObservation(item)} className="tap w-full text-left disabled:cursor-default">
                        <div className="flex items-center justify-between gap-2">
                          <div className="min-w-0">
                            <div className="truncate text-[13.5px] font-bold text-ink">{item.name}</div>
                            <div className="text-[11px] text-ink-mute">{item.equipmentId} · {item.category ?? item.major ?? "미분류"}</div>
                          </div>
                          <span className={`shrink-0 rounded-full px-2 py-1 text-[11px] font-bold ${item.progress === "uncounted" ? "bg-line/40 text-ink-mute" : item.progress === "issue" ? "bg-attention-bg text-attention-fg" : "bg-checkin-bg text-checkin-fg"}`}>{item.progress === "uncounted" ? "미계수" : item.progress === "issue" ? "문제" : item.progress === "approved" ? "사장님 확정" : "완료"}</span>
                        </div>
                      </button>
                      {rows.length > 0 && (
                        <div className="mt-2 space-y-1 border-t border-line pt-2">
                          {rows.map((row) => (
                            <button disabled={item.lockedByOwner} key={row.id} onClick={() => openExistingObservation(item, row)} className="tap flex w-full justify-between rounded-lg bg-paper px-2.5 py-2 text-left text-[11.5px] disabled:cursor-default">
                              <span className="font-semibold text-ink-soft">{row.location}</span>
                              <span className="text-ink-mute">합계 {row.countNormal + row.countMaintenance + row.countDamaged + row.countConditionUnknown} · {item.lockedByOwner ? "확정됨" : "수정"}</span>
                            </button>
                          ))}
                          {!item.lockedByOwner && <button onClick={() => openNewObservation(item)} className="tap w-full py-1.5 text-[11.5px] font-bold text-brand-700">＋ 다른 위치에서 추가</button>}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {!selected && !temporary && (
            <div className="safe-bottom fixed inset-x-0 bottom-0 border-t border-line bg-white p-3">
              <label className="flex items-center gap-2 text-[12px] font-semibold text-ink-soft">
                <input type="checkbox" checked={routeDone} onChange={(event) => setRouteDone(event.target.checked)} />
                매장 전체 동선을 끝까지 확인했습니다.
              </label>
              <button disabled={!routeDone || saving || progress.counted === 0} onClick={submit} className="tap mt-2 w-full rounded-lg bg-brand-600 px-4 py-3 text-[14px] font-bold text-white disabled:opacity-40">{saving ? "제출 중…" : `전체 실사 제출 · 미계수 ${progress.uncounted}개`}</button>
              {error && <div className="mt-1 text-[11.5px] font-semibold text-attention-fg">{error}</div>}
            </div>
          )}
        </div>
      )}

      {ownerReviewSessionId && (
        <InventoryAuditReview
          sessionId={ownerReviewSessionId}
          onClose={() => setOwnerReviewSessionId(null)}
          onChanged={load}
        />
      )}
    </>
  );
}

function AuditInput({ label, value, onChange, placeholder }: { label: string; value: string; onChange(value: string): void; placeholder?: string }) {
  return (
    <label className="mt-3 block">
      <span className="text-[12px] font-bold text-ink-mute">{label}</span>
      <input value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} className="mt-1 w-full rounded-lg px-3 py-2.5 text-[13px] ring-1 ring-line" />
    </label>
  );
}

function CountInput({ label, value, onChange }: { label: string; value: string; onChange(value: string): void }) {
  return (
    <label>
      <span className="text-[11.5px] font-bold text-ink-mute">{label}</span>
      <input inputMode="numeric" value={value} onChange={(event) => onChange(event.target.value)} className="mt-1 w-full rounded-lg px-3 py-3 text-center text-[16px] font-bold tabular-nums ring-1 ring-line" />
    </label>
  );
}
