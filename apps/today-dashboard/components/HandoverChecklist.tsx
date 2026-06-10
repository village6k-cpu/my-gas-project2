"use client";

import { useEffect, useLayoutEffect, useRef, useState, type RefObject, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { EquipmentItem, Phase, Settlement, Trade } from "@/lib/domain/types";
import { groupBySet, handoverSummary } from "@/lib/domain/status";
import { categoryOf, coarseGroup } from "@/lib/domain/catalog";
import { searchEquipmentCatalog, useEquipmentCatalog, type EquipmentCatalogItem } from "@/lib/data/equipmentCatalog";
import { SetBox, LooseList } from "./SetBox";
import {
  addOnsiteItems,
  removeItem,
  setItemCheckout,
  setItemName,
  setItemMemo,
  setItemQty,
  setOnsiteSettlement,
  setPhaseNote,
  type OnsiteEntry,
} from "@/lib/data/store";
import { Check, Plus } from "./icons";
import { ReturnChecklist } from "./ReturnChecklist";

const MEDIA_RE = /배터리|CFexpress|SD카드|미디어/;
type SetGroup = ReturnType<typeof groupBySet>[number];
type FloatingRect = { left: number; top: number; width: number; maxHeight: number };

function sameSetName(a?: string | null, b?: string | null): boolean {
  const norm = (value?: string | null) => String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
  return !!norm(a) && norm(a) === norm(b);
}

function singleControllableSetItem(g: SetGroup): EquipmentItem | null {
  if (!g.setName) return null;
  if (g.rows.length === 0) return g.header ?? null;
  if (g.rows.length === 1 && sameSetName(g.rows[0].name, g.setName)) return g.rows[0];
  return null;
}

function SetSingleList({ children }: { children: ReactNode }) {
  return <ul className="divide-y divide-brand-200/70 overflow-hidden rounded-xl bg-brand-50 shadow-card ring-1 ring-brand-200">{children}</ul>;
}

export function HandoverChecklist({ trade, phase }: { trade: Trade; phase: Phase }) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [adding, setAdding] = useState(false);
  const summary = handoverSummary(trade, phase);
  const toggle = (id: string) => setExpanded((m) => ({ ...m, [id]: !m[id] }));

  const booked = trade.equipments.filter((e) => !e.onsite);
  const onsite = trade.equipments.filter((e) => e.onsite);

  return (
    <div className="mt-1.5">
      {summary.length > 0 && (
        <div className="mb-1.5 flex flex-wrap gap-1">
          {summary.map((s, i) => (
            <span key={i} className="rounded-md bg-line/40 px-2 py-0.5 text-[11.5px] font-semibold text-ink-soft">{s}</span>
          ))}
        </div>
      )}

      {phase === "checkin" ? (
        <ReturnChecklist trade={trade} />
      ) : (
        <>
          {/* 예약분 — 세트별 구획(세트명 헤더) */}
          <div className="space-y-2">
            {groupBySet(booked).map((g) => {
              const singleSetItem = singleControllableSetItem(g);
              return g.setName ? (
                singleSetItem ? (
                  <SetSingleList key={g.key}>
                    <CheckoutRow key={singleSetItem.scheduleId} t={trade} e={singleSetItem} open={!!expanded[singleSetItem.scheduleId]} onToggle={() => toggle(singleSetItem.scheduleId)} setBadge setTone />
                  </SetSingleList>
                ) : (
                  <SetBox key={g.key} name={g.setName}>
                    {g.rows.map((e) => (
                      <CheckoutRow key={e.scheduleId} t={trade} e={e} open={!!expanded[e.scheduleId]} onToggle={() => toggle(e.scheduleId)} />
                    ))}
                  </SetBox>
                )
              ) : (
                <LooseList key={g.key}>
                  {g.rows.map((e) => (
                    <CheckoutRow key={e.scheduleId} t={trade} e={e} open={!!expanded[e.scheduleId]} onToggle={() => toggle(e.scheduleId)} />
                  ))}
                </LooseList>
              );
            })}
          </div>

          {/* 현장 추가 — 별도 그룹 */}
          <div className="mt-2 rounded-xl border border-brand-200 bg-brand-50/40 p-1.5">
            <div className="flex items-center gap-1.5 px-1.5 py-1 text-[11.5px] font-bold text-brand-700">
              <span className="inline-flex h-4 items-center rounded bg-brand-600 px-1.5 text-[10px] text-white">현장 추가</span>
              <span className="text-brand-700/70">{onsite.length}건 · 라인·암·악세사리 등</span>
            </div>
            {onsite.length > 0 && (
              <div className="space-y-1.5">
                {groupBySet(onsite).map((g) => {
                  const singleSetItem = singleControllableSetItem(g);
                  return g.setName ? (
                    singleSetItem ? (
                      <SetSingleList key={g.key}>
                        <CheckoutRow key={singleSetItem.scheduleId} t={trade} e={singleSetItem} open={!!expanded[singleSetItem.scheduleId]} onToggle={() => toggle(singleSetItem.scheduleId)} setBadge setTone />
                      </SetSingleList>
                    ) : (
                      <SetBox
                        key={g.key}
                        name={g.setName}
                        onRemove={() => {
                          if (g.header) removeItem(trade.tradeId, g.header.scheduleId);
                          g.rows.forEach((r) => removeItem(trade.tradeId, r.scheduleId));
                        }}
                      >
                        {g.rows.map((e) => (
                          <CheckoutRow key={e.scheduleId} t={trade} e={e} open={!!expanded[e.scheduleId]} onToggle={() => toggle(e.scheduleId)} />
                        ))}
                      </SetBox>
                    )
                  ) : (
                    <LooseList key={g.key}>
                      {g.rows.map((e) => (
                        <CheckoutRow key={e.scheduleId} t={trade} e={e} open={!!expanded[e.scheduleId]} onToggle={() => toggle(e.scheduleId)} />
                      ))}
                    </LooseList>
                  );
                })}
              </div>
            )}
            {adding ? (
              <OnsiteCombobox tradeId={trade.tradeId} onClose={() => setAdding(false)} />
            ) : (
              <button onClick={() => setAdding(true)} className="tap mt-1.5 flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-brand-300 bg-white py-2 text-[13px] font-semibold text-brand-700">
                <Plus className="h-4 w-4" /> 현장 항목 추가
              </button>
            )}
          </div>
        </>
      )}

      <PhaseNote trade={trade} phase={phase} />
    </div>
  );
}

function rowTint(e: EquipmentItem, excluded: boolean): string {
  if (excluded) return "bg-attention-bg/30";
  if (e.onsite) return "";
  // 세트 구성품은 세트 밑에 묶이므로 악세사리 톤 안 입힘. loose하게 단독으로 있는 라인·암만 구분.
  if (!e.isComponent && coarseGroup(e.category) === "악세사리·라인") return "border-l-2 border-warn-ring bg-warn-bg/40";
  return "";
}

function CheckoutRow({ t, e, open, onToggle, setBadge = false, setTone = false }: { t: Trade; e: EquipmentItem; open: boolean; onToggle: () => void; setBadge?: boolean; setTone?: boolean }) {
  const taken = e.checkoutState === "taken";
  const excluded = e.checkoutState === "excluded";
  const partial = e.takenQty != null && e.takenQty !== e.qty;
  return (
    <li className={`px-3 ${setTone ? "bg-brand-50" : rowTint(e, excluded)}`}>
      <div className="flex items-center gap-2.5 py-2.5">
        {setBadge && <span className="shrink-0 rounded-md bg-brand-600 px-1.5 py-0.5 text-[10px] font-bold text-white">세트</span>}
        <button
          onClick={() => setItemCheckout(t.tradeId, e.scheduleId, "taken")}
          className={`tap flex h-6 w-6 shrink-0 items-center justify-center rounded-md border-2 ${
            taken ? "border-brand-600 bg-brand-600 text-white" : excluded ? "border-attention-ring bg-white text-attention-fg" : "border-line bg-white text-transparent"
          }`}
        >
          {excluded ? <span className="text-[13px] font-black">✕</span> : <Check className="h-3.5 w-3.5" />}
        </button>

        <button onClick={onToggle} className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
          <span className={`truncate text-[14px] ${excluded ? "text-ink-faint line-through" : setTone ? "font-extrabold text-brand-700" : taken ? "text-ink" : "text-ink-soft"}`}>{e.name}</span>
          {e.offCatalog && <span className="shrink-0 rounded bg-line/40 px-1 text-[10px] font-semibold text-ink-faint">자유입력</span>}
        </button>

        <span className={`shrink-0 rounded-md px-1.5 py-0.5 text-[12px] font-semibold tabular-nums ${e.emphasize ? "bg-warn-bg text-warn-fg ring-1 ring-warn-ring" : "text-ink-mute"}`}>
          {partial ? `${e.takenQty}/${e.qty}` : `×${e.qty}`}
        </span>

        {e.onsite ? (
          <button onClick={() => removeItem(t.tradeId, e.scheduleId)} className="tap shrink-0 px-1 text-ink-faint">✕</button>
        ) : (
          <button onClick={() => setItemCheckout(t.tradeId, e.scheduleId, "excluded")} className={`tap shrink-0 rounded-md px-1.5 py-1 text-[11.5px] font-bold ${excluded ? "bg-attention-fg text-white" : "text-ink-faint ring-1 ring-line"}`}>제외</button>
        )}
      </div>

      {e.onsite && !e.isComponent && (
        <div className="flex items-center gap-1 pb-2 pl-9">
          {(["무상", "유상"] as Settlement[]).map((s) => (
            <button key={s} onClick={() => setOnsiteSettlement(t.tradeId, e.scheduleId, s)} className={`tap rounded-md px-2 py-0.5 text-[11px] font-bold ${e.settlement === s ? "bg-brand-600 text-white" : "text-ink-mute ring-1 ring-line"}`}>{s}</button>
          ))}
        </div>
      )}

      {open && (
        <div className="space-y-2 pb-2.5 pl-9">
          <div className="block text-[12px] font-semibold text-ink-mute">
            장비명
            <EquipmentNameCombobox value={e.name} onSave={(v) => setItemName(t.tradeId, e.scheduleId, v)} />
          </div>
          <div className="flex items-center gap-2 text-[12px] text-ink-mute">
            예약 수량
            <Stepper value={e.qty} min={1} onChange={(v) => setItemQty(t.tradeId, e.scheduleId, v)} />
          </div>
          <MemoInput value={e.memoCheckout ?? ""} onSave={(v) => setItemMemo(t.tradeId, e.scheduleId, "checkout", v)} placeholder="이 품목 반출 메모 (예: 본인 지참)" />
        </div>
      )}
    </li>
  );
}

function OnsiteCombobox({ tradeId, onClose }: { tradeId: string; onClose: () => void }) {
  const catalog = useEquipmentCatalog();
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<EquipmentCatalogItem | null>(null);
  const [qty, setQty] = useState(1);
  const [settlement, setSettlement] = useState<Settlement>("무상");

  const matches = searchEquipmentCatalog(catalog.items, q);
  const exact = matches.some((m) => m.name === q.trim());
  const showList = q.trim().length > 0 && !picked;
  const isSet = !!picked?.components?.length;
  const catalogByName = new Map(catalog.items.map((item) => [item.name, item]));

  const submit = () => {
    const name = picked ? picked.name : q.trim();
    if (!name) return;
    let entries: OnsiteEntry[];
    if (isSet && picked) {
      entries = [
        { name: picked.name, qty: 1, category: "세트", isSetHeader: true, setName: picked.name },
        ...(picked.components ?? []).map((c) => ({
          name: c.name,
          qty: c.qty,
          category: catalogByName.get(c.name)?.category ?? categoryOf(c.name),
          isComponent: true,
          setName: picked.name,
          emphasize: MEDIA_RE.test(c.name),
        })),
      ];
    } else {
      entries = [{ name, qty, category: picked?.category ?? "소품·기타", offCatalog: !picked, emphasize: MEDIA_RE.test(name) }];
    }
    addOnsiteItems(tradeId, entries, settlement);
    onClose();
  };

  return (
    <div className="mt-1.5 space-y-2 rounded-lg border border-brand-300 bg-white p-2.5">
      <div>
        <input
          autoFocus
          value={picked ? picked.name : q}
          onChange={(e) => { setPicked(null); setQ(e.target.value); }}
          placeholder="품목·세트 검색 (목록에서 선택 · 없으면 자유입력)"
          className="w-full rounded-lg border border-line bg-white px-3 py-2 text-[13.5px] outline-none focus:border-brand-500"
        />
        {picked && (
          <div className="mt-1 flex items-center gap-1.5 text-[11.5px]">
            <span className="rounded bg-brand-100 px-1.5 py-0.5 font-bold text-brand-700">{picked.category === "세트" ? "세트" : coarseGroup(picked.category)}</span>
            <span className="text-ink-mute">{isSet ? "세트 — 구성품 자동 전개 · 재고 연동" : "재고 연동됨"}</span>
            <button onClick={() => { setPicked(null); setQ(""); }} className="ml-auto text-ink-faint">변경</button>
          </div>
        )}
        {showList && (
          <div className="mt-1 max-h-44 overflow-y-auto rounded-lg ring-1 ring-line">
            {matches.map((m) => (
              <button key={m.name} onClick={() => { setPicked(m); setQ(m.name); }} className="tap flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-black/[0.03]">
                <span className="flex-1 text-[13px] text-ink">{m.name}</span>
                <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${m.category === "세트" ? "bg-brand-100 text-brand-700" : coarseGroup(m.category) === "악세사리·라인" ? "bg-warn-ring/60 text-warn-fg" : "bg-line/40 text-ink-mute"}`}>{m.category === "세트" ? "세트" : coarseGroup(m.category)}</span>
              </button>
            ))}
            {!exact && (
              <button onClick={submit} className="tap flex w-full items-center gap-2 border-t border-line/60 bg-paper/70 px-2.5 py-1.5 text-left">
                <Plus className="h-3.5 w-3.5 text-ink-mute" />
                <span className="text-[13px] text-ink-soft">‘{q.trim()}’ 자유입력 추가</span>
                <span className="ml-auto rounded bg-line/40 px-1.5 py-0.5 text-[10px] font-semibold text-ink-faint">재고 미연동</span>
              </button>
            )}
          </div>
        )}
      </div>

      <div className="flex items-center gap-2">
        {!isSet && <Stepper value={qty} onChange={setQty} />}
        <div className="flex gap-1">
          {(["무상", "유상"] as Settlement[]).map((s) => (
            <button key={s} onClick={() => setSettlement(s)} className={`tap rounded-md px-2.5 py-1 text-[12px] font-bold ${settlement === s ? "bg-brand-600 text-white" : "text-ink-mute ring-1 ring-line"}`}>{s}</button>
          ))}
        </div>
        <div className="ml-auto flex gap-1.5">
          <button onClick={onClose} className="tap rounded-lg px-2.5 py-1.5 text-[12.5px] font-semibold text-ink-mute">취소</button>
          <button onClick={submit} disabled={!(picked || q.trim())} className="tap rounded-lg bg-brand-600 px-3 py-1.5 text-[12.5px] font-bold text-white disabled:opacity-40">추가</button>
        </div>
      </div>
    </div>
  );
}

function PhaseNote({ trade, phase }: { trade: Trade; phase: Phase }) {
  const initial = phase === "checkout" ? trade.noteCheckout : trade.noteCheckin;
  const [val, setVal] = useState(initial ?? "");
  const [dirty, setDirty] = useState(false);
  const label = phase === "checkout" ? "반출 전체 메모" : "반납 전체 메모";
  return (
    <details className="group mt-2">
      <summary className="cursor-pointer list-none text-[11.5px] font-semibold text-ink-faint">+ {label} {initial && !dirty ? "(작성됨)" : ""}</summary>
      <div className="mt-1.5">
        <textarea
          value={val}
          onChange={(e) => { setVal(e.target.value); setDirty(true); }}
          rows={2}
          placeholder={`${label} (품목과 무관한 일반 사항만)`}
          className="w-full resize-none rounded-lg border border-line bg-white px-3 py-2 text-[13px] outline-none placeholder:text-ink-faint focus:border-brand-500"
        />
        {dirty && (
          <div className="mt-1 flex justify-end">
            <button onClick={() => { setPhaseNote(trade.tradeId, phase, val); setDirty(false); }} className="tap rounded-lg bg-brand-600 px-3 py-1 text-[12px] font-semibold text-white">저장</button>
          </div>
        )}
      </div>
    </details>
  );
}

function Stepper({ value, min = 0, max, onChange }: { value: number; min?: number; max?: number; onChange: (v: number) => void }) {
  return (
    <div className="inline-flex items-center overflow-hidden rounded-lg ring-1 ring-line">
      <button onClick={() => onChange(Math.max(min, value - 1))} className="tap h-7 w-7 bg-white text-[15px] font-bold text-ink-soft">−</button>
      <span className="w-7 text-center text-[13px] font-bold tabular-nums">{value}</span>
      <button onClick={() => onChange(max != null ? Math.min(max, value + 1) : value + 1)} className="tap h-7 w-7 bg-white text-[15px] font-bold text-ink-soft">+</button>
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
  freeLabel,
}: {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  items: EquipmentCatalogItem[];
  exact: boolean;
  query: string;
  onSelect: (item: EquipmentCatalogItem) => void;
  onFreeInput: () => void;
  freeLabel: string;
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
          <span className="text-[13px] text-ink-soft">‘{query.trim()}’ {freeLabel}</span>
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
  const exact = matches.some((m) => m.name === q.trim());
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
            if (matches[0] && !exact) select(matches[0]);
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
      <FloatingCatalogMenu open={showList} anchorRef={inputRef} items={matches} exact={exact} query={q} onSelect={select} onFreeInput={() => saveValue(q)} freeLabel="자유입력 저장" />
    </div>
  );
}

function MemoInput({ value, onSave, placeholder }: { value: string; onSave: (v: string) => void; placeholder: string }) {
  const [v, setV] = useState(value);
  const [dirty, setDirty] = useState(false);
  return (
    <input
      value={v}
      onChange={(e) => { setV(e.target.value); setDirty(true); }}
      onBlur={() => { if (dirty) { onSave(v); setDirty(false); } }}
      placeholder={placeholder}
      className="w-full rounded-lg border border-line bg-white px-2.5 py-1.5 text-[12.5px] outline-none placeholder:text-ink-faint focus:border-brand-500"
    />
  );
}
