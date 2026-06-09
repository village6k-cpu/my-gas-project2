"use client";

import type { Phase, RiskWarning } from "@/lib/domain/types";
import { Alert } from "./icons";

const LEVEL: Record<string, string> = {
  high: "bg-attention-bg text-attention-fg ring-attention-ring",
  medium: "bg-warn-bg text-warn-fg ring-warn-ring",
  low: "bg-black/5 text-ink-mute ring-black/10",
};

export function RiskPanel({ warnings, phase }: { warnings: RiskWarning[]; phase: Phase }) {
  const list = warnings.filter((w) => w.phase === phase);
  if (!list.length) return null;
  return (
    <div className="mt-3 space-y-2">
      {list.map((w) => (
        <div key={w.id} className={`rounded-xl p-3 ring-1 ${LEVEL[w.riskLevel]}`}>
          <div className="flex items-start gap-2">
            <Alert className="mt-0.5 h-4 w-4 shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-[13px] font-bold">{w.equipmentName}</span>
                <span className="rounded-md bg-white/70 px-1.5 py-0.5 text-[10px] font-semibold">
                  {w.guidanceState}
                </span>
              </div>
              <p className="mt-0.5 text-[12.5px] leading-snug opacity-90">{w.customerMessage}</p>
              {w.guidanceState === "발송권장" && (
                <div className="mt-2 flex gap-1.5">
                  <button className="tap rounded-lg bg-white px-2.5 py-1 text-[12px] font-semibold ring-1 ring-black/10">
                    카톡 안내 발송
                  </button>
                  <button className="tap rounded-lg px-2.5 py-1 text-[12px] font-semibold opacity-70">
                    확인함
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
