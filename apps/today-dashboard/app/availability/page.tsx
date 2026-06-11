"use client";

// 고객용 공개 페이지 — 예약 가능 확인 + 예상 견적 + 예약 신청 접수.
// 직원 로그인 없이 접근(AuthGate PUBLIC_PATHS). 서버 공개 라우트(/api/public/*)만 호출하며
// 화면 어디에도 다른 고객의 예약 정보는 노출되지 않는다.

import { useEffect, useMemo, useRef, useState } from "react";
import { VillageLogo } from "@/components/VillageLogo";

interface ItemRow {
  id: number;
  name: string;
  qty: number;
}

interface ResultComponent {
  name: string;
  need: number;
  status: string;
}

interface ResultItem {
  input: string;
  name: string;
  qty: number;
  isSet: boolean;
  unitPrice: number;
  status: string; // 가용 | 부족 | 불가 | 미등록
  availQty: number | null;
  components: ResultComponent[];
}

interface AvailResult {
  success: boolean;
  error?: string;
  days: number;
  longTermRate: number;
  preRate: number;
  items: ResultItem[];
  listTotal: number;
  grossTotal: number;
  estimatedTotal: number;
  priceComplete: boolean;
  allAvailable: boolean;
}

const HOURS = Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, "0")}:00`);
const DISCOUNT_OPTIONS = [
  { value: "일반", label: "일반" },
  { value: "학생", label: "학생 (사전할인 30%)" },
  { value: "개인사업자/프리랜서", label: "개인사업자·프리랜서 (사전할인 20%)" },
];

function todayStr(offsetDays = 0): string {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function won(n: number): string {
  return n.toLocaleString("ko-KR") + "원";
}

function statusBadge(status: string) {
  if (status === "가용")
    return <span className="rounded-full bg-checkin-bg px-2.5 py-0.5 text-[12px] font-bold text-checkin-fg ring-1 ring-checkin-ring">✅ 가능</span>;
  if (status === "부족")
    return <span className="rounded-full bg-warn-bg px-2.5 py-0.5 text-[12px] font-bold text-warn-fg ring-1 ring-warn-ring">⚠️ 일부만 가능</span>;
  if (status === "미등록")
    return <span className="rounded-full bg-paper px-2.5 py-0.5 text-[12px] font-bold text-ink-mute ring-1 ring-line">❓ 별도 문의</span>;
  return <span className="rounded-full bg-attention-bg px-2.5 py-0.5 text-[12px] font-bold text-attention-fg ring-1 ring-attention-ring">❌ 불가</span>;
}

let nextRowId = 1;

export default function PublicAvailabilityPage() {
  const [catalog, setCatalog] = useState<string[]>([]);
  const [checkoutDate, setCheckoutDate] = useState(todayStr(1));
  const [checkoutTime, setCheckoutTime] = useState("10:00");
  const [returnDate, setReturnDate] = useState(todayStr(2));
  const [returnTime, setReturnTime] = useState("18:00");
  const [discountType, setDiscountType] = useState("일반");
  const [rows, setRows] = useState<ItemRow[]>([{ id: nextRowId++, name: "", qty: 1 }]);
  const [activeSuggest, setActiveSuggest] = useState<number | null>(null);

  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<AvailResult | null>(null);
  const [error, setError] = useState("");

  // 예약 신청 폼
  const [custName, setCustName] = useState("");
  const [custPhone, setCustPhone] = useState("");
  const [custNote, setCustNote] = useState("");
  const [honeypot, setHoneypot] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [doneReqID, setDoneReqID] = useState<string | null>(null);
  const resultRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    fetch("/api/public/catalog")
      .then((r) => r.json())
      .then((j) => {
        if (j?.success && Array.isArray(j.names)) setCatalog(j.names.map(String));
      })
      .catch(() => {});
  }, []);

  const validRows = useMemo(() => rows.filter((r) => r.name.trim()), [rows]);

  function suggestionsFor(q: string): string[] {
    const key = q.trim().toLowerCase().replace(/\s+/g, "");
    if (!key) return [];
    return catalog
      .filter((n) => n.toLowerCase().replace(/\s+/g, "").includes(key))
      .slice(0, 8);
  }

  function setRow(id: number, patch: Partial<ItemRow>) {
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  async function runCheck() {
    setError("");
    setResult(null);
    setDoneReqID(null);
    setSubmitError("");
    if (!validRows.length) {
      setError("장비를 1개 이상 입력해주세요.");
      return;
    }
    setChecking(true);
    try {
      const res = await fetch("/api/public/availability", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          checkoutDate,
          checkoutTime,
          returnDate,
          returnTime,
          discountType,
          items: validRows.map((r) => ({ name: r.name.trim(), qty: r.qty })),
        }),
      });
      const j = (await res.json()) as AvailResult;
      if (!j.success) {
        setError(j.error || "조회에 실패했습니다. 잠시 후 다시 시도해주세요.");
      } else {
        setResult(j);
        setTimeout(() => resultRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
      }
    } catch {
      setError("조회에 실패했습니다. 잠시 후 다시 시도해주세요.");
    } finally {
      setChecking(false);
    }
  }

  async function submitReserve(e: React.FormEvent) {
    e.preventDefault();
    setSubmitError("");
    setSubmitting(true);
    try {
      const res = await fetch("/api/public/reserve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: custName,
          phone: custPhone,
          note: custNote,
          website: honeypot,
          checkoutDate,
          checkoutTime,
          returnDate,
          returnTime,
          discountType,
          items: validRows.map((r) => ({ name: r.name.trim(), qty: r.qty })),
        }),
      });
      const j = await res.json();
      if (j?.success) {
        setDoneReqID(String(j.reqID || ""));
      } else {
        setSubmitError(String(j?.error || "접수에 실패했습니다. 잠시 후 다시 시도해주세요."));
      }
    } catch {
      setSubmitError("접수에 실패했습니다. 잠시 후 다시 시도해주세요.");
    } finally {
      setSubmitting(false);
    }
  }

  const inputCls =
    "w-full rounded-[8px] border border-line bg-white px-3 py-2.5 text-[15px] font-semibold text-ink outline-none transition placeholder:text-ink-faint/70 focus:border-brand-500 focus:ring-2 focus:ring-brand-100";

  return (
    <div className="min-h-dvh bg-paper px-4 py-8 text-ink">
      <div className="mx-auto w-full max-w-[640px]">
        <header className="mb-7 flex flex-col items-center text-center">
          <VillageLogo size="lg" />
          <h1 className="mt-4 text-[22px] font-black leading-tight">예약 가능 확인 · 견적</h1>
          <p className="mt-2 text-[13px] font-medium leading-relaxed text-ink-mute">
            날짜와 장비를 선택하면 바로 예약 가능 여부와 예상 금액을 확인할 수 있어요.
          </p>
        </header>

        {/* ── 기간 + 할인 ── */}
        <section className="rounded-[10px] border border-line/80 bg-white/85 p-4 shadow-card">
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="mb-1.5 block text-[12px] font-bold text-ink-mute">반출일</span>
              <input type="date" value={checkoutDate} min={todayStr()} onChange={(e) => setCheckoutDate(e.target.value)} className={inputCls} />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-[12px] font-bold text-ink-mute">반출 시간</span>
              <select value={checkoutTime} onChange={(e) => setCheckoutTime(e.target.value)} className={inputCls}>
                {HOURS.map((h) => (
                  <option key={h} value={h}>{h}</option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1.5 block text-[12px] font-bold text-ink-mute">반납일</span>
              <input type="date" value={returnDate} min={checkoutDate} onChange={(e) => setReturnDate(e.target.value)} className={inputCls} />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-[12px] font-bold text-ink-mute">반납 시간</span>
              <select value={returnTime} onChange={(e) => setReturnTime(e.target.value)} className={inputCls}>
                {HOURS.map((h) => (
                  <option key={h} value={h}>{h}</option>
                ))}
              </select>
            </label>
          </div>
          <label className="mt-3 block">
            <span className="mb-1.5 block text-[12px] font-bold text-ink-mute">할인 유형</span>
            <select value={discountType} onChange={(e) => setDiscountType(e.target.value)} className={inputCls}>
              {DISCOUNT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </label>
        </section>

        {/* ── 장비 목록 ── */}
        <section className="mt-4 rounded-[10px] border border-line/80 bg-white/85 p-4 shadow-card">
          <div className="mb-2 text-[13px] font-bold text-ink-mute">대여할 장비 / 세트</div>
          <div className="space-y-2.5">
            {rows.map((row) => {
              const sugg = activeSuggest === row.id ? suggestionsFor(row.name) : [];
              return (
                <div key={row.id} className="relative">
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={row.name}
                      placeholder="장비명을 입력하세요 (예: 소니 FX3)"
                      onChange={(e) => setRow(row.id, { name: e.target.value })}
                      onFocus={() => setActiveSuggest(row.id)}
                      onBlur={() => setTimeout(() => setActiveSuggest((cur) => (cur === row.id ? null : cur)), 150)}
                      className={inputCls}
                    />
                    <input
                      type="number"
                      min={1}
                      max={50}
                      value={row.qty}
                      onChange={(e) => setRow(row.id, { qty: Math.min(50, Math.max(1, parseInt(e.target.value, 10) || 1)) })}
                      className="w-[72px] rounded-[8px] border border-line bg-white px-2 py-2.5 text-center text-[15px] font-semibold text-ink outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
                      aria-label="수량"
                    />
                    <button
                      type="button"
                      onClick={() => setRows((rs) => (rs.length > 1 ? rs.filter((r) => r.id !== row.id) : rs))}
                      className="shrink-0 rounded-[8px] border border-line bg-white px-2.5 py-2.5 text-[14px] font-bold text-ink-faint transition hover:text-attention-fg"
                      aria-label="항목 삭제"
                    >
                      ✕
                    </button>
                  </div>
                  {sugg.length > 0 && (
                    <ul className="absolute left-0 right-[120px] top-full z-10 mt-1 max-h-[220px] overflow-auto rounded-[8px] border border-line bg-white shadow-pop">
                      {sugg.map((name) => (
                        <li key={name}>
                          <button
                            type="button"
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => {
                              setRow(row.id, { name });
                              setActiveSuggest(null);
                            }}
                            className="block w-full px-3 py-2.5 text-left text-[14px] font-semibold text-ink hover:bg-brand-50"
                          >
                            {name}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>
          <button
            type="button"
            onClick={() => setRows((rs) => [...rs, { id: nextRowId++, name: "", qty: 1 }])}
            className="mt-3 w-full rounded-[8px] border border-dashed border-line bg-paper/60 py-2.5 text-[14px] font-bold text-ink-mute transition hover:border-brand-300 hover:text-brand-600"
          >
            + 장비 추가
          </button>
        </section>

        {error && (
          <div aria-live="polite" className="mt-4 rounded-[8px] border border-attention-ring bg-attention-bg px-3 py-2.5 text-[13px] font-bold text-attention-fg">
            {error}
          </div>
        )}

        <button
          type="button"
          onClick={runCheck}
          disabled={checking}
          className="tap mt-4 w-full rounded-[8px] bg-brand-600 py-3.5 text-[16px] font-black text-white shadow-sm transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {checking ? "확인 중..." : "예약 가능 여부 · 견적 확인"}
        </button>

        {/* ── 결과 ── */}
        {result && (
          <div ref={resultRef} className="mt-6">
            <section className="rounded-[10px] border border-line/80 bg-white/85 p-4 shadow-card">
              <div className="mb-3 text-[13px] font-bold text-ink-mute">조회 결과</div>
              <ul className="space-y-2.5">
                {result.items.map((it, idx) => (
                  <li key={idx} className="rounded-[8px] border border-line/70 bg-paper/50 px-3 py-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate text-[15px] font-bold text-ink">
                          {it.name} <span className="font-semibold text-ink-faint">× {it.qty}</span>
                        </div>
                        {it.input !== it.name && (
                          <div className="text-[12px] font-medium text-ink-faint">입력: {it.input}</div>
                        )}
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        {it.unitPrice > 0 && (
                          <span className="text-[13px] font-bold text-ink-mute">{won(it.unitPrice)}/일</span>
                        )}
                        {statusBadge(it.status)}
                      </div>
                    </div>
                    {it.isSet && it.components.some((c) => c.status !== "가용") && (
                      <div className="mt-1.5 text-[12px] font-medium text-warn-fg">
                        구성품 확인 필요: {it.components.filter((c) => c.status !== "가용").map((c) => c.name).join(", ")}
                      </div>
                    )}
                  </li>
                ))}
              </ul>

              <div className="mt-4 rounded-[8px] bg-paper px-3.5 py-3">
                <div className="flex items-center justify-between text-[13px] font-semibold text-ink-mute">
                  <span>대여 기간</span>
                  <span>{result.days}일 기준</span>
                </div>
                {result.listTotal > 0 && (
                  <div className="mt-1 flex items-center justify-between text-[13px] font-semibold text-ink-mute">
                    <span>정가 합계 (일수 반영)</span>
                    <span>{won(result.grossTotal)}</span>
                  </div>
                )}
                {result.longTermRate > 0 && (
                  <div className="mt-1 flex items-center justify-between text-[13px] font-semibold text-checkin-fg">
                    <span>장기 할인</span>
                    <span>-{result.longTermRate}%</span>
                  </div>
                )}
                {result.preRate > 0 && (
                  <div className="mt-1 flex items-center justify-between text-[13px] font-semibold text-checkin-fg">
                    <span>사전 할인 ({discountType})</span>
                    <span>-{result.preRate}%</span>
                  </div>
                )}
                <div className="mt-2 flex items-center justify-between border-t border-line pt-2">
                  <span className="text-[14px] font-black text-ink">예상 금액</span>
                  <span className="text-[18px] font-black text-brand-600">
                    {result.listTotal > 0 ? won(result.estimatedTotal) : "별도 안내"}
                  </span>
                </div>
                <p className="mt-2 text-[11.5px] font-medium leading-relaxed text-ink-faint">
                  {!result.priceComplete && "일부 항목의 단가는 확정 후 안내됩니다. "}
                  예상 금액은 참고용이며, 최종 금액은 계약서 기준으로 확정됩니다.
                </p>
              </div>
            </section>

            {/* ── 예약 신청 ── */}
            <section className="mt-4 rounded-[10px] border border-line/80 bg-white/85 p-4 shadow-card">
              {doneReqID !== null ? (
                <div className="py-3 text-center">
                  <div className="text-[28px]">🎉</div>
                  <h2 className="mt-2 text-[18px] font-black text-ink">예약 신청이 접수되었습니다</h2>
                  {doneReqID && (
                    <div className="mt-2 inline-flex rounded-full border border-line bg-paper px-3 py-1 text-[13px] font-bold text-ink-mute">
                      접수번호 {doneReqID}
                    </div>
                  )}
                  <p className="mt-3 text-[13px] font-medium leading-relaxed text-ink-mute">
                    확인 후 카카오톡으로 확정 여부를 안내드립니다.
                    <br />
                    문의는 카카오톡 채널 <b>빌리지</b>로 부탁드려요.
                  </p>
                </div>
              ) : (
                <form onSubmit={submitReserve}>
                  <div className="mb-3 text-[13px] font-bold text-ink-mute">이 조건으로 예약 신청</div>
                  <div className="grid grid-cols-2 gap-3">
                    <label className="block">
                      <span className="mb-1.5 block text-[12px] font-bold text-ink-mute">예약자명</span>
                      <input type="text" value={custName} onChange={(e) => setCustName(e.target.value)} placeholder="홍길동" required maxLength={30} className={inputCls} />
                    </label>
                    <label className="block">
                      <span className="mb-1.5 block text-[12px] font-bold text-ink-mute">연락처</span>
                      <input type="tel" value={custPhone} onChange={(e) => setCustPhone(e.target.value)} placeholder="010-1234-5678" required maxLength={20} className={inputCls} />
                    </label>
                  </div>
                  <label className="mt-3 block">
                    <span className="mb-1.5 block text-[12px] font-bold text-ink-mute">요청사항 (선택)</span>
                    <textarea value={custNote} onChange={(e) => setCustNote(e.target.value)} rows={2} maxLength={300} placeholder="추가로 전달할 내용이 있다면 적어주세요." className={inputCls} />
                  </label>
                  {/* 허니팟 — 사람 눈에 안 보임 */}
                  <input
                    type="text"
                    value={honeypot}
                    onChange={(e) => setHoneypot(e.target.value)}
                    tabIndex={-1}
                    autoComplete="off"
                    aria-hidden="true"
                    name="website"
                    className="absolute left-[-9999px] h-px w-px opacity-0"
                  />
                  {submitError && (
                    <div aria-live="polite" className="mt-3 rounded-[8px] border border-attention-ring bg-attention-bg px-3 py-2.5 text-[13px] font-bold text-attention-fg">
                      {submitError}
                    </div>
                  )}
                  <button
                    type="submit"
                    disabled={submitting}
                    className="tap mt-4 w-full rounded-[8px] bg-ink py-3.5 text-[15px] font-black text-white transition hover:bg-ink-soft disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {submitting ? "접수 중..." : "예약 신청 보내기"}
                  </button>
                  <p className="mt-2.5 text-center text-[11.5px] font-medium text-ink-faint">
                    신청 즉시 확정되는 것은 아니며, 확인 후 카카오톡으로 안내드립니다.
                  </p>
                </form>
              )}
            </section>
          </div>
        )}

        <footer className="mt-8 text-center text-[12px] font-medium text-ink-faint">
          카메라 렌탈샵 빌리지 · 문의는 카카오톡 채널로
        </footer>
      </div>
    </div>
  );
}
