"use client";

// 고객용 "내 예약 페이지" — 토큰 링크(?t=...)로 본인 예약 1건만 조회.
// 직원 로그인 없이 접근(AuthGate PUBLIC_PATHS). 연락처 등 민감정보는 서버(GAS)에서부터 내려오지 않는다.

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { VillageLogo } from "@/components/VillageLogo";

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
  contractUrl: string;
}

interface MyPageData {
  success: boolean;
  error?: string;
  kind?: "trade" | "request";
  trade?: TradeView;
  request?: RequestView;
  notice?: string;
}

const REQUEST_TYPES = ["연장", "변경", "취소", "문의"] as const;

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

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 py-2">
      <span className="shrink-0 text-[13px] font-bold text-ink-mute">{label}</span>
      <span className="text-right text-[14px] font-semibold text-ink">{value}</span>
    </div>
  );
}

function MyPageInner() {
  const searchParams = useSearchParams();
  const token = searchParams.get("t") ?? "";

  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<MyPageData | null>(null);

  const [reqType, setReqType] = useState<(typeof REQUEST_TYPES)[number]>("연장");
  const [reqDetail, setReqDetail] = useState("");
  const [sending, setSending] = useState(false);
  const [sendMsg, setSendMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (!token) {
      setData({ success: false, error: "유효하지 않은 링크입니다" });
      setLoading(false);
      return;
    }
    fetch(`/api/my?t=${encodeURIComponent(token)}`)
      .then((r) => r.json())
      .then((j: MyPageData) => setData(j))
      .catch(() => setData({ success: false, error: "조회에 실패했습니다. 잠시 후 다시 시도해주세요." }))
      .finally(() => setLoading(false));
  }, [token]);

  async function submitRequest(e: React.FormEvent) {
    e.preventDefault();
    setSendMsg(null);
    setSending(true);
    try {
      const res = await fetch("/api/my", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, type: reqType, detail: reqDetail }),
      });
      const j = await res.json();
      if (j?.success) {
        setSendMsg({ ok: true, text: String(j.message || "요청이 접수되었습니다. 확인 후 카카오톡으로 안내드립니다.") });
        setReqDetail("");
      } else {
        setSendMsg({ ok: false, text: String(j?.error || "접수에 실패했습니다. 잠시 후 다시 시도해주세요.") });
      }
    } catch {
      setSendMsg({ ok: false, text: "접수에 실패했습니다. 잠시 후 다시 시도해주세요." });
    } finally {
      setSending(false);
    }
  }

  const inputCls =
    "w-full rounded-[8px] border border-line bg-white px-3 py-2.5 text-[15px] font-semibold text-ink outline-none transition placeholder:text-ink-faint/70 focus:border-brand-500 focus:ring-2 focus:ring-brand-100";

  const trade = data?.trade;
  const request = data?.request;
  const canRequest = !!data?.success && trade?.status !== "반납완료" && trade?.status !== "취소" && request?.status !== "거절";

  return (
    <div className="min-h-dvh bg-paper px-4 py-8 text-ink">
      <div className="mx-auto w-full max-w-[560px]">
        <header className="mb-6 flex flex-col items-center text-center">
          <VillageLogo size="lg" />
          <h1 className="mt-4 text-[20px] font-black leading-tight">내 예약</h1>
        </header>

        {loading && (
          <div className="py-16 text-center text-[14px] font-semibold text-ink-faint animate-pulse">불러오는 중...</div>
        )}

        {!loading && data && !data.success && (
          <div className="rounded-[10px] border border-line/80 bg-white/85 p-6 text-center shadow-card">
            <div className="text-[28px]">🔗</div>
            <p className="mt-2 text-[15px] font-bold text-ink">{data.error || "유효하지 않은 링크입니다"}</p>
            <p className="mt-2 text-[13px] font-medium text-ink-mute">
              링크가 만료되었거나 잘못 복사되었을 수 있어요.
              <br />
              카카오톡 채널 <b>빌리지</b>로 문의해주세요.
            </p>
          </div>
        )}

        {!loading && data?.success && (
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

            {/* ── 계약서 ── */}
            {trade?.contractUrl && (
              <a
                href={trade.contractUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="tap mt-4 block w-full rounded-[8px] border border-line bg-white py-3.5 text-center text-[15px] font-black text-ink shadow-sm transition hover:border-brand-300 hover:text-brand-600"
              >
                📄 계약서 · 견적 확인
              </a>
            )}

            {/* ── 연장/변경/취소 요청 ── */}
            {canRequest && (
              <section className="mt-4 rounded-[10px] border border-line/80 bg-white/85 p-4 shadow-card">
                <div className="mb-3 text-[13px] font-bold text-ink-mute">요청하기</div>
                <form onSubmit={submitRequest}>
                  <div className="grid grid-cols-4 gap-2">
                    {REQUEST_TYPES.map((t) => (
                      <button
                        key={t}
                        type="button"
                        onClick={() => setReqType(t)}
                        className={`rounded-[8px] border py-2.5 text-[14px] font-bold transition ${
                          reqType === t
                            ? "border-brand-500 bg-brand-50 text-brand-600"
                            : "border-line bg-white text-ink-mute hover:border-brand-300"
                        }`}
                      >
                        {t}
                      </button>
                    ))}
                  </div>
                  <textarea
                    value={reqDetail}
                    onChange={(e) => setReqDetail(e.target.value)}
                    rows={3}
                    maxLength={500}
                    placeholder={
                      reqType === "연장"
                        ? "예: 반납을 6월 20일 18시로 연장하고 싶어요"
                        : reqType === "변경"
                          ? "예: FX3 1대를 추가하고 싶어요 / 반출 시간을 14시로 바꾸고 싶어요"
                          : reqType === "취소"
                            ? "취소 사유를 알려주시면 처리가 빨라요 (선택)"
                            : "문의하실 내용을 적어주세요"
                    }
                    className={`${inputCls} mt-3`}
                  />
                  {sendMsg && (
                    <div
                      aria-live="polite"
                      className={`mt-3 rounded-[8px] border px-3 py-2.5 text-[13px] font-bold ${
                        sendMsg.ok
                          ? "border-checkin-ring bg-checkin-bg text-checkin-fg"
                          : "border-attention-ring bg-attention-bg text-attention-fg"
                      }`}
                    >
                      {sendMsg.text}
                    </div>
                  )}
                  <button
                    type="submit"
                    disabled={sending}
                    className="tap mt-3 w-full rounded-[8px] bg-brand-600 py-3.5 text-[15px] font-black text-white shadow-sm transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {sending ? "접수 중..." : `${reqType} 요청 보내기`}
                  </button>
                  <p className="mt-2 text-center text-[11.5px] font-medium text-ink-faint">
                    요청 즉시 변경되는 것은 아니며, 확인 후 카카오톡으로 안내드립니다.
                  </p>
                </form>
              </section>
            )}

            {/* ── 안내 ── */}
            {data.notice && (
              <section className="mt-4 whitespace-pre-line rounded-[10px] border border-line/80 bg-white/85 p-4 text-[13px] font-medium leading-relaxed text-ink-soft shadow-card">
                {data.notice}
              </section>
            )}
          </>
        )}

        <footer className="mt-8 text-center text-[12px] font-medium text-ink-faint">
          카메라 렌탈샵 빌리지 · 문의는 카카오톡 채널로
        </footer>
      </div>
    </div>
  );
}

export default function MyReservationPage() {
  return (
    <Suspense fallback={<div className="min-h-dvh bg-paper" />}>
      <MyPageInner />
    </Suspense>
  );
}
