"use client";

import { useState } from "react";
import type { EquipmentItem, ReturnCount, Trade } from "@/lib/domain/types";
import { groupBySet, rcOf } from "@/lib/domain/status";
import { setReturnCount, setItemMemo } from "@/lib/data/store";
import { SetBox, LooseList } from "./SetBox";
import { Check } from "./icons";

// 반납도 반출과 동일하게 세트별 구획(세트명 헤더 + 구성품). 줄(scheduleId) 단위로 회수 체크.
export function ReturnChecklist({ trade }: { trade: Trade }) {
  const booked = trade.equipments.filter((e) => !e.onsite && e.checkoutState !== "excluded");
  const onsite = trade.equipments.filter((e) => e.onsite && e.checkoutState !== "excluded");

  return (
    <div className="mt-1.5">
      <p className="mb-1.5 px-0.5 text-[12px] text-ink-mute">
        다 받은 줄은 왼쪽 <span className="font-bold text-checkin-fg">네모를 체크</span>하세요. 개수가 안 맞으면 줄을 눌러 수정.
      </p>
      <div className="space-y-2">
        {groupBySet(booked).map((g) =>
          g.setName ? (
            <SetBox key={g.key} name={g.setName}>
              {g.rows.map((e) => <ReturnRow key={e.scheduleId} t={trade} e={e} />)}
            </SetBox>
          ) : (
            <LooseList key={g.key}>
              {g.rows.map((e) => <ReturnRow key={e.scheduleId} t={trade} e={e} />)}
            </LooseList>
          ),
        )}
      </div>

      {onsite.length > 0 && (
        <div className="mt-2 rounded-xl border border-brand-200 bg-brand-50/40 p-1.5">
          <div className="px-1.5 py-1 text-[11.5px] font-bold text-brand-700">현장 추가 {onsite.length}건</div>
          <div className="space-y-1.5">
            {groupBySet(onsite).map((g) =>
              g.setName ? (
                <SetBox key={g.key} name={g.setName}>
                  {g.rows.map((e) => <ReturnRow key={e.scheduleId} t={trade} e={e} />)}
                </SetBox>
              ) : (
                <LooseList key={g.key}>
                  {g.rows.map((e) => <ReturnRow key={e.scheduleId} t={trade} e={e} />)}
                </LooseList>
              ),
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ReturnRow({ t, e }: { t: Trade; e: EquipmentItem }) {
  const [open, setOpen] = useState(false);
  const expected = e.takenQty ?? e.qty;
  const { good, damaged, lost, memo } = rcOf(t, e.scheduleId);
  const allGood = good === expected && damaged === 0 && lost === 0;
  const touched = good + damaged + lost > 0;
  const missing = Math.max(0, expected - good - damaged - lost);
  const set = (p: Partial<ReturnCount>) => setReturnCount(t.tradeId, e.scheduleId, p);

  return (
    <li>
      <div className="flex items-center gap-3 px-3 py-2.5">
        <button
          onClick={() => set(allGood ? { good: 0, damaged: 0, lost: 0 } : { good: expected - damaged - lost })}
          aria-label="회수 완료 체크"
          className={`tap flex h-9 w-9 shrink-0 items-center justify-center rounded-lg shadow-sm ${
            allGood ? "bg-checkin-fg text-white" : "border-2 border-ink-faint/50 bg-white text-transparent"
          }`}
        >
          <Check className="h-5 w-5" />
        </button>

        <button onClick={() => setOpen((o) => !o)} className="flex min-w-0 flex-1 flex-col justify-center gap-0.5 text-left">
          <span className="flex items-center gap-1.5">
            <span className={`truncate text-[14.5px] font-medium ${allGood ? "text-ink-mute" : "text-ink"}`}>{e.name}</span>
            <span className="shrink-0 text-[13px] font-bold tabular-nums text-ink">×{expected}</span>
            {e.onsite && <span className="shrink-0 rounded bg-brand-100 px-1 text-[10px] font-bold text-brand-700">현장</span>}
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

      {open && (
        <div className="space-y-2 bg-black/[0.02] px-3 py-2.5">
          <div className="flex items-center gap-2 text-[12.5px]">
            <span className="text-ink-soft">회수 수량</span>
            <Stepper value={good} max={expected - damaged - lost} onChange={(v) => set({ good: v })} />
            <span className="text-ink-mute">/ {expected}</span>
          </div>
          <div className="flex items-center gap-2 text-[12.5px]">
            <span className="w-10 font-semibold text-attention-fg">파손</span>
            <Stepper value={damaged} max={expected - good - lost} onChange={(v) => set({ damaged: v })} small />
            <span className="ml-2 w-10 font-semibold text-attention-fg">분실</span>
            <Stepper value={lost} max={expected - good - damaged} onChange={(v) => set({ lost: v })} small />
          </div>
          <input
            defaultValue={memo ?? ""}
            onBlur={(ev) => {
              set({ memo: ev.target.value });
              setItemMemo(t.tradeId, e.scheduleId, "checkin", ev.target.value);
            }}
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
