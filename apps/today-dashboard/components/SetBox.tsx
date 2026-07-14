"use client";

import { Children, type ReactNode } from "react";

// 세트별 구획 박스 — 세트명을 헤더로 명확히 구분, 구성품을 안에 묶음.
// headerRow가 있으면 세트 대표행이 '실제 메인 장비'인 경우로, 제목 대신 그 인터랙티브 행을
// 상단 바로 노출(체크/제외/메모/수정 가능). 없으면 세트명만 라벨로 표시(번들 라벨형).
export function SetBox({ name, onRemove, headerRow, children }: { name: string; onRemove?: () => void; headerRow?: ReactNode; children: ReactNode }) {
  const hasHeaderRow = Children.count(headerRow) > 0;
  return (
    <div className="overflow-hidden rounded-xl bg-white shadow-card ring-1 ring-line">
      {hasHeaderRow ? (
        <ul className="border-b border-line/60 bg-brand-50">{headerRow}</ul>
      ) : (
        <div className="flex items-center gap-2 border-b border-line/60 bg-brand-50 px-3 py-2">
          <span className="inline-flex h-5 items-center rounded-md bg-brand-600 px-1.5 text-[10px] font-bold text-white">세트</span>
          <span className="flex-1 truncate text-[13.5px] font-extrabold text-brand-700">{name}</span>
          {onRemove && (
            <button onClick={onRemove} className="tap px-1 text-ink-faint">
              ✕
            </button>
          )}
        </div>
      )}
      <ul className="divide-y divide-line/60">{children}</ul>
    </div>
  );
}

// 세트 아닌 단품 묶음
export function LooseList({ children }: { children: ReactNode }) {
  return <ul className="divide-y divide-line/60 overflow-hidden rounded-xl bg-white shadow-card ring-1 ring-line">{children}</ul>;
}
