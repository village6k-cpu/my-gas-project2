import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

/** 환경변수가 있으면 Supabase(실데이터) 모드, 없으면 시드 모드 */
export const isSupabase = !!(url && anon);

export const supabase =
  url && anon
    ? createClient(url, anon, {
        db: { schema: "village" },
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
        realtime: { params: { eventsPerSecond: 8 } },
      })
    : null;

// access_token을 모듈 메모리에 캐시 — authFetch/gasFetch가 매 호출마다 getSession()을
// 직렬 await 하던 지연을 없앤다. onAuthStateChange가 로그인/토큰갱신 때 자동 갱신한다.
let cachedAccessToken: string | null = null;
export function getCachedAccessToken(): string | null {
  return cachedAccessToken;
}
if (supabase) {
  supabase.auth.getSession().then(({ data }) => {
    cachedAccessToken = data.session?.access_token ?? null;
  });
  supabase.auth.onAuthStateChange((_event, session) => {
    cachedAccessToken = session?.access_token ?? null;
  });
}
