"use client";

// /api/gas 프록시 호출 시 로그인 세션 토큰을 붙인다(서버가 검증).
import { readPersistedSupabaseSession, supabase } from "../supabase/client";

const GAS_FETCH_SESSION_TIMEOUT_MS = 2500;

async function currentAccessToken(): Promise<string> {
  if (!supabase) return "";
  const result = await Promise.race([
    supabase.auth.getSession().then(({ data }) => data.session).catch(() => null),
    new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), GAS_FETCH_SESSION_TIMEOUT_MS)),
  ]);
  const session = result === "timeout" ? readPersistedSupabaseSession() : result;
  return session?.access_token ?? "";
}

/** query = '?' 뒤 문자열 (예: "action=dashboard&date=2026-06-09") */
export async function gasFetch(query: string): Promise<Response> {
  const token = await currentAccessToken();
  return fetch(`/api/gas?${query}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

export async function gasPost(payload: Record<string, unknown>): Promise<Response> {
  const token = await currentAccessToken();
  return fetch("/api/gas", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(payload),
  });
}
