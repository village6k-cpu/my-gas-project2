import { NextRequest, NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/server/authCache";
import bundle from "./customers.json";

// 고객 카드 API — "이 사람 누구지?" 5년 프로필 (로그인 게이트).
// 데이터: customers.json (village-ai scripts/customer/build_customer_cards.mjs 생성,
// public/ 아님 — 개인정보라 서버에서만 읽고 인증 후 1명분만 반환).

// 이 라우트는 페이로드 전체가 고객 개인정보 — 다른 라우트들의 시드모드 폴백(fail-open)과 달리
// env가 빠지면 무조건 잠근다(fail-closed). env 드리프트 한 번이 곧 2,578명 노출이기 때문.
// 토큰 검증은 공유 authCache(60초 캐시) 사용 — 카드 열 때마다 GoTrue 왕복(150~400ms)을 반복하지 않는다.
// isAuthedRequest는 env 미설정 시 fail-open이므로 쓰지 않고, env 검사 + getAuthedUser 조합으로 잠근다.

type CustomerRecord = Record<string, unknown>;
const CUSTOMERS = (bundle as { customers: Record<string, CustomerRecord> }).customers;

export async function GET(req: NextRequest) {
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    return NextResponse.json({ error: "인증 설정 없음 — 잠금" }, { status: 503 });
  }
  const user = await getAuthedUser(req);
  if (!user) return NextResponse.json({ error: "인증 필요" }, { status: 401 });
  const name = (req.nextUrl.searchParams.get("name") ?? "").trim();
  if (!name) return NextResponse.json({ error: "name 파라미터 필요" }, { status: 400 });
  const hit = CUSTOMERS[name] ?? null;
  return NextResponse.json({ name, found: !!hit, profile: hit });
}
