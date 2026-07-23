import { createClient, isAuthRetryableFetchError, type User } from "@supabase/supabase-js";
import type { NextRequest } from "next/server";

// 로그인 검증(Bearer JWT)용 공유 헬퍼. 예전엔 /api/operations·/api/confirm·/api/gas가
// 각자 요청마다 supabase.auth.getUser(token) = GoTrue /auth/v1/user 네트워크 왕복(150~400ms)을
// GAS 호출 앞에 직렬로 얹었다. 60초 폴링·연속 액션이 잦은 1인 운영앱에서 이 왕복이 체감 지연의 큰 축.
// → token→검증결과를 60초 인메모리 캐시해 반복 검증을 제거한다.
const TTL = 60_000;
const MAX_CACHE_SIZE = 300;
// GoTrue 검증 응답 상한 — 초과는 일시 장애로 취급(캐시하지 않음)
const AUTH_TIMEOUT_MS = 3_000;
// 일시 장애 동안 최근 긍정 캐시를 대신 쓰는 허용 한도(stale-while-error)
const STALE_MAX_MS = 10 * 60_000;
const cache = new Map<string, { user: User | null; at: number }>();
type AuthClient = ReturnType<typeof createClient>;
let authClient: AuthClient | null = null;
let authClientUrl: string | null = null;
let authClientAnon: string | null = null;

function getAuthClient(): AuthClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) return null;

  if (!authClient || url !== authClientUrl || anon !== authClientAnon) {
    authClient = createClient(url, anon);
    authClientUrl = url;
    authClientAnon = anon;
    cache.clear();
  }
  return authClient;
}

function pruneCache(now: number): void {
  for (const [token, entry] of cache) {
    if (now - entry.at > TTL) cache.delete(token);
  }

  while (cache.size > MAX_CACHE_SIZE) {
    let oldestToken: string | null = null;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [token, entry] of cache) {
      if (entry.at < oldestAt) {
        oldestToken = token;
        oldestAt = entry.at;
      }
    }
    if (!oldestToken) break;
    cache.delete(oldestToken);
  }
}

export async function getAuthedUser(req: NextRequest): Promise<User | null> {
  const client = getAuthClient();
  if (!client) return null;
  const h = req.headers.get("authorization") ?? "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (!token) return null;

  const now = Date.now();
  const hit = cache.get(token);
  if (hit && now - hit.at < TTL) return hit.user;

  let user: User | null = null;
  let transient = false; // 네트워크성 실패(캐시 금지) 여부
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const { data, error } = await Promise.race([
      client.auth.getUser(token),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("GoTrue 검증 시간 초과")), AUTH_TIMEOUT_MS);
      }),
    ]);
    if (error) {
      // supabase-js는 네트워크 실패를 throw하지 않고 AuthRetryableFetchError로 반환한다.
      // 일시 장애(fetch 예외·5xx·상태 미상)를 '토큰 무효'로 60초 캐시하면 앱 전체가 401로 고정되므로
      // 확정 무효 토큰(401류, status 있는 4xx)만 null 캐시 대상으로 남긴다.
      transient = isAuthRetryableFetchError(error) || !error.status || error.status >= 500;
    } else {
      user = data.user;
    }
  } catch {
    transient = true; // 타임아웃·예상 밖 throw도 일시 장애로 취급
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }

  if (transient) {
    // 일시 장애: 결과를 캐시하지 않고, 최근(10분 내) 긍정 캐시가 있으면 그대로 사용해
    // 로그인된 직원이 업스트림 순단 한 번에 401로 튕기지 않게 한다.
    if (hit?.user && now - hit.at < STALE_MAX_MS) return hit.user;
    return null;
  }

  cache.set(token, { user, at: now });

  if (cache.size > MAX_CACHE_SIZE) pruneCache(now);
  return user;
}

export async function isAuthedRequest(req: NextRequest): Promise<boolean> {
  // 기존 라우트의 로컬/시드 모드 계약은 유지한다. 민감한 신규 경로는
  // getAuthedUser를 직접 사용하는 fail-closed 가드를 거쳐야 한다.
  if (!getAuthClient()) return true;
  return !!(await getAuthedUser(req));
}
