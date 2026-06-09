"use client";

import Link from "next/link";
import { isSupabase } from "@/lib/supabase/client";
import { signOut } from "@/components/AuthGate";
import { VillageLogo } from "@/components/VillageLogo";

export type NavKey = "today" | "schedule" | "follow" | "operations" | "confirm";

// 다 동등한 5개 뷰 — 하나의 통합앱. 모바일은 5탭(라우트 이동), PC는 좌측 오늘일정 고정 + 우측 토글이라 탭 숨김.
const NAV: { key: NavKey; href: string; label: string }[] = [
  { key: "today", href: "/", label: "오늘 일정" },
  { key: "schedule", href: "/schedule", label: "스케줄" },
  { key: "follow", href: "/follow-ups", label: "후속조치" },
  { key: "operations", href: "/operations", label: "운영판" },
  { key: "confirm", href: "/confirm", label: "확인요청" },
];

export function AppSwitcher({ active }: { active: NavKey }) {
  const on = "rounded-full bg-white px-3 py-1 text-accent-700 shadow-sm";
  const off = "px-3 py-1 text-ink-faint";
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2.5">
      <VillageLogo size="sm" />
      <nav className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto rounded-full bg-black/[0.05] p-0.5 text-[12.5px] font-bold lg:hidden [&::-webkit-scrollbar]:hidden">
        {NAV.map((n) => (
          <Link key={n.key} href={n.href} className={`shrink-0 whitespace-nowrap ${active === n.key ? on : off}`}>
            {n.label}
          </Link>
        ))}
      </nav>
      {isSupabase && (
        <button
          onClick={() => signOut()}
          className="shrink-0 rounded-full px-2 py-1 text-[12px] font-semibold text-ink-faint active:scale-95"
          title="로그아웃"
        >
          로그아웃
        </button>
      )}
    </div>
  );
}
