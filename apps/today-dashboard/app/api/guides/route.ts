import { NextRequest, NextResponse } from "next/server";
import { clientIp, rateLimited } from "@/lib/server/gasPublic";
import { getYouTubeGuideVideos } from "@/lib/server/youtubeGuides";

export const runtime = "nodejs";
export const maxDuration = 15;

const CACHE_HEADERS = {
  "Cache-Control": "public, s-maxage=300, stale-while-revalidate=86400",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const NO_STORE_HEADERS = {
  ...CACHE_HEADERS,
  "Cache-Control": "no-store",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CACHE_HEADERS });
}

export async function GET(req: NextRequest) {
  if (rateLimited(`guides:${clientIp(req)}`, 60)) {
    return NextResponse.json(
      { success: false, error: "요청이 너무 잦습니다. 잠시 후 다시 시도해주세요." },
      { status: 429, headers: NO_STORE_HEADERS },
    );
  }

  try {
    const result = await getYouTubeGuideVideos();
    return NextResponse.json({ success: true, ...result }, { headers: CACHE_HEADERS });
  } catch {
    return NextResponse.json(
      { success: false, error: "사용법 영상을 불러오지 못했습니다. 잠시 후 다시 시도해주세요." },
      { status: 502, headers: NO_STORE_HEADERS },
    );
  }
}
