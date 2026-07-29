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
  readonly retryable: boolean;

  constructor(message: string, outcomeUnknown = false, retryable = false) {
    super(message);
    this.name = "GasMutationError";
    this.outcomeUnknown = outcomeUnknown;
    this.retryable = retryable;
  }
}

export function isGasOutcomeUnknownError(error: unknown): boolean {
  return error instanceof GasMutationError && error.outcomeUnknown;
}

// 같은 거래의 클릭 순서만 거래별 tail로 보존한다. 서로 다른 거래까지 브라우저 전역
// Web Lock으로 묶으면 느린 계약 작업 하나가 모든 카드·탭의 완료/메모를 막는다.
// 서버의 짧은 ScriptLock 경합은 아래 bounded jitter retry가 흡수한다.
const gasMutationTails = new Map<string, Promise<void>>();
const GAS_BUSY_RETRY_DELAYS_MS = [300, 800, 1_600, 3_200];

function jitterRetryDelay(baseMs: number): number {
  // 여러 직원 기기가 같은 BUSY 응답 뒤 같은 시각에 재충돌하는 동기 재시도를 흩뜨린다.
  return Math.max(100, Math.round(baseMs * (0.75 + Math.random() * 0.5)));
}

function mutationTradeKey(action: string, params: Record<string, GasParam>): string | null {
  // 사진 전송은 수십 초 걸릴 수 있고 원장 상태 순서와 무관하다. 사진 lane 때문에 같은 카드의
  // 반출/반납 명령이 줄 서지 않도록 원장 명령열에서 분리한다(사진 큐가 자체 재시도를 담당).
  if (action === "uploadDashboardPhoto" || action === "deleteDashboardPhoto") return null;
  const direct = String(params.tid ?? params.tradeId ?? "").trim();
  if (direct) return direct;
  const scheduleId = String(params.scheduleId ?? "").trim();
  const match = scheduleId.match(/^(\d{6}-\d{3})-/);
  return match ? match[1] : `action:${action}`;
}

function enqueueGasMutation<T>(tradeKey: string | null, task: () => Promise<T>): Promise<T> {
  if (!tradeKey) return task();
  const previous = gasMutationTails.get(tradeKey) ?? Promise.resolve();
  const run = previous.then(task);
  // tail은 항상 resolve시켜 앞 명령 실패가 다음 명령까지 영구 차단하지 않게 한다.
  const tail = run.then(() => undefined, () => undefined);
  gasMutationTails.set(tradeKey, tail);
  void tail.then(() => {
    if (gasMutationTails.get(tradeKey) === tail) gasMutationTails.delete(tradeKey);
  });
  return run;
}

async function executeGasMutation(action: string, params: Record<string, GasParam>): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    const mustPost = action === "uploadDashboardPhoto" || action === "toggleItems" || String(params.data ?? "").length > 8_000;
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

    let text: string;
    try {
      text = await r.text();
    } catch (error) {
      // 응답 본문을 읽다 연결이 끊겨도 서버 실행 여부는 알 수 없다. 명확한 실패로 롤백하지 않는다.
      const detail = error instanceof Error ? error.message : String(error);
      throw new GasMutationError(`GAS 응답 확인 실패: ${detail}`, true);
    }
    let res: any;
    try {
      res = JSON.parse(text);
    } catch {
      // GAS/프록시가 예외 HTML을 HTTP 200으로 돌려주는 경우가 있다. 과거에는 null을 성공으로
      // 취급해 카드만 완료되고 원장은 실패했다. 실행 여부가 불명확하므로 절대 성공 처리하지 않는다.
      throw new GasMutationError(`GAS가 유효한 JSON 응답이 아닙니다 (${r.status})`, true);
    }
    if (!res || typeof res !== "object" || Array.isArray(res)) {
      throw new GasMutationError(`GAS가 유효한 JSON 응답이 아닙니다 (${r.status})`, true);
    }
    if (!r.ok) {
      throw new GasMutationError(res.error || `GAS 호출 실패 (${r.status})`, r.status >= 500, !!res.retryable);
    }
    if (res.error) {
      const retryable = res.retryable === true || res.code === "BUSY";
      const outcomeUnknown = res.outcomeUnknown === true || res.code === "OUTCOME_UNKNOWN";
      if (retryable && attempt < GAS_BUSY_RETRY_DELAYS_MS.length) {
        await new Promise((resolve) => setTimeout(resolve, jitterRetryDelay(GAS_BUSY_RETRY_DELAYS_MS[attempt])));
        continue;
      }
      throw new GasMutationError(String(res.error), outcomeUnknown, retryable);
    }
    return res;
  }
}

/** GAS 쓰기 액션 호출 후 응답을 반환해야 하는 변이에 사용 */
export async function gasMutation(action: string, params: Record<string, GasParam>): Promise<any> {
  if (!writeBackEnabled) return { skipped: true };
  return enqueueGasMutation(mutationTradeKey(action, params), () => executeGasMutation(action, params));
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
