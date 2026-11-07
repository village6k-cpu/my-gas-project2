import { NextRequest, NextResponse } from "next/server";
import { clientIp, rateLimited } from "@/lib/server/gasPublic";
import { getMyPageResponse } from "@/lib/server/myPageData";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

const TOKEN_RE = /^[A-Za-z0-9가-힣_-]{3,40}\.[a-f0-9]{20}$/;
const NO_STORE_HEADERS = {
  "Cache-Control": "no-store, no-cache, max-age=0, must-revalidate",
  "Referrer-Policy": "no-referrer",
};
const MAX_PDF_BYTES = 4 * 1024 * 1024;

const VILLAGE_OPS_API_URL =
  process.env.VILLAGE_OPS_API_URL ??
  "https://script.google.com/macros/s/AKfycbwX2V0SqRf23DCwaVojlc5YFXKTfMNLBt68edpGmCx8j0i9hkYdP_bXHKEGIcde2iS5EA/exec";
// 기존 문서 API는 village2026 운영 키를 정식 호환 경로로 사용한다.
// 별도 env가 없는 배포도 원래 동작을 유지해야 고객 견적 PDF가 끊기지 않는다.
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

  const res = await fetch(url, { cache: "no-store", redirect: "follow", signal: AbortSignal.timeout(50_000) });
  const data = (await res.json()) as QuoteResult;
  if (!res.ok || data.error) throw new Error(data.error || `견적서 PDF 생성 실패 (${res.status})`);

  const pdfUrl = rejectNonQuotePdfUrl(String(data.pdfUrl || data.result?.pdfUrl || ""));
  if (!pdfUrl) throw new Error("견적서 PDF URL을 받지 못했습니다");
  return pdfUrl;
}

async function readQuotePdf(pdfUrl: string) {
  const source = new URL(pdfUrl);
  const id = /^\/file\/d\/([\w-]+)\/view\/?$/.exec(source.pathname)?.[1]
    ?? (source.pathname === "/uc" ? source.searchParams.get("id") : null);
  if (source.hostname !== "drive.google.com" || !id || !/^[\w-]+$/.test(id)) {
    throw new Error("지원하지 않는 견적서 파일 주소");
  }
  let url = new URL("https://drive.google.com/uc");
  url.searchParams.set("export", "download");
  url.searchParams.set("id", id);
  const resourceKey = source.searchParams.get("resourcekey");
  if (resourceKey) url.searchParams.set("resourcekey", resourceKey);

  const signal = AbortSignal.timeout(15_000);
  for (let hop = 0; hop < 4; hop++) {
    if (url.protocol !== "https:" || url.port || url.username || url.password ||
        !["drive.google.com", "drive.usercontent.google.com"].includes(url.hostname)) break;
    const res = await fetch(url, { cache: "no-store", redirect: "manual", signal });
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      await res.body?.cancel();
      url = new URL(location, url);
      continue;
    }
    if (!res.ok || !res.body || Number(res.headers.get("content-length")) > MAX_PDF_BYTES) {
      await res.body?.cancel();
      break;
    }

    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_PDF_BYTES) {
        await reader.cancel();
        throw new Error("견적서 PDF 크기 제한 초과");
      }
      chunks.push(value);
    }
    const pdf = Buffer.concat(chunks);
    if (pdf.toString("ascii", 0, 5) === "%PDF-") return new Uint8Array(pdf);
    break;
  }
  throw new Error("견적서 PDF 파일을 읽지 못했습니다");
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
    // 토큰 검증은 90초 myPage 캐시(getMyPageResponse) 재사용 — 고객은 견적 버튼을 누르기 직전
    // /api/my 로딩으로 캐시를 방금 채운 상태라, 클릭당 GAS 직렬 2왕복이 1왕복(previewQuote)으로 준다.
    const { body } = await getMyPageResponse(token);
    const verified = body as MyPageResult;
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
    const format = req.nextUrl.searchParams.get("format");
    if (format === "pdf" || format === "download") {
      const pdf = await readQuotePdf(pdfUrl);
      const filename = "Village-quote-" + tradeId.replace(/[^a-zA-Z0-9_-]/g, "") + ".pdf";
      return new NextResponse(pdf, {
        headers: {
          ...NO_STORE_HEADERS,
          "Content-Type": "application/pdf",
          "Content-Disposition": `${format === "download" ? "attachment" : "inline"}; filename="${filename}"`,
          "X-Content-Type-Options": "nosniff",
        },
      });
    }
    const response = NextResponse.redirect(pdfUrl, 302);
    Object.entries(NO_STORE_HEADERS).forEach(([key, value]) => response.headers.set(key, value));
    return response;
  } catch {
    return NextResponse.json(
      { success: false, error: "견적서를 열지 못했습니다. 잠시 후 다시 시도하거나 빌리지 카카오톡 채널로 문의해주세요." },
      { status: 502, headers: NO_STORE_HEADERS },
    );
  }
}
