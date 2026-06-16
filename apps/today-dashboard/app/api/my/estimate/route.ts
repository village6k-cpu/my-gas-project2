import { NextRequest, NextResponse } from "next/server";
import { clientIp, gasGet, rateLimited } from "@/lib/server/gasPublic";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

const TOKEN_RE = /^[A-Za-z0-9가-힣_-]{3,40}\.[a-f0-9]{20}$/;
const NO_STORE_HEADERS = {
  "Cache-Control": "no-store, no-cache, max-age=0, must-revalidate",
};

type EstimateResult = {
  success?: boolean;
  pdfUrl?: string;
  error?: string;
};

export async function GET(req: NextRequest) {
  if (rateLimited(`my-estimate:${clientIp(req)}`, 12)) {
    return NextResponse.json(
      { success: false, error: "요청이 너무 잦습니다. 잠시 후 다시 시도해주세요." },
      { status: 429, headers: NO_STORE_HEADERS },
    );
  }

  const token = req.nextUrl.searchParams.get("t") ?? "";
  if (!TOKEN_RE.test(token)) {
    return NextResponse.json(
      { success: false, error: "유효하지 않은 링크입니다" },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }

  try {
    const result = (await gasGet({ action: "myPageEstimate", token })) as EstimateResult;
    if (!result?.success || !result.pdfUrl || !/^https:\/\/.+/i.test(String(result.pdfUrl))) {
      return NextResponse.json(
        { success: false, error: result?.error || "견적서 PDF를 준비하지 못했습니다." },
        { status: 502, headers: NO_STORE_HEADERS },
      );
    }

    const response = NextResponse.redirect(result.pdfUrl, 302);
    Object.entries(NO_STORE_HEADERS).forEach(([key, value]) => response.headers.set(key, value));
    return response;
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : "견적서 PDF 조회 실패" },
      { status: 502, headers: NO_STORE_HEADERS },
    );
  }
}
