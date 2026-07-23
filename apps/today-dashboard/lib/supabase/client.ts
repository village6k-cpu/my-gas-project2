import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

/** 환경변수가 있으면 Supabase(실데이터) 모드, 없으면 시드 모드 */
export const isSupabase = !!(url && anon);

// Supabase REST 호출(저장/조회)이 응답 없이 매달리면 pendingPersist 게이트가 영구히 잠겨
// 앱 동기화 전체가 멈춘다 — 모든 호출에 상한 타임아웃을 건다(realtime 웹소켓은 영향 없음).
const SUPABASE_FETCH_TIMEOUT_MS = 20_000;
function fetchWithTimeout(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const timeout = AbortSignal.timeout(SUPABASE_FETCH_TIMEOUT_MS);
  const signal = init?.signal
    ? typeof AbortSignal.any === "function"
      ? AbortSignal.any([init.signal, timeout])
      : init.signal
    : timeout;
  return fetch(input, { ...init, signal });
}

export const supabase =
  url && anon
    ? createClient(url, anon, {
        db: { schema: "village" },
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
        realtime: { params: { eventsPerSecond: 8 } },
        global: { fetch: fetchWithTimeout },
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
