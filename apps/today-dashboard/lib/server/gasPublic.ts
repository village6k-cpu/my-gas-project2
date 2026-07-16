// 고객용 공개 API의 서버측 GAS 호출 헬퍼.
// API 키는 서버에서만 사용하고, 응답은 각 라우트에서 필요한 필드만 골라 내보낸다.
// (직원용 /api/gas는 Supabase 로그인 필수 — 공개 라우트는 이 헬퍼로 분리)

const GAS_URL =
  process.env.GAS_API_URL ??
  "https://script.google.com/macros/s/AKfycbyRff4-lLXmne-iPIEf87x4-CH_5wb-Uv5dCGymELLrpiKluhg2gDdLdVP4Y0MmxnnT/exec";
const GAS_KEY = process.env.GAS_API_KEY ?? "village2026";

// GAS가 응답을 물고 있을 때(콜드스타트 폭주·쿼터) 공개 라우트가 플랫폼 함수 타임아웃까지
// 매달리지 않도록 상한을 둔다 — 직원용 프록시 app/api/gas/route.ts의 GET 40s/POST 60s와 동일.
const GAS_GET_TIMEOUT_MS = 40_000;
const GAS_POST_TIMEOUT_MS = 60_000;

// 타임아웃(TimeoutError/AbortError)을 각 라우트의 catch가 사용자에게 그대로 전달할 수 있는
// 메시지로 변환. confirm/cancel의 GAS 쓰기는 멱등(입금완료 재설정·환불 재기록 무해)이라
// 동일 요청 재시도가 안전하다.
function toGasCallError(e: unknown): Error {
  if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) {
    return new Error("GAS 응답 지연(시간 초과) — 동일 요청을 다시 시도해도 안전합니다");
  }
  return e instanceof Error ? e : new Error(String(e));
}

export async function gasGet(params: Record<string, string>): Promise<unknown> {
  const qs = new URLSearchParams(params);
  qs.set("key", GAS_KEY);
  let res: Response;
  try {
    res = await fetch(`${GAS_URL}?${qs.toString()}`, {
      redirect: "follow",
      cache: "no-store",
      signal: AbortSignal.timeout(GAS_GET_TIMEOUT_MS),
    });
  } catch (e) {
    throw toGasCallError(e);
  }
  if (!res.ok) throw new Error(`GAS 응답 오류 (${res.status})`);
  return res.json();
}

export async function gasPost(body: Record<string, unknown>): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(GAS_URL, {
      method: "POST",
      redirect: "follow",
      cache: "no-store",
      // GAS doPost는 text/plain으로 보내야 CORS preflight 없이 통과
      headers: { "content-type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ ...body, key: GAS_KEY }),
      signal: AbortSignal.timeout(GAS_POST_TIMEOUT_MS),
    });
  } catch (e) {
    throw toGasCallError(e);
  }
  if (!res.ok) throw new Error(`GAS 응답 오류 (${res.status})`);
  return res.json();
}

// ── 간이 IP 레이트리밋 (서버리스 인스턴스 단위 best-effort) ──
const hits = new Map<string, { count: number; resetAt: number }>();

export function rateLimited(ip: string, limit = 20, windowMs = 60_000): boolean {
  const now = Date.now();
  const cur = hits.get(ip);
  if (!cur || now > cur.resetAt) {
    hits.set(ip, { count: 1, resetAt: now + windowMs });
    return false;
  }
  cur.count += 1;
  if (hits.size > 5000) hits.clear(); // 메모리 보호
  return cur.count > limit;
}

export function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for") ?? "";
  return fwd.split(",")[0].trim() || "unknown";
}
