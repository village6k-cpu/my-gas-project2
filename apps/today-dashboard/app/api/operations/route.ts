import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// 운영판 API — GAS action=operations 프록시 (로그인 게이트). follow-up-dashboard operations.html이 호출.
const GAS_URL =
  process.env.GAS_API_URL ??
  "https://script.google.com/macros/s/AKfycbyRff4-lLXmne-iPIEf87x4-CH_5wb-Uv5dCGymELLrpiKluhg2gDdLdVP4Y0MmxnnT/exec";
const GAS_KEY = process.env.GAS_API_KEY ?? "village2026";
const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const authClient = SUPA_URL && ANON ? createClient(SUPA_URL, ANON) : null;

async function requireUser(req: NextRequest): Promise<boolean> {
  if (!authClient) return true;
  const h = req.headers.get("authorization") ?? "";
  const t = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (!t) return false;
  const { data, error } = await authClient.auth.getUser(t);
  return !error && !!data.user;
}

export async function GET(req: NextRequest) {
  if (!(await requireUser(req))) return NextResponse.json({ error: "인증 필요" }, { status: 401 });
  try {
    const qs = new URLSearchParams(req.nextUrl.searchParams);
    qs.set("key", GAS_KEY);
    qs.set("action", "operations");
    const r = await fetch(`${GAS_URL}?${qs.toString()}`, { redirect: "follow", signal: AbortSignal.timeout(40_000) });
    const body = await r.text();
    return new NextResponse(body, { headers: { "content-type": "application/json" } });
  } catch (e) {
    return NextResponse.json({ error: "GAS 호출 실패: " + (e instanceof Error ? e.message : String(e)) }, { status: 502 });
  }
}
