"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { EquipmentItem, ReturnCount, Trade } from "@/lib/domain/types";
import { groupBySet, isRealDeviceHeader, rcOf, singleControllableSetItem } from "@/lib/domain/status";
import { coarseGroup } from "@/lib/domain/catalog";
import { searchEquipmentCatalog, useEquipmentCatalog, type EquipmentCatalogItem } from "@/lib/data/equipmentCatalog";
import { setItemName, setItemQty, setReturnCount, setItemMemo } from "@/lib/data/store";
import { SetBox, LooseList } from "./SetBox";
import { Check, Plus } from "./icons";

type FloatingRect = { left: number; top: number; width: number; maxHeight: number };

function catalogExactKey(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, "");
}

function SetSingleList({ children }: { children: ReactNode }) {
  return <ul className="divide-y divide-brand-200/70 overflow-hidden rounded-xl bg-brand-50 shadow-card ring-1 ring-brand-200">{children}</ul>;
}

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
                headerRow={isRealDeviceHeader(g.header, g.rows) ? <ReturnRow key={g.header!.scheduleId} t={trade} e={g.header!} setBadge setTone /> : undefined}
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
                    headerRow={isRealDeviceHeader(g.header, g.rows) ? <ReturnRow key={g.header!.scheduleId} t={trade} e={g.header!} setBadge setTone /> : undefined}
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

function itemMemoText(e: EquipmentItem): string {
  return String(e.memoCheckout || e.memoCheckin || "").trim();
}

function ReturnRow({ t, e, setBadge = false, setTone = false }: { t: Trade; e: EquipmentItem; setBadge?: boolean; setTone?: boolean }) {
  const [open, setOpen] = useState(false);
  const expected = e.takenQty ?? e.qty;
  const { good, damaged, lost, memo } = rcOf(t, e.scheduleId);
  const itemMemo = itemMemoText(e) || String(memo || "").trim();
  const allGood = good === expected && damaged === 0 && lost === 0;
  const touched = good + damaged + lost > 0;
  const missing = Math.max(0, expected - good - damaged - lost);
  const set = (p: Partial<ReturnCount>) => setReturnCount(t.tradeId, e.scheduleId, p);

  return (
    <li className={`px-3 ${setTone ? "bg-brand-50" : ""}`}>
      <div className="flex items-center gap-2.5 py-2.5">
        {setBadge && <span className="shrink-0 rounded-md bg-brand-600 px-1.5 py-0.5 text-[10px] font-bold text-white">세트</span>}
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
            <span className={`truncate text-[14.5px] ${setTone ? "font-extrabold text-brand-700" : allGood ? "font-medium text-ink-mute" : "font-medium text-ink"}`}>{e.name}</span>
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

      {/* 특이사항 — 반출/반납 카드가 같은 내용을 항상 보이게 한다. */}
      {itemMemo && (
        <button onClick={() => setOpen((o) => !o)} className="tap -mt-1 mb-2 ml-[46px] flex max-w-full items-start gap-1 rounded-md bg-warn-bg px-2 py-1 text-left text-[12px] font-bold leading-snug text-warn-fg ring-1 ring-warn-ring">
          <span aria-hidden>📝</span>
          <span className="shrink-0">특이사항:</span>
          <span className="min-w-0 break-words">{itemMemo}</span>
        </button>
      )}

      {open && (
        <div className="space-y-2 bg-paper/70 py-2.5">
          {itemMemo && (
            <div className="rounded-lg bg-warn-bg px-2.5 py-1.5 text-[12px] font-semibold leading-snug text-warn-fg ring-1 ring-warn-ring">
              <span className="font-bold">특이사항</span> · {itemMemo}
            </div>
          )}
          <div className="block text-[12px] font-semibold text-ink-mute">
            장비명
            <EquipmentNameCombobox value={e.name} onSave={(v) => setItemName(t.tradeId, e.scheduleId, v)} />
          </div>
          <div className="flex items-center gap-2 text-[12px] text-ink-mute">
            예약 수량
            <Stepper value={e.qty} min={1} max={99} onChange={(v) => setItemQty(t.tradeId, e.scheduleId, v)} />
          </div>
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
            defaultValue={itemMemo}
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

function FloatingCatalogMenu({
  open,
  anchorRef,
  items,
  exact,
  query,
  onSelect,
  onFreeInput,
}: {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  items: EquipmentCatalogItem[];
  exact: boolean;
  query: string;
  onSelect: (item: EquipmentCatalogItem) => void;
  onFreeInput: () => void;
}) {
  const [rect, setRect] = useState<FloatingRect | null>(null);

  useLayoutEffect(() => {
    if (!open || typeof window === "undefined") {
      setRect(null);
      return undefined;
    }

    const update = () => {
      const anchor = anchorRef.current;
      if (!anchor) return;
      const box = anchor.getBoundingClientRect();
      const gap = 4;
      const minHeight = 128;
      const preferredHeight = 176;
      const below = window.innerHeight - box.bottom - 8;
      const above = box.top - 8;
      const openUp = below < minHeight && above > below;
      const available = Math.max(minHeight, Math.min(preferredHeight, openUp ? above : below));
      setRect({
        left: Math.max(8, box.left),
        top: openUp ? Math.max(8, box.top - available - gap) : box.bottom + gap,
        width: Math.max(180, Math.min(box.width, window.innerWidth - Math.max(8, box.left) - 8)),
        maxHeight: available,
      });
    };

    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [anchorRef, items.length, open, query]);

  if (!open || !rect || typeof document === "undefined") return null;

  return createPortal(
    <div
      className="rounded-lg bg-white shadow-pop ring-1 ring-line"
      style={{
        position: "fixed",
        left: rect.left,
        top: rect.top,
        width: rect.width,
        maxHeight: rect.maxHeight,
        overflowY: "auto",
        zIndex: 9999,
      }}
    >
      {items.map((m) => (
        <button
          key={m.name}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onSelect(m)}
          className="tap flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-black/[0.03]"
        >
          <span className="flex-1 truncate text-[13px] text-ink">{m.name}</span>
          <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${m.category === "세트" ? "bg-brand-100 text-brand-700" : coarseGroup(m.category) === "악세사리·라인" ? "bg-warn-ring/60 text-warn-fg" : "bg-line/40 text-ink-mute"}`}>{m.category === "세트" ? "세트" : coarseGroup(m.category)}</span>
        </button>
      ))}
      {!exact && (
        <button
          onMouseDown={(event) => event.preventDefault()}
          onClick={onFreeInput}
          className="tap flex w-full items-center gap-2 border-t border-line/60 bg-paper/70 px-2.5 py-1.5 text-left"
        >
          <Plus className="h-3.5 w-3.5 text-ink-mute" />
          <span className="text-[13px] text-ink-soft">‘{query.trim()}’ 자유입력 저장</span>
          <span className="ml-auto rounded bg-line/40 px-1.5 py-0.5 text-[10px] font-semibold text-ink-faint">재고 미연동</span>
        </button>
      )}
    </div>,
    document.body,
  );
}

function EquipmentNameCombobox({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const catalog = useEquipmentCatalog();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [q, setQ] = useState(value);
  const [dirty, setDirty] = useState(false);
  const [focused, setFocused] = useState(false);
  const [selected, setSelected] = useState<EquipmentCatalogItem | null>(null);
  const skipNextBlurSave = useRef(false);

  useEffect(() => {
    if (!dirty) {
      setQ(value);
      setSelected(null);
    }
  }, [dirty, value]);

  const matches = searchEquipmentCatalog(catalog.items, q);
  const exactMatch = catalog.items.find((m) => catalogExactKey(m.name) === catalogExactKey(q));
  const exact = !!exactMatch;
  const showList = focused && q.trim().length > 0 && !selected;

  const saveValue = (nextName: string) => {
    const clean = nextName.trim();
    if (!clean) return;
    if (clean !== value) onSave(clean);
    setQ(clean);
    setDirty(false);
  };

  const select = (item: EquipmentCatalogItem) => {
    setSelected(item);
    saveValue(item.name);
  };

  const save = () => {
    if (dirty) saveValue(q);
  };

  return (
    <div className="relative mt-1">
      <input
        ref={inputRef}
        value={q}
        onFocus={() => setFocused(true)}
        onChange={(e) => { setSelected(null); setQ(e.target.value); setDirty(true); }}
        onBlur={() => {
          setFocused(false);
          if (skipNextBlurSave.current) {
            skipNextBlurSave.current = false;
            return;
          }
          save();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            skipNextBlurSave.current = true;
            if (exactMatch) select(exactMatch);
            else save();
            e.currentTarget.blur();
          }
          if (e.key === "Escape") {
            skipNextBlurSave.current = true;
            setQ(value);
            setSelected(null);
            setDirty(false);
            e.currentTarget.blur();
          }
        }}
        placeholder="장비명 검색"
        className="w-full rounded-lg border border-line bg-white px-2.5 py-1.5 text-[12.5px] font-medium text-ink outline-none focus:border-brand-500"
      />
      {selected && (
        <div className="mt-1 flex items-center gap-1.5 text-[11.5px]">
          <span className="rounded bg-brand-100 px-1.5 py-0.5 font-bold text-brand-700">{selected.category === "세트" ? "세트" : coarseGroup(selected.category)}</span>
          <span className="text-ink-mute">재고 연동됨</span>
          <button onClick={() => { setSelected(null); setDirty(true); }} className="ml-auto text-ink-faint">변경</button>
        </div>
      )}
      <FloatingCatalogMenu open={showList} anchorRef={inputRef} items={matches} exact={exact} query={q} onSelect={select} onFreeInput={() => saveValue(q)} />
    </div>
  );
}
