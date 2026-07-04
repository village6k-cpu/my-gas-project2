"use client";

import { useState } from "react";
import type { Phase, RiskWarning } from "@/lib/domain/types";
import { sanitizeCautionDisplayText } from "@/lib/domain/cautions";
import { authFetch } from "@/lib/data/authFetch";
import { Alert } from "./icons";

function severityLabel(severity?: number): string {
  if (severity === 3) return "필수";
  if (severity === 2) return "중요";
  return "권장";
}

export function RiskPanel({ warnings, phase }: { warnings: RiskWarning[]; phase: Phase }) {
  const [hiddenCautionIds, setHiddenCautionIds] = useState<Set<string>>(new Set());

  function handleDismissCaution(cautionId: string) {
    setHiddenCautionIds((prev) => {
      const next = new Set(prev);
      next.add(cautionId);
      return next;
    });
    void authFetch(`/api/cautions?id=${encodeURIComponent(cautionId)}`, { method: "DELETE" }).catch(() => {});
  }

  const list = warnings
    .filter((w) => w.source === "cardCaution" && w.phase === phase && w.customerMessage.trim())
    .filter((w) => !w.cautionId || !hiddenCautionIds.has(w.cautionId))
    .map((w) => ({ ...w, customerMessage: sanitizeCautionDisplayText(w.customerMessage) }))
    .filter((w) => w.customerMessage)
    .slice(0, 5);
  if (!list.length) return null;
  const hiddenCount = Math.max(0, ...list.map((w) => Number(w.hiddenCount || 0) || 0));
  return (
    <div className="mt-3 rounded-xl bg-paper/80 p-3 ring-1 ring-line">
      {list.map((w) => (
        <div key={w.id} className="flex items-start gap-2 py-1.5">
          <Alert className={`mt-0.5 h-4 w-4 shrink-0 ${w.severity === 3 ? "text-attention-fg" : "text-ink-faint"}`} />
          <div className={`min-w-0 flex-1 text-[12.5px] leading-snug ${w.severity === 3 ? "font-extrabold text-attention-fg" : "font-normal text-ink-mute"}`}>
            <div>{severityLabel(w.severity)}{w.equipmentName ? ` · ${w.equipmentName}` : ""}</div>
            <p>{w.customerMessage}</p>
          </div>
          {w.cautionId && !hiddenCautionIds.has(w.cautionId) && (
            <button
              type="button"
              aria-label="주의사항 숨김"
              title="주의사항 숨김"
              className="grid h-5 w-5 shrink-0 place-items-center rounded-full text-[13px] font-semibold text-ink-faint hover:bg-line/80 hover:text-ink"
              onClick={(event) => {
                event.stopPropagation();
                if (w.cautionId) handleDismissCaution(w.cautionId);
              }}
            >
              ✕
            </button>
          )}
        </div>
      ))}
      {hiddenCount > 0 && (
        <button type="button" className="mt-1 text-[12px] font-semibold text-ink-faint">
          외 {hiddenCount}건 ▸
        </button>
      )}
    </div>
  );
}
