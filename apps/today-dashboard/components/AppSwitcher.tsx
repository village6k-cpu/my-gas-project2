"use client";

import Link from "next/link";
import { isSupabase } from "@/lib/supabase/client";
import { signOut } from "@/components/AuthGate";

// 모바일: 오늘일정 · 빌리지스케줄 · 후속조치 3탭(라우트 이동).
// PC(lg): 좌측 오늘일정 고정 + 우측 토글이라 이 탭바는 숨김. 로그아웃만 노출.
export function AppSwitcher({ active }: { active: "today" | "schedule" | "follow" }) {
  const on = "rounded-full bg-white px-3 py-1 text-brand-700 shadow-sm";
  const off = "px-3 py-1 text-ink-faint";
  return (
    <div className="flex items-center gap-2">
      <div className="flex items-center gap-1 rounded-full bg-black/[0.05] p-0.5 text-[13px] font-bold lg:hidden">
        <Link href="/" className={active === "today" ? on : off}>
          오늘 일정
        </Link>
        <Link href="/schedule" className={active === "schedule" ? on : off}>
          스케줄
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
