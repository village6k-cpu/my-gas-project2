"use client";

import type { ReactNode } from "react";

// 세트별 구획 박스 — 세트명을 헤더로 명확히 구분, 구성품을 안에 묶음
export function SetBox({ name, onRemove, children }: { name: string; onRemove?: () => void; children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-xl bg-white shadow-card ring-1 ring-black/10">
      <div className="flex items-center gap-2 border-b border-black/5 bg-brand-50 px-3 py-2">
        <span className="inline-flex h-5 items-center rounded-md bg-brand-600 px-1.5 text-[10px] font-bold text-white">세트</span>
        <span className="flex-1 truncate text-[13.5px] font-extrabold text-brand-700">{name}</span>
        {onRemove && (
          <button onClick={onRemove} className="tap px-1 text-ink-faint">
            ✕
          </button>
        )}
      </div>
      <ul className="divide-y divide-black/5">{children}</ul>
    </div>
  );
}

// 세트 아닌 단품 묶음
export function LooseList({ children }: { children: ReactNode }) {
  return <ul className="divide-y divide-black/5 overflow-hidden rounded-xl bg-white shadow-card ring-1 ring-black/10">{children}</ul>;
}
