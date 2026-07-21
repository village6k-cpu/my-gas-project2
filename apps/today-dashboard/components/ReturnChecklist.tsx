"use client";

import { useState, type ReactNode } from "react";
import type { EquipmentItem, ReturnCount, Trade } from "@/lib/domain/types";
import { groupBySet, rcOf, realDeviceHeaders, singleControllableSetItem } from "@/lib/domain/status";
import { setReturnCount, setItemMemo } from "@/lib/data/store";
import { SetBox, LooseList } from "./SetBox";
import { Check } from "./icons";
import { MemoTag, itemMemoEntries } from "./MemoTag";
import { equipmentActualName, equipmentActualTakenQty, hasEquipmentActualCorrection } from "@/lib/domain/equipmentActual";

function SetSingleList({ children }: { children: ReactNode }) {
  return <ul className="divide-y divide-brand-200/70 overflow-hidden rounded-xl bg-brand-50 shadow-card ring-1 ring-brand-200">{children}</ul>;
}

// 반납도 반출과 동일하게 세트별 구획(세트명 헤더 + 구성품). 줄(scheduleId) 단위로 회수 체크.
export function ReturnChecklist({ trade }: { trade: Trade }) {
  const booked = trade.equipments.filter((e) => !e.onsite && e.checkoutState !== "excluded" && equipmentActualTakenQty(e) > 0);
  const onsite = trade.equipments.filter((e) => e.onsite && e.checkoutState !== "excluded" && equipmentActualTakenQty(e) > 0);

  return (
    <div className="mt-1.5">
      <p className="mb-1.5 px-0.5 text-[12px] text-ink-mute">
        다 받은 줄은 왼쪽 <span className="font-bold text-checkin-fg">네모를 체크</span>하세요. 개수가 안 맞으면 줄을 눌러 수정.
      </p>
      <div className="space-y-2">
        {groupBySet(booked).map((g) => {
          const singleSetItem = singleControllableSetItem(g);
          return g.setName ? (
            singleSetItem ? (
              <SetSingleList key={g.key}>
                <ReturnRow key={singleSetItem.scheduleId} t={trade} e={singleSetItem} setBadge setTone />
              </SetSingleList>
            ) : (
              <SetBox
                key={g.key}
                name={g.setName}
                headerRow={realDeviceHeaders(g).map((header) => <ReturnRow key={header.scheduleId} t={trade} e={header} setBadge setTone />)}
              >
                {g.rows.map((e) => <ReturnRow key={e.scheduleId} t={trade} e={e} />)}
              </SetBox>
            )
          ) : (
            <LooseList key={g.key}>
              {g.rows.map((e) => <ReturnRow key={e.scheduleId} t={trade} e={e} />)}
            </LooseList>
          );
        })}
      </div>

      {onsite.length > 0 && (
        <div className="mt-2 rounded-xl border border-brand-200 bg-brand-50/40 p-1.5">
          <div className="px-1.5 py-1 text-[11.5px] font-bold text-brand-700">현장 추가 {onsite.length}건</div>
          <div className="space-y-1.5">
            {groupBySet(onsite).map((g) => {
              const singleSetItem = singleControllableSetItem(g);
              return g.setName ? (
                singleSetItem ? (
                  <SetSingleList key={g.key}>
                    <ReturnRow key={singleSetItem.scheduleId} t={trade} e={singleSetItem} setBadge setTone />
                  </SetSingleList>
                ) : (
                  <SetBox
                    key={g.key}
                    name={g.setName}
                    headerRow={realDeviceHeaders(g).map((header) => <ReturnRow key={header.scheduleId} t={trade} e={header} setBadge setTone />)}
                  >
                    {g.rows.map((e) => <ReturnRow key={e.scheduleId} t={trade} e={e} />)}
                  </SetBox>
                )
              ) : (
                <LooseList key={g.key}>
                  {g.rows.map((e) => <ReturnRow key={e.scheduleId} t={trade} e={e} />)}
                </LooseList>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function ReturnRow({ t, e, setBadge = false, setTone = false }: { t: Trade; e: EquipmentItem; setBadge?: boolean; setTone?: boolean }) {
  const [open, setOpen] = useState(false);
  const expected = e.takenQty ?? e.qty;
  const actualExpected = equipmentActualTakenQty(e);
  const actualName = equipmentActualName(e);
  const corrected = hasEquipmentActualCorrection(e);
  const { good, damaged, lost, reportedMissing, memo } = rcOf(t, e.scheduleId);
  // 반출 때 적은 메모도 반납 카드에 그대로 보이되, 출처 태그로 구분한다
  const checkinMemo = String(e.memoCheckin || "").trim() || String(memo || "").trim();
  const memos = itemMemoEntries({ memoCheckout: e.memoCheckout, memoCheckin: checkinMemo });
  const allGood = good === actualExpected && damaged === 0 && lost === 0;
  const touched = good + damaged + lost > 0 || Number(reportedMissing || 0) > 0;
  const missing = Math.max(0, actualExpected - good - damaged - lost);
  const set = (p: Partial<ReturnCount>) => setReturnCount(t.tradeId, e.scheduleId, p);

  return (
    <li className={`px-3 ${setTone ? "bg-brand-50" : ""}`}>
      <div className="flex items-center gap-2.5 py-2.5">
        {setBadge && <span className="shrink-0 rounded-md bg-brand-600 px-1.5 py-0.5 text-[10px] font-bold text-white">세트</span>}
        <button
          onClick={() => set(allGood ? { good: 0, damaged: 0, lost: 0 } : { good: actualExpected - damaged - lost })}
          aria-label="회수 완료 체크"
          className={`tap flex h-9 w-9 shrink-0 items-center justify-center rounded-lg shadow-sm ${
            allGood ? "bg-checkin-fg text-white" : "border-2 border-ink-faint/50 bg-white text-transparent"
          }`}
        >
          <Check className="h-5 w-5" />
        </button>

        <button onClick={() => setOpen((o) => !o)} className="flex min-w-0 flex-1 flex-col justify-center gap-0.5 text-left">
          <span className="flex items-center gap-1.5">
            <span className={`truncate text-[14.5px] ${setTone ? "font-extrabold text-brand-700" : allGood ? "font-medium text-ink-mute" : "font-medium text-ink"}`}>{actualName}</span>
            <span className="shrink-0 text-[13px] font-bold tabular-nums text-ink">×{actualExpected}</span>
            {e.onsite && <span className="shrink-0 rounded bg-brand-100 px-1 text-[10px] font-bold text-brand-700">현장</span>}
            {corrected && <span className="shrink-0 rounded bg-warn-bg px-1 text-[10px] font-bold text-warn-fg ring-1 ring-warn-ring">Slack 정정</span>}
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

      {/* 특이사항 — 반출/반납 카드가 같은 내용을 항상 보이게 하되, 출처(반출/반납)를 구분한다. */}
      {memos.length > 0 && (
        <div className="-mt-1 mb-2 ml-[46px] space-y-1">
          {memos.map((m) => (
            <button key={m.phase} onClick={() => setOpen((o) => !o)} className="tap flex w-full max-w-full items-start gap-1 rounded-md bg-warn-bg px-2 py-1 text-left text-[12px] font-bold leading-snug text-warn-fg ring-1 ring-warn-ring">
              <span aria-hidden>📝</span>
              <MemoTag phase={m.phase} shared={m.shared} className="mt-[1px]" />
              <span className="min-w-0 break-words">{m.text}</span>
            </button>
          ))}
        </div>
      )}

      {open && (
        <div className="space-y-2 bg-paper/70 py-2.5">
          <div className="rounded-lg bg-line/20 px-2.5 py-1.5 text-[12px] text-ink-mute">
            반출 기준 <span className="font-bold text-ink">{e.name} · {expected}개</span>
            <span className="ml-1">(반출 후 장비명·예약 수량 수정 불가)</span>
            {corrected && <div className="mt-1 font-bold text-warn-fg">Slack 확인 실제값: {actualName} · {actualExpected}개</div>}
          </div>
          <div className="flex items-center gap-2 text-[12.5px]">
            <span className="text-ink-soft">회수 수량</span>
            <Stepper value={good} max={actualExpected - damaged - lost} onChange={(v) => set({ good: v })} />
            <span className="text-ink-mute">/ {actualExpected}</span>
          </div>
          <div className="flex items-center gap-2 text-[12.5px]">
            <span className="w-10 font-semibold text-attention-fg">파손</span>
            <Stepper value={damaged} max={actualExpected - good - lost} onChange={(v) => set({ damaged: v })} small />
            <span className="ml-2 w-10 font-semibold text-attention-fg">분실</span>
            <Stepper value={lost} max={actualExpected - good - damaged} onChange={(v) => set({ lost: v })} small />
          </div>
          <input
            defaultValue={checkinMemo}
            onBlur={(ev) => {
              const v = ev.target.value;
              set({ memo: v });
              setItemMemo(t.tradeId, e.scheduleId, "checkin", v);
            }}
            placeholder="이 품목 반납 메모 (예: 1번 라인 단선)"
            className="w-full rounded-lg border border-line bg-white px-2.5 py-1.5 text-[12.5px] outline-none placeholder:text-ink-faint focus:border-brand-500"
          />
        </div>
      )}
    </li>
  );
}

function Stepper({ value, min = 0, max, onChange, small }: { value: number; min?: number; max?: number; onChange: (v: number) => void; small?: boolean }) {
  const s = small ? "h-6 w-6 text-[13px]" : "h-7 w-7 text-[15px]";
  return (
    <div className="inline-flex items-center overflow-hidden rounded-lg ring-1 ring-line">
      <button onClick={() => onChange(Math.max(min, value - 1))} className={`tap bg-white font-bold text-ink-soft ${s}`}>−</button>
      <span className={`text-center font-bold tabular-nums ${small ? "w-6 text-[12px]" : "w-8 text-[13px]"}`}>{value}</span>
      <button onClick={() => onChange(max != null ? Math.min(Math.max(min, max), value + 1) : value + 1)} className={`tap bg-white font-bold text-ink-soft ${s}`}>+</button>
    </div>
  );
}
