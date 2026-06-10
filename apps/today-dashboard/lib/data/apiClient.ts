"use client";

// /api/gas 프록시 호출 시 로그인 세션 토큰을 붙인다(서버가 검증).
import { supabase } from "../supabase/client";

/** query = '?' 뒤 문자열 (예: "action=dashboard&date=2026-06-09") */
export async function gasFetch(query: string): Promise<Response> {
  let token = "";
  if (supabase) {
    const { data } = await supabase.auth.getSession();
    token = data.session?.access_token ?? "";
  }
  return fetch(`/api/gas?${query}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

export async function gasPost(payload: Record<string, unknown>): Promise<Response> {
  let token = "";
  if (supabase) {
    const { data } = await supabase.auth.getSession();
    token = data.session?.access_token ?? "";
  }
  return fetch("/api/gas", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(payload),
  });
}
