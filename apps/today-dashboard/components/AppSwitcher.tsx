"use client";

import Link from "next/link";
import { isSupabase } from "@/lib/supabase/client";
import { signOut } from "@/components/AuthGate";

// 모바일: 오늘일정 · 빌리지스케줄 · 후속조치 (3개)
// 데스크탑(lg): '/'가 오늘+스케줄 합본이라 [대시보드] · [후속조치] 2개
export function AppSwitcher({ active }: { active: "today" | "schedule" | "follow" }) {
  const on = "rounded-full bg-white px-3 py-1 text-brand-700 shadow-sm";
  const off = "px-3 py-1 text-ink-faint";
  const dash = active === "today" || active === "schedule";
  return (
    <div className="flex items-center gap-2">
      <div className="flex items-center gap-1 rounded-full bg-black/[0.05] p-0.5 text-[13px] font-bold">
        <Link href="/" className={`lg:hidden ${active === "today" ? on : off}`}>
          오늘 일정
        </Link>
        <Link href="/schedule" className={`lg:hidden ${active === "schedule" ? on : off}`}>
          빌리지 스케줄
        </Link>
        <Link href="/" className={`hidden lg:block ${dash ? on : off}`}>
          대시보드
        </Link>
        <Link href="/follow-ups" className={active === "follow" ? on : off}>
          후속조치
        </Link>
      </div>
      {isSupabase && (
        <button
          onClick={() => signOut()}
          className="rounded-full px-2 py-1 text-[12px] font-semibold text-ink-faint active:scale-95"
          title="로그아웃"
        >
          로그아웃
        </button>
      )}
    </div>
  );
}
