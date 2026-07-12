import { getCachedAccessToken, supabase } from "@/lib/supabase/client";

// 로그인 토큰(Supabase 세션)을 자동 첨부해 /api/* 호출 — 서버 라우트의 인증 게이트 통과용.
// 토큰은 모듈 캐시(getCachedAccessToken)에서 동기적으로 읽어 매 호출 getSession() await를 없앤다.
// 캐시가 아직 비어 있는 초기화 직후에만 1회 getSession()으로 폴백한다.
export async function authFetch(input: string, init: RequestInit = {}): Promise<Response> {
  let token = getCachedAccessToken() ?? "";
  if (!token && supabase) {
    const { data } = await supabase.auth.getSession();
    token = data.session?.access_token ?? "";
  }
  const headers = new Headers(init.headers || {});
  if (token) headers.set("authorization", `Bearer ${token}`);
  return fetch(input, { ...init, headers });
}
