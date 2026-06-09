"use client";

import { useEffect, useRef, useState } from "react";
import type { HandoverNote } from "@/lib/domain/types";
import { addNote, deleteNote, updateNote } from "@/lib/data/store";
import { Plus } from "./icons";

const SIZES = ["text-[12px]", "text-[13.5px]", "text-[15px]"];

export function HandoverBoard({ notes }: { notes: HandoverNote[] }) {
  const [open, setOpen] = useState(true);
  const [size, setSize] = useState(1);

  return (
    <section className="rounded-xl2 bg-[#fffdf3] p-3 shadow-card ring-1 ring-amber-200/70">
      <div className="flex items-center justify-between">
        <button onClick={() => setOpen((v) => !v)} className="flex items-center gap-1.5 text-[13px] font-bold text-amber-900">
          📌 인수인계 메모
          <span className="rounded-full bg-amber-200/70 px-1.5 text-[11px] font-semibold text-amber-800">{notes.length}</span>
        </button>
        <div className="flex items-center gap-1">
          {["A-", "A", "A+"].map((l, i) => (
            <button
              key={l}
              onClick={() => setSize(i)}
              className={`tap h-6 rounded-md px-1.5 text-[11px] font-bold ${size === i ? "bg-amber-200 text-amber-900" : "text-amber-700/60"}`}
            >
              {l}
            </button>
          ))}
        </div>
      </div>

      {open && (
        <div className="mt-2 space-y-1.5">
          {notes.map((n) => (
            <div key={n.id} className="group flex items-start gap-2 rounded-lg bg-amber-100/50 px-2.5 py-1.5">
              <NoteArea body={n.body} sizeCls={SIZES[size]} size={size} onSave={(v) => updateNote(n.id, v)} />
              <button onClick={() => deleteNote(n.id)} className="tap mt-0.5 shrink-0 text-amber-700/40 hover:text-attention-fg">
                ✕
              </button>
            </div>
          ))}
          <button
            onClick={addNote}
            className="tap flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-amber-300 py-1.5 text-[12.5px] font-semibold text-amber-700"
          >
            <Plus className="h-3.5 w-3.5" /> 메모 추가
          </button>
        </div>
      )}
    </section>
  );
}

/** 내용에 맞춰 높이 자동 확장 — 길어도 잘리지 않고 한눈에 */
function NoteArea({ body, sizeCls, size, onSave }: { body: string; sizeCls: string; size: number; onSave: (v: string) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const grow = () => {
    const el = ref.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight}px`;
    }
  };
  // 마운트 시 + 글자크기 바뀔 때 높이 재계산
  useEffect(grow, [size, body]);
  return (
    <textarea
      ref={ref}
      defaultValue={body}
      onInput={grow}
      onBlur={(e) => onSave(e.target.value)}
      rows={1}
      className={`flex-1 resize-none overflow-hidden bg-transparent leading-snug text-amber-950 outline-none placeholder:text-amber-700/40 ${sizeCls}`}
      placeholder="메모 입력…"
    />
  );
}
