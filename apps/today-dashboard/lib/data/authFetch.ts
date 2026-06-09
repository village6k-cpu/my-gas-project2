import { supabase } from "@/lib/supabase/client";

// 로그인 토큰(Supabase 세션)을 자동 첨부해 /api/* 호출 — 서버 라우트의 인증 게이트 통과용.
export async function authFetch(input: string, init: RequestInit = {}): Promise<Response> {
  let token = "";
  if (supabase) {
    const { data } = await supabase.auth.getSession();
    token = data.session?.access_token ?? "";
  }
  const headers = new Headers(init.headers || {});
  if (token) headers.set("authorization", `Bearer ${token}`);
  return fetch(input, { ...init, headers });
}
