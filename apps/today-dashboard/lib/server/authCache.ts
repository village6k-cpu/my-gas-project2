import { createClient, type User } from "@supabase/supabase-js";
import type { NextRequest } from "next/server";

// 로그인 검증(Bearer JWT)용 공유 헬퍼. 예전엔 /api/operations·/api/confirm·/api/gas가
// 각자 요청마다 supabase.auth.getUser(token) = GoTrue /auth/v1/user 네트워크 왕복(150~400ms)을
// GAS 호출 앞에 직렬로 얹었다. 60초 폴링·연속 액션이 잦은 1인 운영앱에서 이 왕복이 체감 지연의 큰 축.
// → token→검증결과를 60초 인메모리 캐시해 반복 검증을 제거한다.
const TTL = 60_000;
const MAX_CACHE_SIZE = 300;
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

  const { data, error } = await client.auth.getUser(token);
  const user = error ? null : data.user;
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
