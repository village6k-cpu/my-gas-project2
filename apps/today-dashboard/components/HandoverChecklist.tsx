"use client";

import { useState } from "react";
import type { EquipmentItem, Phase, Settlement, Trade } from "@/lib/domain/types";
import { groupBySet, handoverSummary } from "@/lib/domain/status";
import { categoryOf, coarseGroup, searchCatalog, SET_COMPOSITION, type CatalogItem } from "@/lib/domain/catalog";
import { SetBox, LooseList } from "./SetBox";
import {
  addOnsiteItems,
  removeItem,
  setItemCheckout,
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
            <span key={i} className="rounded-md bg-black/[0.05] px-2 py-0.5 text-[11.5px] font-semibold text-ink-soft">{s}</span>
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
                  <LooseList key={g.key}>
                    <CheckoutRow key={singleSetItem.scheduleId} t={trade} e={singleSetItem} open={!!expanded[singleSetItem.scheduleId]} onToggle={() => toggle(singleSetItem.scheduleId)} setBadge />
                  </LooseList>
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
                      <LooseList key={g.key}>
                        <CheckoutRow key={singleSetItem.scheduleId} t={trade} e={singleSetItem} open={!!expanded[singleSetItem.scheduleId]} onToggle={() => toggle(singleSetItem.scheduleId)} setBadge />
                      </LooseList>
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
  if (!e.isComponent && coarseGroup(e.category) === "악세사리·라인") return "border-l-2 border-amber-200 bg-amber-50/40";
  return "";
}

function CheckoutRow({ t, e, open, onToggle, setBadge = false }: { t: Trade; e: EquipmentItem; open: boolean; onToggle: () => void; setBadge?: boolean }) {
  const taken = e.checkoutState === "taken";
  const excluded = e.checkoutState === "excluded";
  const partial = e.takenQty != null && e.takenQty !== e.qty;
  return (
    <li className={`px-3 ${rowTint(e, excluded)}`}>
      <div className="flex items-center gap-2.5 py-2.5">
        <button
          onClick={() => setItemCheckout(t.tradeId, e.scheduleId, "taken")}
          className={`tap flex h-6 w-6 shrink-0 items-center justify-center rounded-md border-2 ${
            taken ? "border-brand-600 bg-brand-600 text-white" : excluded ? "border-attention-ring bg-white text-attention-fg" : "border-black/15 bg-white text-transparent"
          }`}
        >
          {excluded ? <span className="text-[13px] font-black">✕</span> : <Check className="h-3.5 w-3.5" />}
        </button>

        <button onClick={onToggle} className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
          {setBadge && <span className="shrink-0 rounded bg-brand-600 px-1.5 py-0.5 text-[10px] font-bold text-white">세트</span>}
          <span className={`truncate text-[14px] ${excluded ? "text-ink-faint line-through" : taken ? "text-ink" : "text-ink-soft"}`}>{e.name}</span>
          {e.offCatalog && <span className="shrink-0 rounded bg-black/5 px-1 text-[10px] font-semibold text-ink-faint">자유입력</span>}
        </button>

        <span className={`shrink-0 rounded-md px-1.5 py-0.5 text-[12px] font-semibold tabular-nums ${e.emphasize ? "bg-warn-bg text-warn-fg ring-1 ring-warn-ring" : "text-ink-mute"}`}>
          {partial ? `${e.takenQty}/${e.qty}` : `×${e.qty}`}
        </span>

        {e.onsite ? (
          <button onClick={() => removeItem(t.tradeId, e.scheduleId)} className="tap shrink-0 px-1 text-ink-faint">✕</button>
        ) : (
          <button onClick={() => setItemCheckout(t.tradeId, e.scheduleId, "excluded")} className={`tap shrink-0 rounded-md px-1.5 py-1 text-[11.5px] font-bold ${excluded ? "bg-attention-fg text-white" : "text-ink-faint ring-1 ring-black/10"}`}>제외</button>
        )}
      </div>

      {e.onsite && !e.isComponent && (
        <div className="flex items-center gap-1 pb-2 pl-9">
          {(["무상", "유상"] as Settlement[]).map((s) => (
            <button key={s} onClick={() => setOnsiteSettlement(t.tradeId, e.scheduleId, s)} className={`tap rounded-md px-2 py-0.5 text-[11px] font-bold ${e.settlement === s ? "bg-brand-600 text-white" : "text-ink-mute ring-1 ring-black/10"}`}>{s}</button>
          ))}
        </div>
      )}

      {open && (
        <div className="space-y-2 pb-2.5 pl-9">
          <div className="flex items-center gap-2 text-[12px] text-ink-mute">
            수량
            <Stepper value={e.takenQty ?? e.qty} max={e.qty} onChange={(v) => setItemQty(t.tradeId, e.scheduleId, v)} />
            <span>/ {e.qty}</span>
          </div>
          <MemoInput value={e.memoCheckout ?? ""} onSave={(v) => setItemMemo(t.tradeId, e.scheduleId, "checkout", v)} placeholder="이 품목 반출 메모 (예: 본인 지참)" />
        </div>
      )}
    </li>
  );
}

function OnsiteCombobox({ tradeId, onClose }: { tradeId: string; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<CatalogItem | null>(null);
  const [qty, setQty] = useState(1);
  const [settlement, setSettlement] = useState<Settlement>("무상");

  const matches = searchCatalog(q);
  const exact = matches.some((m) => m.name === q.trim());
  const showList = q.trim().length > 0 && !picked;
  const isSet = picked?.category === "세트" && !!SET_COMPOSITION[picked.name];

  const submit = () => {
    const name = picked ? picked.name : q.trim();
    if (!name) return;
    let entries: OnsiteEntry[];
    if (isSet && picked) {
      entries = [
        { name: picked.name, qty: 1, category: "세트", isSetHeader: true },
        ...SET_COMPOSITION[picked.name].map((c) => ({
          name: c.name,
          qty: c.qty,
          category: categoryOf(c.name),
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
          className="w-full rounded-lg border border-black/10 bg-white px-3 py-2 text-[13.5px] outline-none focus:border-brand-500"
        />
        {picked && (
          <div className="mt-1 flex items-center gap-1.5 text-[11.5px]">
            <span className="rounded bg-brand-100 px-1.5 py-0.5 font-bold text-brand-700">{isSet ? "세트" : coarseGroup(picked.category)}</span>
            <span className="text-ink-mute">{isSet ? "세트 — 구성품 자동 전개 · 재고 연동" : "재고 연동됨"}</span>
            <button onClick={() => { setPicked(null); setQ(""); }} className="ml-auto text-ink-faint">변경</button>
          </div>
        )}
        {showList && (
          <div className="mt-1 max-h-44 overflow-y-auto rounded-lg ring-1 ring-black/10">
            {matches.map((m) => (
              <button key={m.name} onClick={() => { setPicked(m); setQ(m.name); }} className="tap flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-black/[0.03]">
                <span className="flex-1 text-[13px] text-ink">{m.name}</span>
                <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${m.category === "세트" ? "bg-brand-100 text-brand-700" : coarseGroup(m.category) === "악세사리·라인" ? "bg-amber-100 text-amber-700" : "bg-black/5 text-ink-mute"}`}>{m.category === "세트" ? "세트" : coarseGroup(m.category)}</span>
              </button>
            ))}
            {!exact && (
              <button onClick={submit} className="tap flex w-full items-center gap-2 border-t border-black/5 bg-black/[0.02] px-2.5 py-1.5 text-left">
                <Plus className="h-3.5 w-3.5 text-ink-mute" />
                <span className="text-[13px] text-ink-soft">‘{q.trim()}’ 자유입력 추가</span>
                <span className="ml-auto rounded bg-black/5 px-1.5 py-0.5 text-[10px] font-semibold text-ink-faint">재고 미연동</span>
              </button>
            )}
          </div>
        )}
      </div>

      <div className="flex items-center gap-2">
        {!isSet && <Stepper value={qty} onChange={setQty} />}
        <div className="flex gap-1">
          {(["무상", "유상"] as Settlement[]).map((s) => (
            <button key={s} onClick={() => setSettlement(s)} className={`tap rounded-md px-2.5 py-1 text-[12px] font-bold ${settlement === s ? "bg-brand-600 text-white" : "text-ink-mute ring-1 ring-black/10"}`}>{s}</button>
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
          className="w-full resize-none rounded-lg border border-black/10 bg-white px-3 py-2 text-[13px] outline-none placeholder:text-ink-faint focus:border-brand-500"
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

function Stepper({ value, max, onChange }: { value: number; max?: number; onChange: (v: number) => void }) {
  return (
    <div className="inline-flex items-center overflow-hidden rounded-lg ring-1 ring-black/15">
      <button onClick={() => onChange(Math.max(0, value - 1))} className="tap h-7 w-7 bg-white text-[15px] font-bold text-ink-soft">−</button>
      <span className="w-7 text-center text-[13px] font-bold tabular-nums">{value}</span>
      <button onClick={() => onChange(max != null ? Math.min(max, value + 1) : value + 1)} className="tap h-7 w-7 bg-white text-[15px] font-bold text-ink-soft">+</button>
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
      className="w-full rounded-lg border border-black/10 bg-white px-2.5 py-1.5 text-[12.5px] outline-none placeholder:text-ink-faint focus:border-brand-500"
    />
  );
}
