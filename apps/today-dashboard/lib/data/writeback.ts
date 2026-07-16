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

export class GasMutationError extends Error {
  readonly outcomeUnknown: boolean;

  constructor(message: string, outcomeUnknown = false) {
    super(message);
    this.name = "GasMutationError";
    this.outcomeUnknown = outcomeUnknown;
  }
}

export function isGasOutcomeUnknownError(error: unknown): boolean {
  return error instanceof GasMutationError && error.outcomeUnknown;
}

/** GAS 쓰기 액션 호출 후 응답을 반환해야 하는 변이에 사용 */
export async function gasMutation(action: string, params: Record<string, GasParam>): Promise<any> {
  if (!writeBackEnabled) return { skipped: true };
  const mustPost = action === "uploadDashboardPhoto" || String(params.data ?? "").length > 8_000;
  let r: Response;
  try {
    r = mustPost
      ? await gasPost({ action, ...params })
      : await (async () => {
          const qs = new URLSearchParams({ action });
          for (const [k, v] of Object.entries(params)) qs.set(k, String(v));
          return gasFetch(qs.toString());
        })();
  } catch (error) {
    // 요청이 서버에 도달한 뒤 응답만 끊긴 경우와 전송 전 실패를 브라우저는 구분할 수 없다.
    const detail = error instanceof Error ? error.message : String(error);
    throw new GasMutationError(`GAS 호출 실패: ${detail}`, true);
  }
  const res = await r.json().catch(() => null);
  if (!r.ok) {
    throw new GasMutationError((res && res.error) || `GAS 호출 실패 (${r.status})`, r.status >= 500);
  }
  if (res && res.error) throw new GasMutationError(res.error, false);
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

export type GasWriteContext = { tradeId?: string; label?: string };

// 파이어-앤-포겟 쓰기의 실패를 화면에 알릴 훅 — store가 등록한다(순환 import 회피).
// 예전엔 콘솔에만 남아 '저장됨' 표시와 실제 원장이 조용히 어긋났다.
let gasWriteFailureHandler: ((action: string, error: unknown, context?: GasWriteContext) => void) | null = null;
export function setGasWriteFailureHandler(
  handler: (action: string, error: unknown, context?: GasWriteContext) => void,
): void {
  gasWriteFailureHandler = handler;
}

/** GAS 쓰기 액션 호출 (옵티미스틱 유지, 실패 시 등록된 핸들러로 사용자에게 알림) */
export function gasWrite(action: string, params: Record<string, GasParam>, context?: GasWriteContext): void {
  if (!writeBackEnabled) return;
  gasMutation(action, params)
    .then((res) => {
      if (res && res.error) {
        console.error("[write-back] GAS 오류:", action, res.error);
        gasWriteFailureHandler?.(action, new Error(String(res.error)), context);
      }
    })
    .catch((e) => {
      console.error("[write-back] 호출 실패:", action, e);
      gasWriteFailureHandler?.(action, e, context);
    });
}
