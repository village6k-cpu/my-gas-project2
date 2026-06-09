"use client";

import { NAV_ITEMS, type NavKey } from "@/components/navConfig";

// 모바일(<lg) 하단 고정 탭바 — 5섹션. 상태기반 즉시 전환(라우트 X). PC에선 숨김(좌측 레일 사용).
export function BottomTabBar({ view, onNav }: { view: NavKey; onNav: (k: NavKey) => void }) {
  return (
    <nav className="safe-bottom fixed bottom-0 left-0 right-0 z-40 border-t border-black/5 bg-white/95 backdrop-blur lg:hidden">
      <div className="mx-auto flex max-w-md items-stretch">
        {NAV_ITEMS.map((n) => {
          const active = view === n.key;
          return (
            <button
              key={n.key}
              onClick={() => onNav(n.key)}
              className={`tap flex flex-1 flex-col items-center gap-0.5 py-2 ${active ? "text-accent-700" : "text-ink-faint"}`}
            >
              <n.Icon className="h-[21px] w-[21px]" />
              <span className="text-[10.5px] font-bold">{n.label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
