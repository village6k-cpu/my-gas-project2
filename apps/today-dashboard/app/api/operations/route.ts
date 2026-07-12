import { NextRequest, NextResponse } from "next/server";
import { isAuthedRequest } from "@/lib/server/authCache";

// 운영판 API — GAS action=operations 프록시 (로그인 게이트).
const GAS_URL =
  process.env.GAS_API_URL ??
  "https://script.google.com/macros/s/AKfycbyRff4-lLXmne-iPIEf87x4-CH_5wb-Uv5dCGymELLrpiKluhg2gDdLdVP4Y0MmxnnT/exec";
const GAS_KEY = process.env.GAS_API_KEY ?? "village2026";

// 서버 인메모리 캐시(30초). GAS는 operations를 300초 자체 캐시하므로 30초 Next 캐시는 안전하고,
// 60초 폴링·재진입·하드리프레시가 GAS 콜드스타트(2.6s)를 매번 때리지 않고 캐시 히트로 즉답한다.
const TTL = 30_000;
const cache = new Map<string, { at: number; body: string }>();

export async function GET(req: NextRequest) {
  if (!(await isAuthedRequest(req))) return NextResponse.json({ error: "인증 필요" }, { status: 401 });
  try {
    const qs = new URLSearchParams(req.nextUrl.searchParams);
    qs.set("key", GAS_KEY);
    qs.set("action", "operations");
    const ck = qs.toString();

    const hit = cache.get(ck);
    if (hit && Date.now() - hit.at < TTL) {
      return new NextResponse(hit.body, {
        headers: { "content-type": "application/json", "x-cache": "HIT", "cache-control": "private, max-age=20" },
      });
    }

    const r = await fetch(`${GAS_URL}?${ck}`, { redirect: "follow", signal: AbortSignal.timeout(40_000) });
    const body = await r.text();
    if (r.ok) cache.set(ck, { at: Date.now(), body });
    return new NextResponse(body, {
      headers: { "content-type": "application/json", "x-cache": "MISS", "cache-control": "private, max-age=20" },
    });
  } catch (e) {
    return NextResponse.json({ error: "GAS 호출 실패: " + (e instanceof Error ? e.message : String(e)) }, { status: 502 });
  }
}
