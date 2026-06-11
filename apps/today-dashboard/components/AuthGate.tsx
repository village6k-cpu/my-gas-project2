"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import type { Session } from "@supabase/supabase-js";
import { isSupabase, supabase } from "@/lib/supabase/client";
import { VillageLogo } from "@/components/VillageLogo";

// 고객용 공개 경로 — 직원 로그인 없이 접근 (개인정보 없는 화면만 등록할 것)
const PUBLIC_PATHS = ["/availability"];

// 로그인 게이트: 세션 없으면 로그인 폼, 있으면 앱. (시드 모드면 통과)
export function AuthGate({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    if (!isSupabase || !supabase) {
      setLoading(false);
      return;
    }
    const sb = supabase;
    sb.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });
    const { data: sub } = sb.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  if (pathname && PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/"))) {
    return <>{children}</>; // 공개 경로 = 게이트 통과
  }
  if (!isSupabase) return <>{children}</>; // 시드 모드 = 인증 없음
  if (loading) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-paper text-ink-faint">
        <div className="flex flex-col items-center gap-5">
          <VillageLogo size="lg" />
          <div className="animate-pulse text-[13px] font-semibold">불러오는 중...</div>
        </div>
      </div>
    );
  }
  if (session) return <>{children}</>;

  async function login(e: React.FormEvent) {
    e.preventDefault();
    if (!supabase) return;
    setBusy(true);
    setErr("");
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password: pw });
    if (error) setErr("로그인 실패 — 이메일·비밀번호를 확인하세요.");
    setBusy(false);
  }

  return (
    <div className="flex min-h-dvh items-center justify-center bg-paper px-5 py-10 text-ink">
      <form onSubmit={login} className="w-full max-w-[340px] sm:max-w-[420px]">
        <div className="mb-9 flex flex-col items-center text-center">
          <VillageLogo size="lg" />
          <div className="mt-5 inline-flex rounded-full border border-line bg-white/55 px-3 py-1 text-[12px] font-bold text-ink-mute">
            운영 대시보드
          </div>
          <h1 className="mt-4 text-[24px] font-black leading-tight tracking-normal text-ink">직원 로그인</h1>
          <p className="mt-2 text-[13px] font-medium leading-relaxed text-ink-faint">
            운영 계정으로 계속하세요.
          </p>
        </div>

        <div className="space-y-3 rounded-[8px] border border-line/80 bg-white/80 p-4 shadow-[0_1px_2px_rgba(16,18,29,0.04)] backdrop-blur">
          <label className="block">
            <span className="mb-1.5 block text-[12px] font-bold text-ink-mute">이메일</span>
            <input
              type="email"
              inputMode="email"
              autoComplete="username"
              placeholder="name@village6k.co.kr"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-[8px] border border-line bg-white px-4 py-3.5 text-[15px] font-semibold text-ink outline-none transition placeholder:text-ink-faint/70 focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
              required
            />
          </label>

          <label className="block">
            <span className="mb-1.5 block text-[12px] font-bold text-ink-mute">비밀번호</span>
            <input
              type="password"
              autoComplete="current-password"
              placeholder="비밀번호"
              value={pw}
              onChange={(e) => setPw(e.target.value)}
              className="w-full rounded-[8px] border border-line bg-white px-4 py-3.5 text-[15px] font-semibold text-ink outline-none transition placeholder:text-ink-faint/70 focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
              required
            />
          </label>

          {err && (
            <div aria-live="polite" className="rounded-[8px] border border-attention-ring bg-attention-bg px-3 py-2.5 text-[13px] font-bold text-attention-fg">
              {err}
            </div>
          )}

          <button
            type="submit"
            disabled={busy}
            className="tap w-full rounded-[8px] bg-brand-600 py-3.5 text-[15px] font-black text-white shadow-sm transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy ? "로그인 중..." : "로그인"}
          </button>
        </div>

        <div className="mt-5 text-center text-[12px] font-medium text-ink-faint">계정은 관리자에게 문의하세요.</div>
      </form>
    </div>
  );
}

/** 로그아웃 (헤더 등에서 사용) */
export async function signOut() {
  if (supabase) await supabase.auth.signOut();
}
