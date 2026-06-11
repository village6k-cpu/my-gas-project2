import { NextRequest, NextResponse } from "next/server";
import { clientIp, gasPost, rateLimited } from "@/lib/server/gasPublic";

// 고객용 공개 가용성/견적 조회 — GAS action=publicAvail(읽기 전용) 프록시.
// 응답에는 개인정보가 없고(가용 수치·견적만), 키는 서버에만 있다.

export const runtime = "nodejs";

const TIME_RE = /^\d{2}:\d{2}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

interface PublicItem {
  이름: string;
  수량: number;
}

export async function POST(req: NextRequest) {
  if (rateLimited(`avail:${clientIp(req)}`, 20)) {
    return NextResponse.json({ success: false, error: "요청이 너무 잦습니다. 잠시 후 다시 시도해주세요." }, { status: 429 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ success: false, error: "잘못된 요청" }, { status: 400 });
  }

  const checkoutDate = String(body.checkoutDate ?? "");
  const checkoutTime = String(body.checkoutTime ?? "");
  const returnDate = String(body.returnDate ?? "");
  const returnTime = String(body.returnTime ?? "");
  const discountType = String(body.discountType ?? "일반");

  if (!DATE_RE.test(checkoutDate) || !DATE_RE.test(returnDate) || !TIME_RE.test(checkoutTime) || !TIME_RE.test(returnTime)) {
    return NextResponse.json({ success: false, error: "날짜/시간 형식 오류" }, { status: 400 });
  }

  const rawItems = Array.isArray(body.items) ? (body.items as unknown[]) : [];
  const items: PublicItem[] = rawItems
    .map((it) => {
      const o = (it ?? {}) as Record<string, unknown>;
      return {
        이름: String(o.name ?? "").trim().slice(0, 80),
        수량: Math.min(50, Math.max(1, parseInt(String(o.qty ?? "1"), 10) || 1)),
      };
    })
    .filter((it) => it.이름)
    .slice(0, 30);

  if (!items.length) {
    return NextResponse.json({ success: false, error: "장비를 1개 이상 선택해주세요." }, { status: 400 });
  }

  try {
    const result = await gasPost({
      action: "publicAvail",
      req: {
        반출일: checkoutDate,
        반출시간: checkoutTime,
        반납일: returnDate,
        반납시간: returnTime,
        할인유형: discountType,
        장비: items,
      },
    });
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : "가용성 조회 실패" },
      { status: 502 },
    );
  }
}
