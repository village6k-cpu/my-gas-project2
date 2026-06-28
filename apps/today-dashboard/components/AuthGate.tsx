"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import type { Session } from "@supabase/supabase-js";
import { isSupabase, supabase } from "@/lib/supabase/client";

// 로그인 워드마크 락업 — 본래 로고 PNG + 에디션(운영 대시보드), finance 로그인과 같은 광학 규칙.
// 보정값은 PNG 픽셀 측정 기반(h-10 = 원본 96px의 40px 스케일):
//  · translate +2.7px = VILLAGE 글자만 정중앙(+6.5) − 점 무게 절반(−3.7)
//  · 에디션 mr 18.8px = 점·우측 여백 20.4px 안쪽(E 오른쪽 끝) − 자간 0.13em 트레일링 보정
function LoginWordmark() {
  return (
    <div className="flex justify-center">
      <div className="translate-x-[2.7px]">
        <img
          src="/village-wordmark.png"
          alt="VILLAGE"
          className="block h-10 w-[195px] select-none"
          draggable={false}
        />
        <span className="mr-[18.8px] mt-1 block text-right text-[12px] font-semibold tracking-[0.13em] text-ink-faint">
          운영 대시보드
        </span>
      </div>
    </div>
  );
}

// 고객용 공개 경로 — 직원 로그인 없이 접근 (토큰으로 본인 예약만 보는 화면)
const PUBLIC_PATHS = ["/my"];
const AUTH_SESSION_TIMEOUT_MS = 3500;
const AUTH_LOGIN_TIMEOUT_MS = 12000;

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
    let cancelled = false;
    const sb = supabase;
    const sessionPromise = sb.auth
      .getSession()
      .then(({ data }) => data.session)
      .catch(() => null);
    Promise.race([
      sessionPromise,
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), AUTH_SESSION_TIMEOUT_MS)),
    ]).then((result) => {
      if (cancelled) return;
      if (result === "timeout") {
        setLoading(false);
        return;
      }
      setSession(result);
      setLoading(false);
    });
    sessionPromise.then((restoredSession) => {
      if (cancelled || !restoredSession) return;
      setSession(restoredSession);
      setLoading(false);
    });
    const { data: sub } = sb.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, []);

  if (pathname && PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/"))) {
    return <>{children}</>; // 공개 경로 = 게이트 통과
  }
  if (!isSupabase) return <>{children}</>; // 시드 모드 = 인증 없음
  if (loading) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-paper">
        <div className="flex flex-col items-center gap-4">
          <LoginWordmark />
          <div className="animate-pulse text-[13px] font-semibold text-ink-faint">불러오는 중...</div>
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
    try {
      const loginResult = await Promise.race([
        supabase.auth.signInWithPassword({ email: email.trim(), password: pw }),
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), AUTH_LOGIN_TIMEOUT_MS)),
      ]);
      if (loginResult === "timeout") {
        setErr("로그인 서버 응답이 지연되고 있습니다. 잠시 후 다시 시도해주세요.");
        return;
      }
      const { data, error } = loginResult;
      if (error) {
        setErr("로그인 실패 — 이메일·비밀번호를 확인하세요.");
        return;
      }
      setSession(data.session);
    } catch {
      setErr("로그인 실패 — 잠시 후 다시 시도해주세요.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-dvh items-center justify-center bg-paper px-5 py-10 text-ink">
      <form onSubmit={login} className="w-full max-w-[340px] sm:max-w-[420px]">
        <div className="mb-8">
          <LoginWordmark />
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
