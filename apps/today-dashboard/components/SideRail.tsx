"use client";

import { isSupabase } from "@/lib/supabase/client";
import { signOut } from "@/components/AuthGate";
import { VillageLogo } from "@/components/VillageLogo";
import { NAV_ITEMS, type NavKey } from "@/components/navConfig";

// PC(lg+) 좌측 세로 레일 — VILLAGE 로고 + 4섹션 네비 + 로그아웃. (오늘일정은 우측 고정이라 제외)
const RAIL_ITEMS = NAV_ITEMS.filter((n) => n.key !== "today");

export function SideRail({ view, onNav }: { view: NavKey; onNav: (k: NavKey) => void }) {
  return (
    <nav className="hidden shrink-0 flex-col border-r border-black/5 bg-white/70 px-3 py-4 lg:flex lg:w-[176px]">
      <div className="px-2 pb-4">
        <VillageLogo size="md" />
      </div>
      <div className="flex flex-1 flex-col gap-1">
        {RAIL_ITEMS.map((n) => {
          const active = view === n.key;
          return (
            <button
              key={n.key}
              onClick={() => onNav(n.key)}
              className={`tap flex items-center gap-2.5 rounded-xl px-3 py-2.5 text-left text-[14px] font-bold transition ${
                active ? "bg-accent-50 text-accent-700 ring-1 ring-accent-100" : "text-ink-mute hover:bg-black/[0.03]"
              }`}
            >
              <n.Icon className="h-[18px] w-[18px] shrink-0" />
              <span className="truncate">{n.label}</span>
            </button>
          );
        })}
      </div>
      {isSupabase && (
        <button onClick={() => signOut()} className="tap mt-2 rounded-xl px-3 py-2 text-left text-[13px] font-semibold text-ink-faint hover:bg-black/[0.03]">
          로그아웃
        </button>
      )}
    </nav>
  );
}
