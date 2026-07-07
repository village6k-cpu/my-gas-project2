import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import bundle from "./customers.json";

// 고객 카드 API — "이 사람 누구지?" 5년 프로필 (로그인 게이트).
// 데이터: customers.json (village-ai scripts/customer/build_customer_cards.mjs 생성,
// public/ 아님 — 개인정보라 서버에서만 읽고 인증 후 1명분만 반환).

const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const authClient = SUPA_URL && ANON ? createClient(SUPA_URL, ANON) : null;

// 이 라우트는 페이로드 전체가 고객 개인정보 — 다른 라우트들의 시드모드 폴백(fail-open)과 달리
// env가 빠지면 무조건 잠근다(fail-closed). env 드리프트 한 번이 곧 2,578명 노출이기 때문.
async function requireUser(req: NextRequest): Promise<"ok" | "unauthorized" | "unavailable"> {
  if (!authClient) return "unavailable";
  const h = req.headers.get("authorization") ?? "";
  const t = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (!t) return "unauthorized";
  const { data, error } = await authClient.auth.getUser(t);
  return !error && !!data.user ? "ok" : "unauthorized";
}

type CustomerRecord = Record<string, unknown>;
const CUSTOMERS = (bundle as { customers: Record<string, CustomerRecord> }).customers;

export async function GET(req: NextRequest) {
  const auth = await requireUser(req);
  if (auth === "unavailable") return NextResponse.json({ error: "인증 설정 없음 — 잠금" }, { status: 503 });
  if (auth === "unauthorized") return NextResponse.json({ error: "인증 필요" }, { status: 401 });
  const name = (req.nextUrl.searchParams.get("name") ?? "").trim();
  if (!name) return NextResponse.json({ error: "name 파라미터 필요" }, { status: 400 });
  const hit = CUSTOMERS[name] ?? null;
  return NextResponse.json({ name, found: !!hit, profile: hit });
}
