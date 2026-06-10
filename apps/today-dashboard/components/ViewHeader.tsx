"use client";

import type { ReactNode } from "react";
import { isSupabase } from "@/lib/supabase/client";
import { signOut } from "@/components/AuthGate";
import { VillageLogo } from "@/components/VillageLogo";

// 모든 뷰 공통 상단 1행 — 좌: (모바일)VILLAGE 로고, 우: 뷰별 컨트롤 + (모바일)로그아웃.
// 섹션 네비는 셸의 하단탭바(모바일)/좌측레일(PC)이 담당 → 헤더엔 네비 없음(여유).
export function ViewHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 px-4 pt-2.5 pb-2.5">
      <div className="flex min-w-0 items-center">
        <span className="lg:hidden">
          <VillageLogo size="sm" />
        </span>
        <span className="sr-only">{title}</span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {children}
        {isSupabase && (
          <button
            onClick={() => signOut()}
            className="rounded-full px-2 py-1 text-[12px] font-semibold text-ink-faint active:scale-95 lg:hidden"
            title="로그아웃"
          >
            로그아웃
          </button>
        )}
      </div>
    </div>
  );
}
