"use client";

import { useEffect, useState, type ReactNode } from "react";
import { supabase } from "@/lib/supabase/client";
import { AppSwitcher } from "@/components/AppSwitcher";

// 후속조치 = 실제 follow-up-dashboard(index.html/operations.html)를 그대로 iframe.
// 같은 출처라 로그인 토큰(localStorage)을 공유 → 주입된 fetch 오버라이드가 /api 호출에 Bearer 첨부.
export function FollowUpView({ embedded, headerLeft }: { embedded?: boolean; headerLeft?: ReactNode } = {}) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!supabase) {
      setReady(true);
      return;
    }
    // 세션이 localStorage에 확실히 저장된 뒤 iframe 로드(내부 인증용)
    supabase.auth.getSession().then(() => setReady(true));
  }, []);

  return (
    <div className="flex h-screen flex-col bg-[#f1f4f9]">
      <header className="safe-top z-30 flex shrink-0 items-center justify-between bg-[#f1f4f9] px-4 py-2 ring-1 ring-[#e2e8f0]">
        {headerLeft ?? <AppSwitcher active="follow" />}
      </header>
      {ready ? (
        <iframe src="/followup/index.html" title="후속조치 · 운영판" className="w-full flex-1 border-0" />
      ) : (
        <div className="flex flex-1 items-center justify-center text-[14px] text-[#64748b]">불러오는 중…</div>
      )}
    </div>
  );
}
