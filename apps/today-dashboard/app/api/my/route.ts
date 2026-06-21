import { NextRequest, NextResponse } from "next/server";
import { clientIp, rateLimited } from "@/lib/server/gasPublic";
import { MY_PAGE_NO_STORE_HEADERS, getMyPageResponse, isValidMyPageToken } from "@/lib/server/myPageData";

// 고객용 내 예약 페이지 서버 라우트 (조회 전용) — 토큰 검증은 GAS(myPage.js)가 수행.
// GAS 키는 서버에만 있고, 토큰이 틀리면 아무 정보도 내려가지 않는다.
// 변경/연장/취소 접수는 받지 않는다 — 카카오톡 채널 안내만 표시.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(req: NextRequest) {
  if (rateLimited(`my:${clientIp(req)}`, 30)) {
    return NextResponse.json(
      { success: false, error: "요청이 너무 잦습니다. 잠시 후 다시 시도해주세요." },
      { status: 429, headers: MY_PAGE_NO_STORE_HEADERS },
    );
  }
  const token = req.nextUrl.searchParams.get("t") ?? "";
  if (!isValidMyPageToken(token)) {
    return NextResponse.json(
      { success: false, error: "유효하지 않은 링크입니다" },
      { status: 400, headers: MY_PAGE_NO_STORE_HEADERS },
    );
  }
  try {
    const result = await getMyPageResponse(token);
    return NextResponse.json(result.body, { headers: { ...MY_PAGE_NO_STORE_HEADERS, "x-cache": result.cache } });
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : "조회 실패" },
      { status: 502, headers: MY_PAGE_NO_STORE_HEADERS },
    );
  }
}
