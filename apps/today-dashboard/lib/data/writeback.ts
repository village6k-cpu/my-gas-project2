"use client";

// 쓰기 백: 앱 변경 → 기존 GAS 변이 함수(시트/상태) 호출.
// NEXT_PUBLIC_WRITE_BACK=1 일 때만 동작(안전 게이트). 꺼져 있으면 Supabase에만 반영.
import { isSupabase } from "../supabase/client";
import { gasFetch, gasPost } from "./apiClient";

const WRITE_BACK_FLAG = process.env.NEXT_PUBLIC_WRITE_BACK;
export const writeBackEnabled = isSupabase && WRITE_BACK_FLAG === "1";
export const writeBackDisabledReason = !isSupabase
  ? "실데이터 모드가 아니라 원장 쓰기가 비활성화되어 있습니다"
  : "원장 쓰기 환경변수(NEXT_PUBLIC_WRITE_BACK)가 1이 아닙니다";

type GasParam = string | number | boolean;

/** GAS 쓰기 액션 호출 후 응답을 반환해야 하는 변이에 사용 */
export async function gasMutation(action: string, params: Record<string, GasParam>): Promise<any> {
  if (!writeBackEnabled) return { skipped: true };
  const mustPost = action === "uploadDashboardPhoto" || String(params.data ?? "").length > 8_000;
  const r = mustPost
    ? await gasPost({ action, ...params })
    : await (async () => {
        const qs = new URLSearchParams({ action });
        for (const [k, v] of Object.entries(params)) qs.set(k, String(v));
        return gasFetch(qs.toString());
      })();
  const res = await r.json().catch(() => null);
  if (!r.ok || (res && res.error)) {
    throw new Error((res && res.error) || `GAS 호출 실패 (${r.status})`);
  }
  return res;
}

export async function gasRead(action: string, params: Record<string, GasParam> = {}): Promise<any> {
  const qs = new URLSearchParams({ action });
  for (const [k, v] of Object.entries(params)) qs.set(k, String(v));
  const r = await gasFetch(qs.toString());
  const res = await r.json().catch(() => null);
  if (!r.ok || (res && res.error)) {
    throw new Error((res && res.error) || `GAS 호출 실패 (${r.status})`);
  }
  return res;
}

/** GAS 쓰기 액션 호출 (실패해도 앱은 옵티미스틱 유지, 로그만) */
export function gasWrite(action: string, params: Record<string, GasParam>): void {
  if (!writeBackEnabled) return;
  gasMutation(action, params)
    .then((res) => {
      if (res && res.error) console.error("[write-back] GAS 오류:", action, res.error);
    })
    .catch((e) => console.error("[write-back] 호출 실패:", action, e));
}
