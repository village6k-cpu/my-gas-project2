import { unstable_cache } from "next/cache";
import { gasGet } from "@/lib/server/gasPublic";

export const MY_PAGE_TOKEN_RE = /^[A-Za-z0-9가-힣_-]{3,40}\.[a-f0-9]{20}$/;
export const MY_PAGE_NO_STORE_HEADERS = {
  "Cache-Control": "no-store, no-cache, max-age=0, must-revalidate",
};

const MY_PAGE_RESPONSE_CACHE_SECONDS = 90;
const MY_PAGE_RESPONSE_CACHE_MS = MY_PAGE_RESPONSE_CACHE_SECONDS * 1000;
const myPageResponseCache = new Map<string, { at: number; body: unknown }>();

function getMemoryCachedMyPageResponse(token: string) {
  const cached = myPageResponseCache.get(token);
  if (!cached) return null;
  if (Date.now() - cached.at > MY_PAGE_RESPONSE_CACHE_MS) {
    myPageResponseCache.delete(token);
    return null;
  }
  return cached.body;
}

function setMemoryCachedMyPageResponse(token: string, body: unknown) {
  if (myPageResponseCache.size > 1000) myPageResponseCache.clear();
  myPageResponseCache.set(token, { at: Date.now(), body });
}

const getServerCachedMyPageResponse = unstable_cache(
  async (token: string) => {
    const body = await gasGet({ action: "myPage", token });
    // GAS 최상위 catch 형태({error, stack})나 형식이 깨진 응답은 일시 오류 —
    // throw로 unstable_cache 저장을 막아 실패가 90초간 고객에게 고정되지 않게 한다.
    // 정상 형식의 {success:false}(토큰 무효·미존재 등 확정 실패)는 그대로 캐시해
    // 잘못된 토큰 연타로부터 GAS를 보호한다.
    if (!body || typeof body !== "object" || !("success" in body)) {
      throw new Error("GAS myPage 응답 형식 오류 — 잠시 후 다시 시도해주세요");
    }
    return body;
  },
  ["village-my-page-response-v1"],
  { revalidate: MY_PAGE_RESPONSE_CACHE_SECONDS },
);

export function isValidMyPageToken(token: string) {
  return MY_PAGE_TOKEN_RE.test(token);
}

export async function getMyPageResponse(token: string) {
  const memoryCached = getMemoryCachedMyPageResponse(token);
  if (memoryCached) return { body: memoryCached, cache: "HIT" as const };

  const body = await getServerCachedMyPageResponse(token);
  // 인메모리 캐시는 검증 성공 응답만 — "success" in body는 키 존재 검사라
  // {success:false} 실패 본문까지 90초 고정시켰다(일시 오류가 고객에게 반복 노출).
  if (body && typeof body === "object" && (body as { success?: unknown }).success === true) {
    setMemoryCachedMyPageResponse(token, body);
  }
  return { body, cache: "SERVER" as const };
}
