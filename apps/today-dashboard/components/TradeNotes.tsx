"use client";

import { useId, useState } from "react";
import type { Phase, Trade } from "@/lib/domain/types";
import { setPhaseNote } from "@/lib/data/store";

const NOTE_LABEL: Record<Phase, string> = {
  checkout: "반출 전체 메모",
  checkin: "반납 전체 메모",
};

// 추가 반출 내역은 반납 때도 필요하다. 카드 접힘과 관계없이 전문을 표시한다.
export function TradeNotes({ trade, phase, showAdd }: { trade: Trade; phase: Phase; showAdd: boolean }) {
  const [editing, setEditing] = useState<Phase | null>(null);
  const notes: { phase: Phase; text: string }[] = [
    { phase: "checkout", text: String(trade.noteCheckout ?? "").trim() },
    { phase: "checkin", text: String(trade.noteCheckin ?? "").trim() },
  ];
  const current = notes.find((note) => note.phase === phase);
  if (!editing && !showAdd && !notes.some((note) => note.text)) return null;

  return (
    <div className="space-y-2 px-4 pl-5 pt-3">
      {notes.map((note) => {
        if (editing === note.phase) {
          return <TradeNoteEditor key={note.phase} trade={trade} phase={note.phase} onClose={() => setEditing(null)} />;
        }
        if (!note.text) return null;
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
                onClick={() => setEditing(note.phase)}
                aria-label={`${NOTE_LABEL[note.phase]} 수정`}
                className="tap min-h-11 shrink-0 rounded-lg border border-ink/20 bg-white px-3 text-[13px] font-bold text-ink-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-600"
              >수정</button>
            </div>
            <p className="mt-2 whitespace-pre-wrap break-words text-[16px] font-bold leading-relaxed text-ink [overflow-wrap:anywhere]">{note.text}</p>
          </section>
        );
      })}
      {!editing && showAdd && !current?.text && (
        <button
          type="button"
          onClick={() => setEditing(phase)}
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
        placeholder={phase === "checkout" ? "추가 반출 장비·수량·전달사항을 적어주세요" : "반납 확인 내역·전달사항을 적어주세요"}
        className="w-full resize-y rounded-lg border border-line bg-white px-3 py-2 text-[16px] leading-relaxed text-ink outline-none placeholder:text-ink-mute focus:border-brand-500"
      />
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
