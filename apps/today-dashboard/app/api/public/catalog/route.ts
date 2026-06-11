import { NextResponse } from "next/server";
import { gasGet } from "@/lib/server/gasPublic";

// 고객용 장비명 자동완성 목록 — 이름·세트여부만 공개 (보유수량/단가/구성품은 비공개).
// 시트 마스터(목록/세트마스터) 기반인 dashboardEquipmentCatalog를 서버에서 받아 슬림하게 줄인다.

export const runtime = "nodejs";

interface CatalogCache {
  at: number;
  body: { success: true; names: string[] };
}

let cache: CatalogCache | null = null;
const TTL = 10 * 60_000;

export async function GET() {
  if (cache && Date.now() - cache.at < TTL) {
    return NextResponse.json(cache.body, {
      headers: { "cache-control": "public, max-age=300" },
    });
  }
  try {
    const raw = (await gasGet({ action: "dashboardEquipmentCatalog" })) as {
      success?: boolean;
      catalog?: { names?: unknown };
    };
    const names = Array.isArray(raw?.catalog?.names)
      ? (raw.catalog!.names as unknown[]).map((n) => String(n ?? "").trim()).filter(Boolean)
      : [];
    if (!names.length) throw new Error("카탈로그 비어 있음");
    const body = { success: true as const, names };
    cache = { at: Date.now(), body };
    return NextResponse.json(body, {
      headers: { "cache-control": "public, max-age=300" },
    });
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : "카탈로그 조회 실패" },
      { status: 502 },
    );
  }
}
