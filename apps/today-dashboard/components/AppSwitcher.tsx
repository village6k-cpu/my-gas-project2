"use client";

import Link from "next/link";
import { isSupabase } from "@/lib/supabase/client";
import { signOut } from "@/components/AuthGate";

export function AppSwitcher({ active }: { active: "today" | "schedule" }) {
  const on = "rounded-full bg-white px-3 py-1 text-brand-700 shadow-sm";
  const off = "px-3 py-1 text-ink-faint";
  return (
    <div className="flex items-center gap-2">
      <div className="flex items-center gap-1 rounded-full bg-black/[0.05] p-0.5 text-[13px] font-bold lg:hidden">
        <Link href="/" className={active === "today" ? on : off}>
          오늘 일정
        </Link>
        <Link href="/schedule" className={active === "schedule" ? on : off}>
          빌리지 스케줄
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
