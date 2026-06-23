"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { Trade } from "@/lib/domain/types";
import {
  getPayAppPaymentRequest,
  regenerateContract,
  requestProofIssue,
  sendEstimate,
  sendPayAppPaymentLink,
  sendStatement,
  setBillingCompany,
  setDepositStatus,
  setPaymentMethod,
  setProofType,
} from "@/lib/data/store";
import { gasRead } from "@/lib/data/writeback";
import { won } from "@/lib/domain/status";
import { MyReservationLinkButton } from "./MyReservationLinkButton";
import { ChevronRight, Doc, Refresh, Send } from "./icons";

const FALLBACK_PAYMENT_OPTIONS = ["미정", "계좌", "카드", "현금", "기타"];
const FALLBACK_DEPOSIT_STATUS_OPTIONS = ["미입금", "입금완료", "부분입금", "환불"];
const FALLBACK_PROOF_TYPE_OPTIONS = ["미발행", "세금계산서", "현금영수증(전화번호)", "현금영수증(사업자번호)"];

type PaymentControlOptions = {
  paymentOptions: string[];
  depositStatusOptions: string[];
  proofTypeOptions: string[];
  billingCompanyOptions: string[];
};

const FALLBACK_CONTROL_OPTIONS: PaymentControlOptions = {
  paymentOptions: FALLBACK_PAYMENT_OPTIONS,
  depositStatusOptions: FALLBACK_DEPOSIT_STATUS_OPTIONS,
  proofTypeOptions: FALLBACK_PROOF_TYPE_OPTIONS,
  billingCompanyOptions: [],
};

let cachedPaymentControlOptions: PaymentControlOptions | null = null;
let paymentControlOptionsPromise: Promise<PaymentControlOptions> | null = null;

const isBad = (s?: string) => !!s && /미|대기|예정|실패/.test(s);

function readOptions(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  const options = value.map((v) => String(v || "").trim()).filter(Boolean);
  return options.length ? Array.from(new Set(options)) : fallback;
}

function withCurrentOption(options: string[], value?: string) {
  const current = String(value || "").trim();
  if (!current || options.includes(current)) return options;
  return [current, ...options];
}

function buildPayAppConfirmMessage(trade: Trade) {
  const amount = trade.amount != null ? won(trade.amount) : "금액 없음";
  return [
    "이 거래건으로 결제링크를 발송할까요?",
    "",
    `거래ID: ${trade.tradeId}`,
    `예약자: ${trade.customerName || "-"}`,
    `연락처: ${trade.customerPhone || "-"}`,
    `금액: ${amount}`,
  ].join("\n");
}

function formatPayAppPaymentRequestResult(result: any) {
  const amount = result?.amount != null ? won(Number(result.amount)) : "";
  return [
    result?.message || "PayApp 결제링크 정보",
    "",
    result?.payurl ? `고객 결제URL: ${result.payurl}` : "",
    result?.mulNo ? `PayApp 요청번호: ${result.mulNo}` : "",
    amount ? `요청금액: ${amount}` : "",
    result?.customerName ? `예약자: ${result.customerName}` : "",
    result?.phoneMasked ? `연락처: ${result.phoneMasked}` : "",
    result?.requestedAt ? `요청시각: ${result.requestedAt}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

async function loadPaymentControlOptions(): Promise<PaymentControlOptions> {
  if (cachedPaymentControlOptions) return cachedPaymentControlOptions;
  if (!paymentControlOptionsPromise) {
    paymentControlOptionsPromise = gasRead("dashboard")
      .then((data) => {
        const loaded = {
          paymentOptions: readOptions(data.paymentOptions, FALLBACK_PAYMENT_OPTIONS),
          proofTypeOptions: readOptions(data.proofTypeOptions, FALLBACK_PROOF_TYPE_OPTIONS),
          depositStatusOptions: readOptions(data.depositStatusOptions, FALLBACK_DEPOSIT_STATUS_OPTIONS),
          billingCompanyOptions: readOptions(data.billingCompanyOptions, []),
        };
        cachedPaymentControlOptions = loaded;
        return loaded;
      })
      .catch(() => FALLBACK_CONTROL_OPTIONS)
      .finally(() => {
        paymentControlOptionsPromise = null;
      });
  }
  return paymentControlOptionsPromise;
}

function usePaymentControlOptions() {
  const [options, setOptions] = useState<PaymentControlOptions>(() => cachedPaymentControlOptions || FALLBACK_CONTROL_OPTIONS);

  useEffect(() => {
    let alive = true;
    loadPaymentControlOptions().then((loaded) => {
      if (alive) setOptions(loaded);
    });
    return () => {
      alive = false;
    };
  }, []);

  return options;
}

function DocumentSendDialog({
  title,
  trade,
  onClose,
  onConfirm,
}: {
  title: string;
  trade: Trade;
  onClose: () => void;
  onConfirm: () => void;
}) {
  if (typeof document === "undefined") return null;

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-end justify-center bg-black/45 px-3 pb-[env(safe-area-inset-bottom)] sm:items-center sm:p-4" onClick={onClose}>
      <div
        className="animate-pop max-h-[88dvh] w-full max-w-md overflow-y-auto rounded-t-2xl bg-white p-5 shadow-pop ring-1 ring-line sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="text-[16px] font-bold text-ink">{title}</p>
        <p className="mt-1 text-[13.5px] text-ink-mute">
          {trade.customerName}님 · {trade.customerPhone}
        </p>
        <div className="mt-4 flex gap-2">
          <button onClick={onClose} className="tap flex-1 rounded-xl bg-line/40 py-3 text-[14px] font-bold text-ink-soft">
            취소
          </button>
          <button onClick={onConfirm} className="tap flex-1 rounded-xl bg-brand-600 py-3 text-[14px] font-bold text-white shadow-sm">
            발송
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function PaymentControls({ trade }: { trade: Trade }) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [confirmingStatement, setConfirmingStatement] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [issuing, setIssuing] = useState(false);
  const [sendingPayAppLink, setSendingPayAppLink] = useState(false);
  const [checkingPayAppLink, setCheckingPayAppLink] = useState(false);
  const [sendingStatement, setSendingStatement] = useState(false);
  const options = usePaymentControlOptions();
  const isTax = trade.proofType === "세금계산서";
  const isRegenerating = trade.contractRegenPending || regenerating;
  const canOpenContract = !!trade.contractUrl && !trade.contractRegenPending;

  // 한 줄 요약 토큰
  const tokens: { t: string; bad?: boolean }[] = [];
  if (trade.paymentMethod) tokens.push({ t: trade.paymentMethod });
  if (trade.depositStatus) tokens.push({ t: trade.depositStatus, bad: isBad(trade.depositStatus) });
  if (trade.proofType && trade.proofType !== "안함") tokens.push({ t: trade.proofType });
  if (isTax && trade.issueStatus) tokens.push({ t: trade.issueStatus, bad: isBad(trade.issueStatus) });

  return (
    <div className="mt-3 border-t border-line/60 pt-3">
      {/* 접힌 요약 — 탭하면 편집 */}
      <button onClick={() => setOpen((v) => !v)} className="tap flex w-full items-center gap-2 text-left">
        <span className="shrink-0 text-[12px] font-bold text-ink-soft">결제 · 정산</span>
        <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
          {tokens.length === 0 ? (
            <span className="text-[12px] text-ink-faint">정보 입력</span>
          ) : (
            tokens.map((tk, i) => (
              <span key={i} className={`text-[12px] font-semibold ${tk.bad ? "text-attention-fg" : "text-ink-mute"}`}>
                {tk.t}
                {i < tokens.length - 1 && <span className="text-ink-faint"> · </span>}
              </span>
            ))
          )}
        </span>
        {trade.amount != null && <span className="shrink-0 text-[14px] font-extrabold tabular-nums text-ink">{won(trade.amount)}</span>}
        <ChevronRight className={`h-4 w-4 shrink-0 text-ink-faint transition-transform ${open ? "-rotate-90" : "rotate-90"}`} />
      </button>

      {open && (
        <div className="mt-2.5 space-y-2">
          <Select label="결제수단" options={withCurrentOption(options.paymentOptions, trade.paymentMethod)} value={trade.paymentMethod} onChange={(v) => setPaymentMethod(trade.tradeId, v)} />
          <Select label="입금상태" options={withCurrentOption(options.depositStatusOptions, trade.depositStatus)} value={trade.depositStatus} onChange={(v) => setDepositStatus(trade.tradeId, v)} danger={isBad(trade.depositStatus)} />
          <Select label="증빙" options={withCurrentOption(options.proofTypeOptions, trade.proofType)} value={trade.proofType} onChange={(v) => setProofType(trade.tradeId, v)} />

          {/* 세금계산서일 때만 발행처·발행상태 */}
          {isTax && (
            <>
              <BillingCompanyCombobox
                value={trade.billingCompany ?? ""}
                options={options.billingCompanyOptions}
                onSave={(v) => setBillingCompany(trade.tradeId, v)}
              />
              <div className="flex items-center gap-2">
                <span className="w-12 shrink-0 text-[12px] font-semibold text-ink-mute">발행상태</span>
                <span className={`min-w-0 flex-1 rounded-lg border px-3 py-2 text-[13.5px] font-semibold ${isBad(trade.issueStatus) ? "border-attention-ring bg-attention-bg text-attention-fg" : "border-line bg-paper/70 text-ink-soft"}`}>
                  {trade.issueStatus || "미발행"}
                </span>
                <button
                  type="button"
                  disabled={issuing}
                  onClick={() => {
                    if (issuing) return;
                    if (!window.confirm("이 거래건의 계산서/현금영수증을 실제 발행할까요?")) return;
                    setIssuing(true);
                    requestProofIssue(trade.tradeId)
                      .catch((err) => window.alert("계산서 발행 실패: " + (err instanceof Error ? err.message : String(err))))
                      .finally(() => setIssuing(false));
                  }}
                  className="tap shrink-0 rounded-lg bg-brand-600 px-3 py-2 text-[13px] font-bold text-white shadow-sm disabled:bg-line/60 disabled:text-ink-faint disabled:shadow-none"
                >
                  {issuing ? "요청 중..." : "계산서 발행요청"}
                </button>
              </div>
              {trade.issueNote && /실패|오류|증빙|발행/.test(trade.issueNote) && (
                <p className="pl-14 text-[12px] font-semibold text-ink-mute">{trade.issueNote}</p>
              )}
            </>
          )}

          <div className="flex flex-wrap items-center gap-2 pt-0.5">
            <MyReservationLinkButton tradeId={trade.tradeId} />
            <button
              onClick={() => !trade.estimateSent && setConfirming(true)}
              className={`tap inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-[13px] font-bold ${
                trade.estimateSent ? "bg-checkin-bg text-checkin-fg ring-1 ring-checkin-ring" : "bg-brand-600 text-white shadow-sm"
              }`}
            >
              <Send className="h-3.5 w-3.5" />
              {trade.estimateSent ? "견적서 발송됨" : "견적서 발송"}
            </button>
            <button
              type="button"
              disabled={sendingStatement}
              onClick={() => setConfirmingStatement(true)}
              className="tap inline-flex items-center gap-1.5 rounded-lg bg-white px-3 py-2 text-[13px] font-bold text-ink-soft ring-1 ring-line disabled:bg-paper disabled:text-ink-faint"
            >
              <Send className="h-3.5 w-3.5" />
              {sendingStatement ? "발송 중..." : trade.statementSent ? "거래명세서 발송됨" : "거래명세서 발송"}
            </button>
            <button
              type="button"
              disabled={sendingPayAppLink}
              onClick={() => {
                if (sendingPayAppLink) return;
                if (!window.confirm(buildPayAppConfirmMessage(trade))) return;
                setSendingPayAppLink(true);
                sendPayAppPaymentLink(trade.tradeId)
                  .then((result) => window.alert(formatPayAppPaymentRequestResult(result)))
                  .catch((err) => window.alert("결제링크 발송 실패: " + (err instanceof Error ? err.message : String(err))))
                  .finally(() => setSendingPayAppLink(false));
              }}
              className="tap inline-flex items-center gap-1.5 rounded-lg bg-white px-3 py-2 text-[13px] font-bold text-ink-soft ring-1 ring-line disabled:bg-paper disabled:text-ink-faint"
            >
              <Send className="h-3.5 w-3.5" />
              {sendingPayAppLink ? "발송 중..." : "결제링크 발송"}
            </button>
            <button
              type="button"
              disabled={checkingPayAppLink}
              onClick={() => {
                if (checkingPayAppLink) return;
                setCheckingPayAppLink(true);
                getPayAppPaymentRequest(trade.tradeId)
                  .then((result) => window.alert(formatPayAppPaymentRequestResult(result)))
                  .catch((err) => window.alert("결제링크 확인 실패: " + (err instanceof Error ? err.message : String(err))))
                  .finally(() => setCheckingPayAppLink(false));
              }}
              className="tap inline-flex items-center gap-1.5 rounded-lg bg-white px-3 py-2 text-[13px] font-bold text-ink-soft ring-1 ring-line disabled:bg-paper disabled:text-ink-faint"
            >
              <Send className="h-3.5 w-3.5" />
              {checkingPayAppLink ? "확인 중..." : "결제링크 확인"}
            </button>
            <a
              href={canOpenContract ? (trade.contractUrl ?? undefined) : undefined}
              target="_blank"
              onClick={(event) => {
                if (!canOpenContract) event.preventDefault();
              }}
              className={`tap inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-[13px] font-bold ring-1 ${
                canOpenContract ? "bg-white text-ink-soft ring-line" : "bg-paper text-ink-faint ring-line/70"
              }`}
            >
              <Doc className="h-3.5 w-3.5" />
              {trade.contractRegenPending ? "계약서 갱신중…" : trade.contractUrl ? "계약서 열기" : "계약서 없음"}
            </a>
            <button
              type="button"
              disabled={isRegenerating}
              onClick={() => {
                if (isRegenerating) return;
                setRegenerating(true);
                regenerateContract(trade.tradeId)
                  .catch((err) => window.alert("계약서 재생성 실패: " + (err instanceof Error ? err.message : String(err))))
                  .finally(() => setRegenerating(false));
              }}
              className="tap inline-flex items-center gap-1.5 rounded-lg bg-brand-50 px-3 py-2 text-[13px] font-bold text-brand-700 ring-1 ring-brand-200 disabled:bg-paper disabled:text-ink-faint disabled:ring-line/70"
            >
              <Refresh className={`h-3.5 w-3.5 ${isRegenerating ? "animate-spin" : ""}`} />
              {isRegenerating ? "재생성 중…" : "계약서 재생성"}
            </button>
          </div>
        </div>
      )}

      {confirming && (
        <DocumentSendDialog
          title="견적서를 발송할까요?"
          trade={trade}
          onClose={() => setConfirming(false)}
          onConfirm={() => {
            sendEstimate(trade.tradeId);
            setConfirming(false);
          }}
        />
      )}

      {confirmingStatement && (
        <DocumentSendDialog
          title="거래명세서를 발송할까요?"
          trade={trade}
          onClose={() => setConfirmingStatement(false)}
          onConfirm={() => {
            setConfirmingStatement(false);
            setSendingStatement(true);
            sendStatement(trade.tradeId)
              .catch((err) => window.alert("거래명세서 발송 실패: " + (err instanceof Error ? err.message : String(err))))
              .finally(() => setSendingStatement(false));
          }}
        />
      )}

    </div>
  );
}

function Select({
  label,
  options,
  value,
  onChange,
  danger,
}: {
  label: string;
  options: string[];
  value?: string;
  onChange: (v: string) => void;
  danger?: boolean;
}) {
  return (
    <label className="flex items-center gap-2">
      <span className="w-12 shrink-0 text-[12px] font-semibold text-ink-mute">{label}</span>
      <div className="relative flex-1">
        <select
          value={value ?? ""}
          onChange={(e) => onChange(e.target.value)}
          className={`w-full appearance-none rounded-lg border bg-white px-3 py-2 pr-8 text-[13.5px] font-semibold outline-none focus:border-brand-500 ${
            danger ? "border-attention-ring text-attention-fg" : "border-line text-ink"
          }`}
        >
          <option value="" disabled>
            선택
          </option>
          {options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
        <ChevronRight className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 rotate-90 text-ink-faint" />
      </div>
    </label>
  );
}

type FloatingRect = { left: number; top: number; width: number; maxHeight: number };

function normalizeBillingCompanyText(value: string) {
  return String(value || "").trim().replace(/\s+/g, "").toLowerCase();
}

function searchBillingCompanyOptions(options: string[], query: string, limit = 8) {
  const seen = new Set<string>();
  const cleaned = options.map((option) => String(option || "").trim()).filter(Boolean);
  const unique = cleaned.filter((option) => {
    if (seen.has(option)) return false;
    seen.add(option);
    return true;
  });
  const needle = normalizeBillingCompanyText(query);
  if (!needle) return unique.slice(0, limit);

  return unique
    .filter((option) => normalizeBillingCompanyText(option).includes(needle))
    .sort((a, b) => {
      const aStarts = normalizeBillingCompanyText(a).startsWith(needle) ? 0 : 1;
      const bStarts = normalizeBillingCompanyText(b).startsWith(needle) ? 0 : 1;
      return aStarts - bStarts;
    })
    .slice(0, limit);
}

function FloatingBillingCompanyMenu({
  open,
  anchorRef,
  options,
  exact,
  query,
  onSelect,
  onFreeInput,
}: {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  options: string[];
  exact: boolean;
  query: string;
  onSelect: (value: string) => void;
  onFreeInput: () => void;
}) {
  const [rect, setRect] = useState<FloatingRect | null>(null);

  useLayoutEffect(() => {
    if (!open || typeof window === "undefined") {
      setRect(null);
      return undefined;
    }

    const update = () => {
      const anchor = anchorRef.current;
      if (!anchor) return;
      const box = anchor.getBoundingClientRect();
      const gap = 4;
      const minHeight = 120;
      const preferredHeight = 220;
      const below = window.innerHeight - box.bottom - 8;
      const above = box.top - 8;
      const openUp = below < minHeight && above > below;
      const available = Math.max(minHeight, Math.min(preferredHeight, openUp ? above : below));
      setRect({
        left: Math.max(8, box.left),
        top: openUp ? Math.max(8, box.top - available - gap) : box.bottom + gap,
        width: Math.max(220, Math.min(box.width, window.innerWidth - Math.max(8, box.left) - 8)),
        maxHeight: available,
      });
    };

    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [anchorRef, open, options.length, query]);

  if (!open || !rect || typeof document === "undefined") return null;

  return createPortal(
    <div
      className="rounded-lg bg-white shadow-pop ring-1 ring-line"
      style={{
        position: "fixed",
        left: rect.left,
        top: rect.top,
        width: rect.width,
        maxHeight: rect.maxHeight,
        overflowY: "auto",
        zIndex: 9999,
      }}
    >
      {options.map((option) => (
        <button
          key={option}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onSelect(option)}
          className="tap flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-black/[0.03]"
        >
          <span className="flex-1 truncate text-[13px] font-semibold text-ink">{option}</span>
          <span className="rounded bg-brand-100 px-1.5 py-0.5 text-[10px] font-bold text-brand-700">DB</span>
        </button>
      ))}
      {query.trim() && !exact && (
        <button
          onMouseDown={(event) => event.preventDefault()}
          onClick={onFreeInput}
          className="tap flex w-full items-center gap-2 border-t border-line/60 bg-paper/70 px-2.5 py-1.5 text-left"
        >
          <span className="min-w-0 flex-1 truncate text-[13px] text-ink-soft">‘{query.trim()}’ 직접 입력</span>
        </button>
      )}
    </div>,
    document.body,
  );
}

function BillingCompanyCombobox({
  value,
  options,
  onSave,
}: {
  value: string;
  options: string[];
  onSave: (value: string) => void | Promise<void>;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState(value || "");
  const [focused, setFocused] = useState(false);
  const [dirty, setDirty] = useState(false);
  const committedValue = String(value || "").trim();
  const matches = useMemo(() => searchBillingCompanyOptions(withCurrentOption(options, value), query), [options, query, value]);
  const exact = !!query.trim() && matches.some((option) => option === query.trim());
  const showMenu = focused && (matches.length > 0 || !!query.trim());

  useEffect(() => {
    if (!focused && !dirty) setQuery(value || "");
  }, [dirty, focused, value]);

  const commit = (nextValue: string) => {
    const clean = nextValue.trim();
    setQuery(clean);
    setDirty(false);
    setFocused(false);
    if (clean !== committedValue) void onSave(clean);
  };

  return (
    <label className="flex items-center gap-2">
      <span className="w-12 shrink-0 text-[12px] font-semibold text-ink-mute">발행처</span>
      <div className="relative flex-1">
        <input
          ref={inputRef}
          value={query}
          onFocus={() => setFocused(true)}
          onChange={(event) => {
            setQuery(event.target.value);
            setDirty(true);
            setFocused(true);
          }}
          onBlur={() => {
            if (dirty) commit(query);
            else setFocused(false);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commit(query);
              event.currentTarget.blur();
            }
            if (event.key === "Escape") {
              event.preventDefault();
              setQuery(value || "");
              setDirty(false);
              setFocused(false);
              event.currentTarget.blur();
            }
          }}
          placeholder="발행처 상호"
          autoComplete="off"
          className="w-full rounded-lg border border-line bg-white px-3 py-2 text-[13.5px] font-semibold text-ink outline-none placeholder:text-ink-faint focus:border-brand-500"
        />
        <ChevronRight className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 rotate-90 text-ink-faint" />
      </div>
      <FloatingBillingCompanyMenu
        open={showMenu}
        anchorRef={inputRef}
        options={matches}
        exact={exact}
        query={query}
        onSelect={commit}
        onFreeInput={() => commit(query)}
      />
    </label>
  );
}
