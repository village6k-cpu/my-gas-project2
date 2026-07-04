"use client";

import { useState } from "react";
import type { EquipmentItem, Phase, RiskWarning } from "@/lib/domain/types";
import { sanitizeCautionDisplayText } from "@/lib/domain/cautions";
import { authFetch } from "@/lib/data/authFetch";
import { Alert, Check, Pencil, Plus } from "./icons";

function severityLabel(severity?: number): string {
  if (severity === 3) return "필수";
  if (severity === 2) return "중요";
  return "권장";
}

type SeverityText = "필수" | "중요" | "권장";
type DisplayCaution = RiskWarning & { actionId: string; customerMessage: string };

const SEVERITY_OPTIONS: SeverityText[] = ["필수", "중요", "권장"];
const COLLAPSED_CAUTION_LIMIT = 5;

function severityValue(severity: SeverityText): 1 | 2 | 3 {
  if (severity === "필수") return 3;
  if (severity === "권장") return 1;
  return 2;
}

function phaseLabel(phase: Phase): "반출" | "반납" {
  return phase === "checkin" ? "반납" : "반출";
}

function uniqueEquipmentNames(equipments: EquipmentItem[]): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  equipments.forEach((item) => {
    const name = item.name.trim();
    if (!name || seen.has(name)) return;
    seen.add(name);
    names.push(name);
  });
  return names;
}

async function responseMessage(res: Response): Promise<string> {
  try {
    const body = await res.json();
    return String(body?.error || body?.message || `HTTP ${res.status}`);
  } catch {
    return `HTTP ${res.status}`;
  }
}

function cautionActionId(warning: RiskWarning): string {
  return String(warning.cautionId || warning.id || "").trim();
}

function CautionRow({
  warning,
  editedText,
  editing,
  editSavingId,
  onDismiss,
  onStartEdit,
  onEditChange,
  onCancelEdit,
  onSaveEdit,
}: {
  warning: DisplayCaution;
  editedText?: string;
  editing: { id: string; text: string } | null;
  editSavingId: string | null;
  onDismiss: (cautionId: string) => void;
  onStartEdit: (cautionId: string, text: string) => void;
  onEditChange: (cautionId: string, text: string) => void;
  onCancelEdit: () => void;
  onSaveEdit: () => void;
}) {
  const text = editedText ?? warning.customerMessage;
  return (
    <div className="py-1.5" data-caution-id={warning.actionId}>
      <div className="flex items-start gap-2">
        <Alert className={`mt-0.5 h-4 w-4 shrink-0 ${warning.severity === 3 ? "text-attention-fg" : "text-ink-faint"}`} />
        <div className={`min-w-0 flex-1 text-[12.5px] leading-snug ${warning.severity === 3 ? "font-extrabold text-attention-fg" : "font-normal text-ink-mute"}`}>
          <div>{severityLabel(warning.severity)}{warning.equipmentName ? ` · ${warning.equipmentName}` : ""}</div>
          <p>{text}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            aria-label="주의사항 수정"
            title="주의사항 수정"
            data-caution-action="edit"
            data-caution-id={warning.actionId}
            className="grid h-5 w-5 place-items-center rounded-full text-ink-faint hover:bg-line/80 hover:text-ink"
            onClick={(event) => {
              event.stopPropagation();
              onStartEdit(warning.actionId, text);
            }}
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            aria-label="주의사항 숨김"
            title="주의사항 숨김"
            data-caution-action="delete"
            data-caution-id={warning.actionId}
            className="grid h-5 w-5 place-items-center rounded-full text-[13px] font-semibold text-ink-faint hover:bg-line/80 hover:text-ink"
            onClick={(event) => {
              event.stopPropagation();
              onDismiss(warning.actionId);
            }}
          >
            ✕
          </button>
        </div>
      </div>
      {editing && editing.id === warning.actionId && (
        <div className="mt-2 space-y-1.5 pl-6">
          <textarea
            value={editing.text}
            onChange={(event) => onEditChange(warning.actionId, event.target.value)}
            className="min-h-[68px] w-full resize-none rounded-lg border border-line bg-white px-2.5 py-2 text-[13px] font-medium leading-snug text-ink outline-none focus:border-brand-300"
            maxLength={200}
          />
          <div className="flex items-center justify-end gap-1.5">
            <button type="button" className="tap rounded-lg px-2.5 py-1.5 text-[12px] font-bold text-ink-faint" onClick={onCancelEdit}>
              취소
            </button>
            <button
              type="button"
              className="tap inline-flex items-center gap-1 rounded-lg bg-brand-600 px-2.5 py-1.5 text-[12px] font-bold text-white disabled:opacity-50"
              onClick={onSaveEdit}
              disabled={editSavingId === editing.id || !editing.text.trim()}
            >
              <Check className="h-3.5 w-3.5" /> 저장
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function RiskPanel({ warnings, phase, equipments }: { warnings: RiskWarning[]; phase: Phase; equipments: EquipmentItem[] }) {
  const [hiddenCautionIds, setHiddenCautionIds] = useState<Set<string>>(new Set());
  const [editedTexts, setEditedTexts] = useState<Record<string, string>>({});
  const [localWarnings, setLocalWarnings] = useState<RiskWarning[]>([]);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [editSavingId, setEditSavingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [addText, setAddText] = useState("");
  const [addEquipment, setAddEquipment] = useState("공통");
  const [addSeverity, setAddSeverity] = useState<SeverityText>("중요");
  const [savingAdd, setSavingAdd] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  function handleDismissCaution(cautionId: string) {
    setHiddenCautionIds((prev) => {
      const next = new Set(prev);
      next.add(cautionId);
      return next;
    });
    setLocalWarnings((prev) => prev.filter((w) => cautionActionId(w) !== cautionId));
    void authFetch(`/api/cautions?id=${encodeURIComponent(cautionId)}`, { method: "DELETE" }).catch(() => {});
  }

  async function handleSaveEdit() {
    if (!editing || editSavingId) return;
    const text = editing.text.trim();
    if (!text) return;
    setError(null);
    setEditSavingId(editing.id);
    try {
      const res = await authFetch(`/api/cautions?id=${encodeURIComponent(editing.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) throw new Error(await responseMessage(res));
      setEditedTexts((prev) => ({ ...prev, [editing.id]: text }));
      setLocalWarnings((prev) => prev.map((w) => (cautionActionId(w) === editing.id ? { ...w, customerMessage: text } : w)));
      setEditing(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setEditSavingId(null);
    }
  }

  async function handleAddCaution() {
    const text = addText.trim();
    if (!text || savingAdd) return;
    setError(null);
    setSavingAdd(true);
    const equipment = addEquipment.trim() || "공통";
    try {
      const res = await authFetch("/api/cautions", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ equipment, phase: phaseLabel(phase), text, severity: addSeverity }),
      });
      if (!res.ok) throw new Error(await responseMessage(res));
      const body = await res.json();
      const cautionId = String(body?.id || `local-${Date.now()}`);
      const equipmentName = equipment === "공통" ? "" : equipment;
      setLocalWarnings((prev) => [
        ...prev,
        {
          id: `card-caution:local:${cautionId}`,
          phase,
          equipmentName,
          riskLevel: severityValue(addSeverity) === 3 ? "high" : severityValue(addSeverity) === 2 ? "medium" : "low",
          customerMessage: text,
          guidanceState: severityValue(addSeverity) === 3 ? "발송권장" : "대상없음",
          source: "cardCaution",
          severity: severityValue(addSeverity),
          cautionId,
          scope: equipmentName ? "equipment" : "common",
          matchedItem: equipmentName || undefined,
        },
      ]);
      setAddText("");
      setAddEquipment("공통");
      setAddSeverity("중요");
      setAdding(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingAdd(false);
    }
  }

  function handleEditChange(cautionId: string, text: string) {
    setEditing((current) => current && current.id === cautionId ? { ...current, text } : current);
  }

  const combined = [...warnings, ...localWarnings];
  const seenKeys = new Set<string>();
  const allList: DisplayCaution[] = combined
    .filter((w) => w.source === "cardCaution" && w.phase === phase && w.customerMessage.trim())
    .map((w) => ({ ...w, actionId: cautionActionId(w) }))
    .filter((w) => !hiddenCautionIds.has(w.actionId))
    .map((w) => ({ ...w, customerMessage: sanitizeCautionDisplayText(editedTexts[w.actionId] ?? w.customerMessage) }))
    .filter((w) => w.customerMessage)
    .filter((w) => {
      const key = w.actionId;
      if (seenKeys.has(key)) return false;
      seenKeys.add(key);
      return true;
    });
  const visibleList = expanded ? allList : allList.slice(0, COLLAPSED_CAUTION_LIMIT);
  const serverHiddenCount = Math.max(0, ...allList.map((w) => Number(w.hiddenCount || 0) || 0));
  const hiddenBehindToggleCount = Math.max(0, allList.length - COLLAPSED_CAUTION_LIMIT);
  const hasMoreToggle = hiddenBehindToggleCount > 0;
  const equipmentNames = uniqueEquipmentNames(equipments);
  const canAdd = equipmentNames.length > 0;

  if (!allList.length && !adding && !canAdd) return null;

  return (
    <div className="mt-3 rounded-xl bg-paper/80 p-3 ring-1 ring-line">
      {visibleList.map((w) => (
        <CautionRow
          key={w.actionId}
          warning={w}
          editedText={editedTexts[w.actionId]}
          editing={editing}
          editSavingId={editSavingId}
          onDismiss={handleDismissCaution}
          onStartEdit={(cautionId, text) => setEditing({ id: cautionId, text })}
          onEditChange={handleEditChange}
          onCancelEdit={() => setEditing(null)}
          onSaveEdit={handleSaveEdit}
        />
      ))}
      {hasMoreToggle && (
        <button
          type="button"
          className="mt-1 text-[12px] font-semibold text-ink-faint"
          onClick={(event) => {
            event.stopPropagation();
            setExpanded((value) => !value);
          }}
        >
          {expanded ? "접기 ▴" : `외 ${hiddenBehindToggleCount}건 ▸`}
        </button>
      )}
      {serverHiddenCount > 0 && !hasMoreToggle && (
        <div className="mt-1 text-[12px] font-semibold text-ink-faint">외 {serverHiddenCount}건</div>
      )}
      {error && <div className="mt-2 rounded-lg bg-attention-bg px-2.5 py-1.5 text-[12px] font-bold text-attention-fg">{error}</div>}
      {adding ? (
        <div className="mt-2 space-y-2 rounded-lg bg-white p-2 ring-1 ring-line/70">
          <textarea
            value={addText}
            onChange={(event) => setAddText(event.target.value)}
            placeholder="주의사항 문구"
            className="min-h-[72px] w-full resize-none rounded-lg border border-line bg-paper/40 px-2.5 py-2 text-[13px] font-medium leading-snug text-ink outline-none focus:border-brand-300"
            maxLength={200}
          />
          <div className="grid grid-cols-[minmax(0,1fr)_96px] gap-1.5">
            <select
              value={addEquipment}
              onChange={(event) => setAddEquipment(event.target.value)}
              className="min-w-0 rounded-lg border border-line bg-white px-2 py-1.5 text-[12px] font-bold text-ink-soft outline-none"
            >
              <option value="공통">공통</option>
              {equipmentNames.map((name) => (
                <option key={name} value={name}>{name}</option>
              ))}
            </select>
            <select
              value={addSeverity}
              onChange={(event) => setAddSeverity(event.target.value as SeverityText)}
              className="rounded-lg border border-line bg-white px-2 py-1.5 text-[12px] font-bold text-ink-soft outline-none"
            >
              {SEVERITY_OPTIONS.map((severity) => (
                <option key={severity} value={severity}>{severity}</option>
              ))}
            </select>
          </div>
          <div className="flex items-center justify-end gap-1.5">
            <button type="button" className="tap rounded-lg px-2.5 py-1.5 text-[12px] font-bold text-ink-faint" onClick={() => setAdding(false)}>
              취소
            </button>
            <button
              type="button"
              className="tap inline-flex items-center gap-1 rounded-lg bg-brand-600 px-2.5 py-1.5 text-[12px] font-bold text-white disabled:opacity-50"
              onClick={handleAddCaution}
              disabled={savingAdd || !addText.trim()}
            >
              <Plus className="h-3.5 w-3.5" /> 추가
            </button>
          </div>
        </div>
      ) : (
        canAdd && (
          <button
            type="button"
            className="tap mt-2 inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-[12px] font-bold text-brand-700 ring-1 ring-brand-200"
            onClick={() => setAdding(true)}
          >
            <Plus className="h-3.5 w-3.5" /> 추가
          </button>
        )
      )}
    </div>
  );
}
