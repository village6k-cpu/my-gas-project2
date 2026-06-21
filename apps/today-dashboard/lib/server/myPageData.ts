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
  async (token: string) => gasGet({ action: "myPage", token }),
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
  if (body && typeof body === "object" && "success" in body) {
    setMemoryCachedMyPageResponse(token, body);
  }
  return { body, cache: "SERVER" as const };
}
