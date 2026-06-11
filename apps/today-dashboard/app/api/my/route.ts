import { NextRequest, NextResponse } from "next/server";
import { clientIp, gasGet, gasPost, rateLimited } from "@/lib/server/gasPublic";

// 고객용 내 예약 페이지 서버 라우트 — 토큰 검증은 GAS(myPage.js)가 수행.
// GAS 키는 서버에만 있고, 토큰이 틀리면 아무 정보도 내려가지 않는다.

export const runtime = "nodejs";

const TOKEN_RE = /^[A-Za-z0-9가-힣_-]{3,40}\.[a-f0-9]{20}$/;

export async function GET(req: NextRequest) {
  if (rateLimited(`my:${clientIp(req)}`, 30)) {
    return NextResponse.json({ success: false, error: "요청이 너무 잦습니다. 잠시 후 다시 시도해주세요." }, { status: 429 });
  }
  const token = req.nextUrl.searchParams.get("t") ?? "";
  if (!TOKEN_RE.test(token)) {
    return NextResponse.json({ success: false, error: "유효하지 않은 링크입니다" }, { status: 400 });
  }
  try {
    const result = await gasGet({ action: "myPage", token });
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : "조회 실패" },
      { status: 502 },
    );
  }
}

export async function POST(req: NextRequest) {
  if (rateLimited(`myreq:${clientIp(req)}`, 5, 10 * 60_000)) {
    return NextResponse.json({ success: false, error: "요청이 너무 잦습니다. 잠시 후 다시 시도해주세요." }, { status: 429 });
  }
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ success: false, error: "잘못된 요청" }, { status: 400 });
  }
  const token = String(body.token ?? "");
  const type = String(body.type ?? "");
  const detail = String(body.detail ?? "").trim().slice(0, 500);
  if (!TOKEN_RE.test(token)) {
    return NextResponse.json({ success: false, error: "유효하지 않은 링크입니다" }, { status: 400 });
  }
  if (!["연장", "변경", "취소", "문의"].includes(type)) {
    return NextResponse.json({ success: false, error: "요청 유형 오류" }, { status: 400 });
  }
  try {
    const result = await gasPost({ action: "myPageRequest", token, type, detail });
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : "요청 접수 실패" },
      { status: 502 },
    );
  }
}
