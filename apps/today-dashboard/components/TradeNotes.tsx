"use client";

import { useId, useState } from "react";
import type { Phase, Trade } from "@/lib/domain/types";
import { setPhaseNote } from "@/lib/data/store";

const NOTE_LABEL: Record<Phase, string> = {
  checkout: "반출 메모",
  checkin: "반납 메모",
};

// 이전 인계 메모도 같은 카드에서 읽는다. 기존 기록은 덮어쓰거나 삭제하지 않는다.
export function legacyHandoverNote(trade: Trade): string {
  const legacy = String(trade.packing?.note ?? "").trim();
  return legacy && legacy !== String(trade.noteCheckout ?? "").trim() ? legacy : "";
}

// 추가 반출 내역은 반납 때도 필요하다. 카드 접힘과 관계없이 전문을 표시한다.
export function TradeNotes({ trade, phase, showAdd, onEditingChange }: {
  trade: Trade; phase: Phase; showAdd: boolean; onEditingChange?: (editing: boolean) => void;
}) {
  const [editing, setEditing] = useState<Phase | null>(null);
  function changeEditing(next: Phase | null) {
    setEditing(next);
    onEditingChange?.(next !== null);
  }
  const legacy = legacyHandoverNote(trade);
  const notes: { phase: Phase; text: string; legacy?: string }[] = [
    { phase: "checkout", text: String(trade.noteCheckout ?? "").trim(), legacy },
    { phase: "checkin", text: String(trade.noteCheckin ?? "").trim() },
  ];
  const current = notes.find((note) => note.phase === phase);
  if (!editing && !showAdd && !notes.some((note) => note.text || note.legacy)) return null;

  return (
    <div className="space-y-2 px-4 pl-5 pt-3">
      {notes.map((note) => {
        if (editing === note.phase) {
          return <TradeNoteEditor key={note.phase} trade={trade} phase={note.phase} onClose={() => changeEditing(null)} />;
        }
        if (!note.text && !note.legacy) return null;
        const checkout = note.phase === "checkout";
        return (
          <section
            key={note.phase}
            aria-label={NOTE_LABEL[note.phase]}
            className={`rounded-xl border p-3 sm:p-4 ${checkout ? "border-warn-ring bg-warn-bg" : "border-checkin-ring bg-checkin-bg"}`}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                {checkout && <span className="mb-1 inline-block rounded bg-ink px-2 py-1 text-[12px] font-bold text-white">반출·반납 전 확인</span>}
                <h3 className="text-[15px] font-extrabold text-ink">{NOTE_LABEL[note.phase]}</h3>
              </div>
              <button
                type="button"
                onClick={() => changeEditing(note.phase)}
                aria-label={`${NOTE_LABEL[note.phase]} 수정`}
                className="tap min-h-11 shrink-0 rounded-lg border border-ink/20 bg-white px-3 text-[13px] font-bold text-ink-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-600"
              >{note.text ? "수정" : "메모 추가"}</button>
            </div>
            {note.text && <p className="mt-2 whitespace-pre-wrap break-words text-[16px] font-bold leading-relaxed text-ink [overflow-wrap:anywhere]">{note.text}</p>}
            {note.legacy && <p className="mt-2 whitespace-pre-wrap break-words text-[16px] leading-relaxed text-ink"><span className="block text-xs text-ink-mute">이전 인계 기록</span>{note.legacy}</p>}
          </section>
        );
      })}
      {!editing && showAdd && !current?.text && !current?.legacy && (
        <button
          type="button"
          onClick={() => changeEditing(phase)}
          className="tap min-h-11 w-full rounded-xl border border-dashed border-line bg-paper px-3 py-2 text-left text-[14px] font-semibold text-ink-soft"
        >+ {NOTE_LABEL[phase]}</button>
      )}
    </div>
  );
}

function TradeNoteEditor({ trade, phase, onClose }: { trade: Trade; phase: Phase; onClose: () => void }) {
  const [value, setValue] = useState((phase === "checkout" ? trade.noteCheckout : trade.noteCheckin) ?? "");
  const inputId = useId();
  return (
    <div className="rounded-xl border border-warn-ring bg-warn-bg p-3">
      <label htmlFor={inputId} className="mb-2 block text-[15px] font-extrabold text-ink">{NOTE_LABEL[phase]}</label>
      <textarea
        id={inputId}
        autoFocus
        value={value}
        onChange={(event) => setValue(event.target.value)}
        rows={4}
        placeholder={phase === "checkout" ? "반출 시 전달사항을 적어주세요. 장비·수량은 준비 목록에서 변경합니다" : "반납 확인 내역·전달사항을 적어주세요"}
        className="w-full resize-y rounded-lg border border-line bg-white px-3 py-2 text-[16px] leading-relaxed text-ink outline-none placeholder:text-ink-mute focus:border-brand-500"
      />
      {phase === "checkout" && legacyHandoverNote(trade) && <p className="mt-2 whitespace-pre-wrap text-sm text-ink-soft"><span className="block text-xs">이전 인계 기록</span>{legacyHandoverNote(trade)}</p>}
      <div className="mt-2 flex justify-end gap-2">
        <button type="button" onClick={onClose} className="tap min-h-11 rounded-lg px-3 text-[14px] font-semibold text-ink-soft">취소</button>
        <button
          type="button"
          onClick={() => { setPhaseNote(trade.tradeId, phase, value); onClose(); }}
          className="tap min-h-11 rounded-lg bg-brand-600 px-4 text-[14px] font-bold text-white"
        >저장</button>
      </div>
    </div>
  );
}
