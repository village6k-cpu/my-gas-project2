import { NextRequest, NextResponse } from "next/server";
import { clientIp, gasPost, rateLimited } from "@/lib/server/gasPublic";

// 고객용 예약 신청 접수 — GAS run&func=insertAndCheckRequest 프록시.
// 기존 확인요청 입력 경로(카톡 봇과 동일 진입점)를 그대로 사용하므로
// 중복 차단(_findDuplicateConfirmRequest_/checkDuplicateRequest)과 가용확인이 자동 적용된다.

export const runtime = "nodejs";

const TIME_RE = /^\d{2}:\d{2}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PHONE_RE = /^0\d{1,2}-?\d{3,4}-?\d{4}$/;

export async function POST(req: NextRequest) {
  // 접수는 시트에 행을 만들므로 조회보다 빡빡하게 제한
  if (rateLimited(`reserve:${clientIp(req)}`, 5, 10 * 60_000)) {
    return NextResponse.json({ success: false, error: "요청이 너무 잦습니다. 잠시 후 다시 시도해주세요." }, { status: 429 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ success: false, error: "잘못된 요청" }, { status: 400 });
  }

  // 허니팟: 봇이 채우는 숨김 필드 — 채워져 있으면 조용히 성공 흉내
  if (String(body.website ?? "").trim()) {
    return NextResponse.json({ success: true, reqID: null });
  }

  const name = String(body.name ?? "").trim().slice(0, 30);
  const phone = String(body.phone ?? "").trim().slice(0, 20);
  const checkoutDate = String(body.checkoutDate ?? "");
  const checkoutTime = String(body.checkoutTime ?? "");
  const returnDate = String(body.returnDate ?? "");
  const returnTime = String(body.returnTime ?? "");
  const discountType = String(body.discountType ?? "일반");
  const note = String(body.note ?? "").trim().slice(0, 300);

  if (!name) return NextResponse.json({ success: false, error: "예약자명을 입력해주세요." }, { status: 400 });
  if (!PHONE_RE.test(phone)) {
    return NextResponse.json({ success: false, error: "연락처 형식을 확인해주세요. (예: 010-1234-5678)" }, { status: 400 });
  }
  if (!DATE_RE.test(checkoutDate) || !DATE_RE.test(returnDate) || !TIME_RE.test(checkoutTime) || !TIME_RE.test(returnTime)) {
    return NextResponse.json({ success: false, error: "날짜/시간 형식 오류" }, { status: 400 });
  }

  const rawItems = Array.isArray(body.items) ? (body.items as unknown[]) : [];
  const items = rawItems
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
    const raw = (await gasPost({
      action: "run",
      func: "insertAndCheckRequest",
      args: {
        예약자명: name,
        연락처: phone,
        반출일: checkoutDate,
        반출시간: checkoutTime,
        반납일: returnDate,
        반납시간: returnTime,
        할인유형: discountType,
        장비: items,
        비고: ["[웹 견적페이지 접수]", note].filter(Boolean).join(" "),
      },
    })) as Record<string, unknown>;

    // 내부 결과(시트 상세)는 노출하지 않고 접수 사실만 반환
    const inner = (raw.result ?? raw) as Record<string, unknown>;
    const reqID = String(inner.reqID ?? "");
    const duplicate = Boolean(inner.duplicate);
    if (raw.error || inner.error) {
      const msg = String(raw.error ?? inner.error);
      return NextResponse.json(
        { success: false, error: msg },
        { status: msg.includes("중복") ? 409 : 502 },
      );
    }
    return NextResponse.json({ success: true, reqID, duplicate });
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : "예약 신청 접수 실패" },
      { status: 502 },
    );
  }
}
