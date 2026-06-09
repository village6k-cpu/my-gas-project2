"use client";

import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { isSupabase, supabase } from "@/lib/supabase/client";

// 로그인 게이트: 세션 없으면 로그인 폼, 있으면 앱. (시드 모드면 통과)
export function AuthGate({ children }: { children: React.ReactNode }) {
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

  if (!isSupabase) return <>{children}</>; // 시드 모드 = 인증 없음
  if (loading) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-[#f6f5f2] text-ink-faint">
        <div className="animate-pulse text-sm">불러오는 중…</div>
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
    <div className="flex min-h-dvh items-center justify-center bg-[#f6f5f2] px-6">
      <form onSubmit={login} className="w-full max-w-xs space-y-4">
        <div className="text-center">
          <div className="text-2xl font-black tracking-tight text-brand-700">빌리지</div>
          <div className="mt-1 text-[13px] text-ink-faint">운영 대시보드 · 직원 로그인</div>
        </div>
        <div className="space-y-2">
          <input
            type="email"
            inputMode="email"
            autoComplete="username"
            placeholder="이메일"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded-xl border border-black/10 bg-white px-4 py-3 text-[15px] outline-none focus:border-brand-500"
            required
          />
          <input
            type="password"
            autoComplete="current-password"
            placeholder="비밀번호"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            className="w-full rounded-xl border border-black/10 bg-white px-4 py-3 text-[15px] outline-none focus:border-brand-500"
            required
          />
        </div>
        {err && <div className="text-center text-[13px] font-semibold text-rose-600">{err}</div>}
        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-xl bg-brand-600 py-3 text-[15px] font-bold text-white shadow-sm active:scale-[0.99] disabled:opacity-60"
        >
          {busy ? "로그인 중…" : "로그인"}
        </button>
        <div className="text-center text-[11px] text-ink-faint">계정은 관리자에게 문의하세요.</div>
      </form>
    </div>
  );
}

/** 로그아웃 (헤더 등에서 사용) */
export async function signOut() {
  if (supabase) await supabase.auth.signOut();
}
