// 고객용 "내 예약 페이지" — 토큰 링크(?t=...)로 본인 예약 1건만 조회 (읽기 전용).
// 직원 로그인 없이 접근(AuthGate PUBLIC_PATHS). 연락처 등 민감정보는 서버(GAS)에서부터 내려오지 않는다.
// 변경/연장/취소 요청은 이 페이지에서 받지 않고 카카오톡 채널로 안내한다.

import { Suspense, type ReactNode } from "react";
import { VillageLogo } from "@/components/VillageLogo";
import { getMyPageResponse, isValidMyPageToken } from "@/lib/server/myPageData";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

interface ReqItem {
  name: string;
  qty: number;
}

interface RequestView {
  reqID: string;
  status: string; // 확인중 | 등록완료 | 보류 | 거절
  checkoutAt: string;
  returnAt: string;
  customerName: string;
  items: ReqItem[];
}

interface TradeItem {
  name: string;
  setName: string;
  isSetHeader: boolean;
  qty: number;
}

interface TradeView {
  tradeId: string;
  customerName: string;
  checkoutAt: string;
  returnAt: string;
  status: string; // 예약 | 반출 | 반납완료 | 취소 ...
  discountType: string;
  items: TradeItem[];
}

interface MyPageData {
  success: boolean;
  error?: string;
  kind?: "trade" | "request";
  trade?: TradeView;
  request?: RequestView;
  notice?: string;
  kakaoUrl?: string;
}

type SearchParamValue = string | string[] | undefined;
type SearchParams = Promise<Record<string, SearchParamValue>>;

function firstParam(value: SearchParamValue) {
  return Array.isArray(value) ? value[0] || "" : value || "";
}

function statusBadge(status: string) {
  const base = "inline-flex rounded-full px-3 py-1 text-[13px] font-bold ring-1";
  if (status === "등록완료" || status === "예약" || status === "반출")
    return <span className={`${base} bg-checkin-bg text-checkin-fg ring-checkin-ring`}>✅ {status === "등록완료" ? "예약 확정" : status === "반출" ? "대여 중" : "예약 확정"}</span>;
  if (status === "반납완료")
    return <span className={`${base} bg-paper text-ink-mute ring-line`}>반납 완료</span>;
  if (status === "확인중")
    return <span className={`${base} bg-checkout-bg text-checkout-fg ring-checkout-ring`}>⏳ 확인 중</span>;
  if (status === "보류")
    return <span className={`${base} bg-warn-bg text-warn-fg ring-warn-ring`}>⚠️ 보류</span>;
  if (status === "거절" || status === "취소")
    return <span className={`${base} bg-attention-bg text-attention-fg ring-attention-ring`}>{status}</span>;
  return <span className={`${base} bg-paper text-ink-mute ring-line`}>{status}</span>;
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 py-2">
      <span className="shrink-0 text-[13px] font-bold text-ink-mute">{label}</span>
      <span className="text-right text-[14px] font-semibold text-ink">{value}</span>
    </div>
  );
}

function MyPageFrame({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-dvh bg-paper px-4 py-8 text-ink">
      <div className="mx-auto w-full max-w-[560px]">
        <header className="mb-6 flex flex-col items-center text-center">
          <VillageLogo size="lg" />
          <h1 className="mt-4 text-[20px] font-black leading-tight">내 예약</h1>
        </header>
        {children}
        <footer className="mt-8 text-center text-[12px] font-medium text-ink-faint">
          카메라 렌탈샵 빌리지 · 문의는 카카오톡 채널로
        </footer>
      </div>
    </div>
  );
}

function MyPageLoading() {
  return (
    <section className="rounded-[10px] border border-line/80 bg-white/85 p-6 text-center shadow-card">
      <div className="mx-auto h-8 w-8 rounded-full border-4 border-line border-t-brand-600 animate-spin" />
      <p className="mt-4 text-[15px] font-black text-ink">예약 정보를 확인하는 중...</p>
      <p className="mt-1.5 text-[13px] font-semibold text-ink-mute">잠시만 기다려주세요.</p>
    </section>
  );
}

function MyPageError({ error }: { error?: string }) {
  return (
    <div className="rounded-[10px] border border-line/80 bg-white/85 p-6 text-center shadow-card">
      <div className="text-[28px]">🔗</div>
      <p className="mt-2 text-[15px] font-bold text-ink">{error || "유효하지 않은 링크입니다"}</p>
      <p className="mt-2 text-[13px] font-medium text-ink-mute">
        링크가 만료되었거나 잘못 복사되었을 수 있어요.
        <br />
        카카오톡 채널 <b>빌리지</b>로 문의해주세요.
      </p>
    </div>
  );
}

function MyPageContent({ data, token }: { data: MyPageData; token: string }) {
  if (!data.success) return <MyPageError error={data.error} />;

  const trade = data.trade;
  const request = data.request;
  const estimateUrl = token ? `/api/my/estimate?t=${encodeURIComponent(token)}` : "";

  return (
    <>
      {/* ── 상태 카드 ── */}
      <section className="rounded-[10px] border border-line/80 bg-white/85 p-4 shadow-card">
        <div className="flex items-center justify-between">
          <div className="text-[13px] font-bold text-ink-mute">
            {trade ? `예약번호 ${trade.tradeId}` : `접수번호 ${request?.reqID}`}
          </div>
          {statusBadge(trade ? trade.status : request?.status || "")}
        </div>
        <div className="mt-3 divide-y divide-line/60">
          <Row label="예약자" value={(trade?.customerName || request?.customerName || "") + " 님"} />
          <Row label="반출" value={trade?.checkoutAt || request?.checkoutAt || "-"} />
          <Row label="반납" value={trade?.returnAt || request?.returnAt || "-"} />
          {trade?.discountType && trade.discountType !== "일반" && (
            <Row label="할인 유형" value={trade.discountType} />
          )}
        </div>
        {request?.status === "확인중" && (
          <p className="mt-2 rounded-[8px] bg-checkout-bg px-3 py-2 text-[12.5px] font-semibold leading-relaxed text-checkout-fg">
            장비 가능 여부를 확인하고 있어요. 확정되면 카카오톡으로 안내드립니다.
          </p>
        )}
        {request?.status === "보류" && (
          <p className="mt-2 rounded-[8px] bg-warn-bg px-3 py-2 text-[12.5px] font-semibold leading-relaxed text-warn-fg">
            일정 조율이 필요해 보류 중입니다. 카카오톡으로 안내드릴게요.
          </p>
        )}
      </section>

      {/* ── 품목 ── */}
      {(trade?.items.length || request?.items.length) ? (
        <section className="mt-4 rounded-[10px] border border-line/80 bg-white/85 p-4 shadow-card">
          <div className="mb-2 text-[13px] font-bold text-ink-mute">대여 품목</div>
          <ul>
            {trade
              ? trade.items.map((it, i) => (
                  <li
                    key={i}
                    className={
                      it.isSetHeader
                        ? "mt-1.5 rounded-[6px] bg-checkin-bg/60 px-2.5 py-1.5 text-[14px] font-black text-ink first:mt-0"
                        : `flex items-center justify-between px-2.5 py-1.5 text-[14px] font-semibold text-ink ${it.setName ? "pl-6 text-ink-soft" : ""}`
                    }
                  >
                    {it.isSetHeader ? (
                      <>📦 {it.setName}</>
                    ) : (
                      <>
                        <span>{it.name}</span>
                        <span className="text-[13px] font-bold text-ink-faint">× {it.qty}</span>
                      </>
                    )}
                  </li>
                ))
              : request?.items.map((it, i) => (
                  <li key={i} className="flex items-center justify-between px-2.5 py-1.5 text-[14px] font-semibold text-ink">
                    <span>{it.name}</span>
                    <span className="text-[13px] font-bold text-ink-faint">× {it.qty}</span>
                  </li>
                ))}
          </ul>
        </section>
      ) : null}

      {/* ── 견적서 PDF ── */}
      {trade && estimateUrl && (
        <a
          href={estimateUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="tap mt-4 block w-full rounded-[8px] border border-line bg-white py-3.5 text-center text-[15px] font-black text-ink shadow-sm transition hover:border-brand-300 hover:text-brand-600"
        >
          📄 견적서 PDF 확인
        </a>
      )}

      {/* ── 변경/연장/취소 안내 — 카카오톡 채널로 ── */}
      <section className="mt-4 rounded-[10px] border border-line/80 bg-white/85 p-4 text-center shadow-card">
        <div className="text-[14px] font-bold text-ink">연장 · 변경 · 취소를 원하시나요?</div>
        <p className="mt-1.5 text-[13px] font-medium leading-relaxed text-ink-mute">
          카카오톡 채널 <b>빌리지</b>로 메시지를 보내주시면
          <br />
          확인 후 바로 처리해드립니다.
        </p>
        {data.kakaoUrl && (
          <a
            href={data.kakaoUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="tap mt-3 inline-block w-full rounded-[8px] bg-[#FEE500] py-3.5 text-[15px] font-black text-[#191919] shadow-sm transition hover:brightness-95"
          >
            💬 카카오톡으로 문의하기
          </a>
        )}
      </section>

      {/* ── 안내 ── */}
      {data.notice && (
        <section className="mt-4 whitespace-pre-line rounded-[10px] border border-line/80 bg-white/85 p-4 text-[13px] font-medium leading-relaxed text-ink-soft shadow-card">
          {data.notice}
        </section>
      )}
    </>
  );
}

async function MyPageDataSection({ token }: { token: string }) {
  if (!isValidMyPageToken(token)) return <MyPageError error="유효하지 않은 링크입니다" />;

  try {
    const result = await getMyPageResponse(token);
    return <MyPageContent data={result.body as MyPageData} token={token} />;
  } catch (e) {
    return <MyPageError error={e instanceof Error ? e.message : "조회에 실패했습니다. 잠시 후 다시 시도해주세요."} />;
  }
}

export default async function MyReservationPage({ searchParams }: { searchParams?: SearchParams }) {
  const params = searchParams ? await searchParams : {};
  const token = firstParam(params.t);

  return (
    <MyPageFrame>
      <Suspense fallback={<MyPageLoading />}>
        <MyPageDataSection token={token} />
      </Suspense>
    </MyPageFrame>
  );
}
