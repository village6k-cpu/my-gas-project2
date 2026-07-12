import { createClient } from "@supabase/supabase-js";
import type { NextRequest } from "next/server";

// 로그인 검증(Bearer JWT)용 공유 헬퍼. 예전엔 /api/operations·/api/confirm·/api/gas가
// 각자 요청마다 supabase.auth.getUser(token) = GoTrue /auth/v1/user 네트워크 왕복(150~400ms)을
// GAS 호출 앞에 직렬로 얹었다. 60초 폴링·연속 액션이 잦은 1인 운영앱에서 이 왕복이 체감 지연의 큰 축.
// → token→검증결과를 60초 인메모리 캐시해 반복 검증을 제거한다.
const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const authClient = SUPA_URL && ANON ? createClient(SUPA_URL, ANON) : null;

const TTL = 60_000;
const cache = new Map<string, { valid: boolean; at: number }>();

export async function isAuthedRequest(req: NextRequest): Promise<boolean> {
  if (!authClient) return true; // Supabase 미설정(로컬/시드) → 통과
  const h = req.headers.get("authorization") ?? "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (!token) return false;

  const now = Date.now();
  const hit = cache.get(token);
  if (hit && now - hit.at < TTL) return hit.valid;

  const { data, error } = await authClient.auth.getUser(token);
  const valid = !error && !!data.user;
  cache.set(token, { valid, at: now });

  if (cache.size > 300) {
    for (const [k, v] of cache) if (now - v.at > TTL) cache.delete(k);
  }
  return valid;
}
