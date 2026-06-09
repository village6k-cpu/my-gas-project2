"use client";

import { useState } from "react";
import type { Trade } from "@/lib/domain/types";
import { aggregateReturns, missingOf, type AggReturn } from "@/lib/domain/status";
import { coarseGroup } from "@/lib/domain/catalog";
import { setReturnCount } from "@/lib/data/store";
import { Check } from "./icons";

export function ReturnChecklist({ trade }: { trade: Trade }) {
  const aggs = aggregateReturns(trade);
  const rows: React.ReactNode[] = [];
  let lastG = "";
  for (const a of aggs) {
    const g = coarseGroup(a.category);
    if (g !== lastG) {
      rows.push(
        <li key={`h-${g}`} className={`px-3 py-1 text-[11px] font-bold ${g === "장비" ? "bg-black/[0.03] text-ink-soft" : "bg-amber-50 text-amber-700"}`}>
          {g}
        </li>,
      );
      lastG = g;
    }
    rows.push(<ReturnRow key={a.name} tradeId={trade.tradeId} a={a} />);
  }
  return (
    <div className="mt-1.5">
      <p className="mb-1.5 px-0.5 text-[12px] text-ink-mute">
        다 받은 품목은 왼쪽 <span className="font-bold text-checkin-fg">네모를 체크</span>하세요. 개수가 안 맞으면 품목을 눌러 수정.
      </p>
      <ul className="divide-y divide-black/5 overflow-hidden rounded-xl bg-white ring-1 ring-black/5">{rows}</ul>
    </div>
  );
}

function ReturnRow({ tradeId, a }: { tradeId: string; a: AggReturn }) {
  const [open, setOpen] = useState(false);
  const { good, damaged, lost, memo } = a.count;
  const missing = missingOf(a);
  const allGood = good === a.expected && damaged === 0 && lost === 0;
  const touched = good + damaged + lost > 0;
  const acc = coarseGroup(a.category) === "악세사리·라인";
  const set = (p: Partial<typeof a.count>) => setReturnCount(tradeId, a.name, p);

  return (
    <li className={acc ? "bg-amber-50/30" : ""}>
      <div className="flex items-center gap-3 px-3 py-3">
        {/* 큰 네모 체크박스 = 회수 완료 */}
        <button
          onClick={() => set(allGood ? { good: 0, damaged: 0, lost: 0 } : { good: a.expected - damaged - lost })}
          aria-label="회수 완료 체크"
          className={`tap flex h-9 w-9 shrink-0 items-center justify-center rounded-lg shadow-sm ${
            allGood ? "bg-checkin-fg text-white" : "border-2 border-ink-faint/50 bg-white text-transparent"
          }`}
        >
          <Check className="h-5 w-5" />
        </button>

        {/* 품목명 + 수량 (탭 → 수정) */}
        <button onClick={() => setOpen((o) => !o)} className="flex min-w-0 flex-1 flex-col justify-center gap-0.5 text-left">
          <span className="flex items-center gap-1.5">
            <span className={`truncate text-[14.5px] font-medium ${allGood ? "text-ink-mute" : "text-ink"}`}>{a.name}</span>
            <span className="shrink-0 text-[13px] font-bold tabular-nums text-ink">×{a.expected}</span>
            {a.onsiteQty > 0 && <span className="shrink-0 rounded bg-brand-100 px-1 text-[10px] font-bold text-brand-700">현장 +{a.onsiteQty}</span>}
          </span>
          {touched && !allGood && (
            <span className="text-[11.5px] font-bold text-attention-fg">
              {missing > 0 ? `미반납 ${missing}` : ""}
              {damaged > 0 ? ` 파손 ${damaged}` : ""}
              {lost > 0 ? ` 분실 ${lost}` : ""}
            </span>
          )}
        </button>
      </div>

      {/* 문제 입력 — 평소 숨김, 줄을 눌러야 나옴 */}
      {open && (
        <div className="space-y-2 bg-black/[0.02] px-3 py-2.5">
          <div className="flex items-center gap-2 text-[12.5px]">
            <span className="text-ink-soft">회수 수량</span>
            <Stepper value={good} max={a.expected - damaged - lost} onChange={(v) => set({ good: v })} />
            <span className="text-ink-mute">/ {a.expected}</span>
          </div>
          <div className="flex items-center gap-2 text-[12.5px]">
            <span className="w-10 font-semibold text-attention-fg">파손</span>
            <Stepper value={damaged} max={a.expected - good - lost} onChange={(v) => set({ damaged: v })} small />
            <span className="ml-2 w-10 font-semibold text-attention-fg">분실</span>
            <Stepper value={lost} max={a.expected - good - damaged} onChange={(v) => set({ lost: v })} small />
          </div>
          <input
            defaultValue={memo ?? ""}
            onBlur={(e) => set({ memo: e.target.value })}
            placeholder="메모 (예: 1번 라인 단선)"
            className="w-full rounded-lg border border-black/10 bg-white px-2.5 py-1.5 text-[12.5px] outline-none placeholder:text-ink-faint focus:border-brand-500"
          />
        </div>
      )}
    </li>
  );
}

function Stepper({ value, max, onChange, small }: { value: number; max: number; onChange: (v: number) => void; small?: boolean }) {
  const s = small ? "h-6 w-6 text-[13px]" : "h-7 w-7 text-[15px]";
  return (
    <div className="inline-flex items-center overflow-hidden rounded-lg ring-1 ring-black/15">
      <button onClick={() => onChange(Math.max(0, value - 1))} className={`tap bg-white font-bold text-ink-soft ${s}`}>−</button>
      <span className={`text-center font-bold tabular-nums ${small ? "w-6 text-[12px]" : "w-8 text-[13px]"}`}>{value}</span>
      <button onClick={() => onChange(Math.min(Math.max(0, max), value + 1))} className={`tap bg-white font-bold text-ink-soft ${s}`}>+</button>
    </div>
  );
}
