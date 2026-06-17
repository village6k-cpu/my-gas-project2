import { NextRequest, NextResponse } from "next/server";
import { clientIp, gasGet, rateLimited } from "@/lib/server/gasPublic";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

const TOKEN_RE = /^[A-Za-z0-9가-힣_-]{3,40}\.[a-f0-9]{20}$/;
const NO_STORE_HEADERS = {
  "Cache-Control": "no-store, no-cache, max-age=0, must-revalidate",
};

const VILLAGE_OPS_API_URL =
  process.env.VILLAGE_OPS_API_URL ??
  "https://script.google.com/macros/s/AKfycbwX2V0SqRf23DCwaVojlc5YFXKTfMNLBt68edpGmCx8j0i9hkYdP_bXHKEGIcde2iS5EA/exec";
const VILLAGE_OPS_API_KEY = process.env.VILLAGE_OPS_API_KEY ?? process.env.VILLAGE_OPS_KEY ?? process.env.GAS_API_KEY ?? "village2026";

type MyPageResult = {
  success?: boolean;
  kind?: string;
  error?: string;
  trade?: { tradeId?: string };
  request?: { tradeId?: string };
  tradeId?: string;
};

type QuoteResult = {
  error?: string;
  pdfUrl?: string;
  result?: { pdfUrl?: string };
};

function tradeIdFromMyPageResult(result: MyPageResult) {
  return String(result.trade?.tradeId || result.request?.tradeId || result.tradeId || "").trim();
}

function rejectNonQuotePdfUrl(value: string) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return "";
    if (url.hostname === "docs.google.com" && /^\/spreadsheets\/d\//.test(url.pathname)) return "";
    if (/\/spreadsheets\/d\//.test(url.pathname)) return "";
    return url.toString();
  } catch {
    return "";
  }
}

async function createQuotePdfUrl(tradeId: string) {
  const url = new URL(VILLAGE_OPS_API_URL);
  url.searchParams.set("action", "previewQuote");
  url.searchParams.set("id", tradeId);
  url.searchParams.set("key", VILLAGE_OPS_API_KEY);

  const res = await fetch(url.toString(), { cache: "no-store", redirect: "follow" });
  const data = (await res.json()) as QuoteResult;
  if (!res.ok || data.error) throw new Error(data.error || `견적서 PDF 생성 실패 (${res.status})`);

  const pdfUrl = rejectNonQuotePdfUrl(String(data.pdfUrl || data.result?.pdfUrl || ""));
  if (!pdfUrl) throw new Error("견적서 PDF URL을 받지 못했습니다");
  return pdfUrl;
}

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
    const verified = (await gasGet({ action: "myPage", token })) as MyPageResult;
    if (!verified?.success) {
      return NextResponse.json(
        { success: false, error: verified?.error || "유효하지 않은 링크입니다" },
        { status: 400, headers: NO_STORE_HEADERS },
      );
    }

    const tradeId = tradeIdFromMyPageResult(verified);
    if (!tradeId) {
      return NextResponse.json(
        { success: false, error: "예약 확정 후 견적서 PDF를 확인할 수 있습니다." },
        { status: 409, headers: NO_STORE_HEADERS },
      );
    }

    const pdfUrl = await createQuotePdfUrl(tradeId);
    const response = NextResponse.redirect(pdfUrl, 302);
    Object.entries(NO_STORE_HEADERS).forEach(([key, value]) => response.headers.set(key, value));
    return response;
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : "견적서 PDF 조회 실패" },
      { status: 502, headers: NO_STORE_HEADERS },
    );
  }
}
