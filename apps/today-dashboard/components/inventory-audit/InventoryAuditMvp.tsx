"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { authFetch } from "@/lib/data/authFetch";
import { compressInventoryAuditEvidence } from "@/lib/inventory-audit/compressEvidence";

type Session = { id: string; status: string };
type CatalogItem = {
  equipmentId: string;
  name: string;
  aliases: string[];
  major: string | null;
  category: string | null;
  progress: "uncounted" | "counted" | "issue";
  observationCount: number;
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
  globalDraft: { active: boolean; ownedByCaller: boolean };
  activeDraft: Session | null;
  latestCallerSession: Session | null;
  catalog: CatalogItem[];
  observations: Observation[];
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

async function readJson(response: Response) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(typeof body.error === "string" ? body.error : "처리하지 못했습니다.");
  }
  return body;
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
  const [temporary, setTemporary] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [photo, setPhoto] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [routeDone, setRouteDone] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = (await readJson(await authFetch("/api/inventory-audits", { cache: "no-store" }))) as Workspace;
      setWorkspace(data);
      onLockChange(data.globalDraft.active);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "실사 상태를 불러오지 못했습니다.");
      onLockChange(true);
    } finally {
      setLoading(false);
    }
  }, [onLockChange]);

  useEffect(() => {
    void load();
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
      )) as Workspace & { start?: unknown };
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
    setSelected(item);
    setEditing(null);
    setTemporary(false);
    setDraft(EMPTY_DRAFT);
    setPhoto(null);
  };

  const openExistingObservation = (item: CatalogItem, observation: Observation) => {
    setSelected(item);
    setEditing(observation);
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
    setTemporary(true);
    setDraft({ ...EMPTY_DRAFT, identificationStatus: "unlisted" });
    setPhoto(null);
  };

  const saveObservation = async () => {
    const counts = countsFromDraft(draft);
    if (!draft.location.trim()) return setError("현재 위치를 입력해 주세요.");
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
      const id = editing?.id ?? crypto.randomUUID();
      const clientUpdatedAt = nextTimestamp(editing?.clientUpdatedAt);
      const body = {
        id,
        equipmentId: temporary ? null : selected?.equipmentId ?? null,
        temporaryCode: temporary ? `TMP-${id}` : null,
        temporaryLabel: temporary ? draft.temporaryLabel.trim() : null,
        location: draft.location.trim(),
        countNormal: counts[0],
        countMaintenance: counts[1],
        countDamaged: counts[2],
        countConditionUnknown: counts[3],
        missingComponents: draft.missing.split(",").map((value) => value.trim()).filter(Boolean),
        note: draft.note.trim(),
        identificationStatus: temporary ? draft.identificationStatus : "confirmed",
        clientUpdatedAt,
        expectedClientUpdatedAt: editing?.clientUpdatedAt ?? null,
      };
      const result = await readJson(
        await authFetch(`/api/inventory-audits/${sessionId}/observations`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
      const saved = result.observation as Observation;

      if (photo) {
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
      }

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
      setSelected(null);
      setEditing(null);
      setTemporary(false);
      setDraft(EMPTY_DRAFT);
      setPhoto(null);
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
        {loading ? (
          <div className="mt-1 text-[12px] text-ink-mute">실사 상태 확인 중…</div>
        ) : error && !workspace ? (
          <div className="mt-2">
            <div className="text-[12px] font-semibold text-attention-fg">{error}</div>
            <button onClick={load} className="tap mt-2 rounded-lg bg-white px-3 py-2 text-[12px] font-bold ring-1 ring-line">다시 시도</button>
          </div>
        ) : submitted ? (
          <div className="mt-2 rounded-lg bg-checkin-bg px-3 py-2 text-[13px] font-bold text-checkin-fg">제출 완료 · 사장님 승인 대기</div>
        ) : workspace?.globalDraft.active && !ownedDraft ? (
          <div className="mt-2 text-[12.5px] font-semibold text-ink-mute">다른 직원이 전체 실사를 진행 중입니다.</div>
        ) : ownedDraft ? (
          <button onClick={() => setOpen(true)} className="tap mt-2 w-full rounded-lg bg-brand-600 px-4 py-3 text-[14px] font-bold text-white">전체 재고 실사 이어하기</button>
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
            <button onClick={() => { setSelected(null); setTemporary(false); setOpen(false); }} className="tap rounded-lg px-3 py-2 text-[13px] font-bold text-ink-mute ring-1 ring-line">닫기</button>
          </header>

          {selected || temporary ? (
            <div className="flex-1 overflow-y-auto p-3 pb-28">
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
                {error && <div className="mt-3 rounded-lg bg-attention-bg p-2.5 text-[12px] font-semibold text-attention-fg">{error}</div>}
                <button disabled={saving} onClick={saveObservation} className="tap mt-4 w-full rounded-lg bg-brand-600 px-4 py-3 text-[14px] font-bold text-white disabled:opacity-50">{saving ? "저장 중…" : editing ? "수정 저장" : "이 위치 계수 확정"}</button>
              </div>
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto p-3 pb-32">
              <div className="sticky top-0 z-10 space-y-2 bg-paper pb-2">
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
                      <button onClick={() => openNewObservation(item)} className="tap w-full text-left">
                        <div className="flex items-center justify-between gap-2">
                          <div className="min-w-0">
                            <div className="truncate text-[13.5px] font-bold text-ink">{item.name}</div>
                            <div className="text-[11px] text-ink-mute">{item.equipmentId} · {item.category ?? item.major ?? "미분류"}</div>
                          </div>
                          <span className={`shrink-0 rounded-full px-2 py-1 text-[11px] font-bold ${item.progress === "uncounted" ? "bg-line/40 text-ink-mute" : item.progress === "issue" ? "bg-attention-bg text-attention-fg" : "bg-checkin-bg text-checkin-fg"}`}>{item.progress === "uncounted" ? "미계수" : item.progress === "issue" ? "문제" : "완료"}</span>
                        </div>
                      </button>
                      {rows.length > 0 && (
                        <div className="mt-2 space-y-1 border-t border-line pt-2">
                          {rows.map((row) => (
                            <button key={row.id} onClick={() => openExistingObservation(item, row)} className="tap flex w-full justify-between rounded-lg bg-paper px-2.5 py-2 text-left text-[11.5px]">
                              <span className="font-semibold text-ink-soft">{row.location}</span>
                              <span className="text-ink-mute">합계 {row.countNormal + row.countMaintenance + row.countDamaged + row.countConditionUnknown} · 수정</span>
                            </button>
                          ))}
                          <button onClick={() => openNewObservation(item)} className="tap w-full py-1.5 text-[11.5px] font-bold text-brand-700">＋ 다른 위치에서 추가</button>
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
