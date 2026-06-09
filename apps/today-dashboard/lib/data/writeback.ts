"use client";

// 쓰기 백: 앱 변경 → 기존 GAS 변이 함수(시트/상태) 호출.
// NEXT_PUBLIC_WRITE_BACK=1 일 때만 동작(안전 게이트). 꺼져 있으면 Supabase에만 반영.
import { isSupabase } from "../supabase/client";
import { gasFetch } from "./apiClient";

export const writeBackEnabled = isSupabase && process.env.NEXT_PUBLIC_WRITE_BACK === "1";

/** GAS 쓰기 액션 호출 (실패해도 앱은 옵티미스틱 유지, 로그만) */
export function gasWrite(action: string, params: Record<string, string | number | boolean>): void {
  if (!writeBackEnabled) return;
  const qs = new URLSearchParams({ action });
  for (const [k, v] of Object.entries(params)) qs.set(k, String(v));
  gasFetch(qs.toString())
    .then((r) => r.json())
    .then((res) => {
      if (res && res.error) console.error("[write-back] GAS 오류:", action, res.error);
    })
    .catch((e) => console.error("[write-back] 호출 실패:", action, e));
}
