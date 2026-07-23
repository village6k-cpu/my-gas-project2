"use client";

// /api/gas 프록시 호출 시 로그인 세션 토큰을 붙인다(서버가 검증).
// 토큰은 모듈 캐시에서 동기 조회 — 매 호출 getSession() await 제거. 캐시 미스 시에만 1회 폴백.
import { getCachedAccessToken, supabase } from "../supabase/client";

async function accessToken(): Promise<string> {
  const cached = getCachedAccessToken();
  if (cached) return cached;
  if (supabase) {
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token ?? "";
  }
  return "";
}

// 프록시 서버측 타임아웃(GET 40s/POST 60s)보다 약간 길게 — 소켓이 조용히 매달린 요청 1개가
// hasPendingPersist 게이트를 영구히 쥐고 앱 전체 동기화를 멈추는 사고를 막는다.
const GAS_GET_TIMEOUT_MS = 45_000;
const GAS_POST_TIMEOUT_MS = 90_000; // 사진 업로드 전송 시간 포함

/** query = '?' 뒤 문자열 (예: "action=dashboard&date=2026-06-09") */
export async function gasFetch(query: string): Promise<Response> {
  const token = await accessToken();
  return fetch(`/api/gas?${query}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(GAS_GET_TIMEOUT_MS),
  });
}

export async function gasPost(payload: Record<string, unknown>): Promise<Response> {
  const token = await accessToken();
  return fetch("/api/gas", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(GAS_POST_TIMEOUT_MS),
  });
}
