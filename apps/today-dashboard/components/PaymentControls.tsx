"use client";

import { useState } from "react";
import type { Trade } from "@/lib/domain/types";
import {
  regenerateContract,
  requestProofIssue,
  sendEstimate,
  setBillingCompany,
  setDepositStatus,
  setPaymentMethod,
  setProofType,
} from "@/lib/data/store";
import { won } from "@/lib/domain/status";
import { ChevronRight, Doc, Refresh, Send } from "./icons";

const PAY = ["계좌이체", "현장카드", "카드결제", "현금"];
const DEPOSIT = ["입금완료", "결제대기", "미입금"];
const PROOF = ["세금계산서", "현금영수증", "안함"];
const BILLING_KNOWN = ["노을미디어", "감성필름", "원데이웍스", "빌리지"];

const isBad = (s?: string) => !!s && /미|대기|예정|실패/.test(s);

export function PaymentControls({ trade }: { trade: Trade }) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [issuing, setIssuing] = useState(false);
  const isTax = trade.proofType === "세금계산서";
  const isRegenerating = trade.contractRegenPending || regenerating;

  // 한 줄 요약 토큰
  const tokens: { t: string; bad?: boolean }[] = [];
  if (trade.paymentMethod) tokens.push({ t: trade.paymentMethod });
  if (trade.depositStatus) tokens.push({ t: trade.depositStatus, bad: isBad(trade.depositStatus) });
  if (trade.proofType && trade.proofType !== "안함") tokens.push({ t: trade.proofType });
  if (isTax && trade.issueStatus) tokens.push({ t: trade.issueStatus, bad: isBad(trade.issueStatus) });

  return (
    <div className="mt-3 border-t border-black/5 pt-3">
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
          <Select label="결제수단" options={PAY} value={trade.paymentMethod} onChange={(v) => setPaymentMethod(trade.tradeId, v)} />
          <Select label="입금상태" options={DEPOSIT} value={trade.depositStatus} onChange={(v) => setDepositStatus(trade.tradeId, v)} danger={isBad(trade.depositStatus)} />
          <Select label="증빙" options={PROOF} value={trade.proofType} onChange={(v) => setProofType(trade.tradeId, v)} />

          {/* 세금계산서일 때만 발행처·발행상태 */}
          {isTax && (
            <>
              <label className="flex items-center gap-2">
                <span className="w-12 shrink-0 text-[12px] font-semibold text-ink-mute">발행처</span>
                <input
                  list="billing-known"
                  defaultValue={trade.billingCompany ?? ""}
                  onBlur={(e) => setBillingCompany(trade.tradeId, e.target.value)}
                  placeholder="상호 입력"
                  className="flex-1 rounded-lg border border-black/15 bg-white px-3 py-2 text-[13.5px] font-semibold text-ink outline-none focus:border-brand-500"
                />
                <datalist id="billing-known">
                  {BILLING_KNOWN.map((b) => (
                    <option key={b} value={b} />
                  ))}
                </datalist>
              </label>
              <div className="flex items-center gap-2">
                <span className="w-12 shrink-0 text-[12px] font-semibold text-ink-mute">발행상태</span>
                <span className={`min-w-0 flex-1 rounded-lg border px-3 py-2 text-[13.5px] font-semibold ${isBad(trade.issueStatus) ? "border-attention-ring bg-attention-bg text-attention-fg" : "border-black/10 bg-black/[0.02] text-ink-soft"}`}>
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
                  className="tap shrink-0 rounded-lg bg-brand-600 px-3 py-2 text-[13px] font-bold text-white shadow-sm disabled:bg-black/[0.08] disabled:text-ink-faint disabled:shadow-none"
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
            <button
              onClick={() => !trade.estimateSent && setConfirming(true)}
              className={`tap inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-[13px] font-bold ${
                trade.estimateSent ? "bg-checkin-bg text-checkin-fg ring-1 ring-checkin-ring" : "bg-brand-600 text-white shadow-sm"
              }`}
            >
              <Send className="h-3.5 w-3.5" />
              {trade.estimateSent ? "견적서 발송됨" : "견적서 발송"}
            </button>
            <a
              href={trade.contractUrl ?? undefined}
              target="_blank"
              className={`tap inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-[13px] font-bold ring-1 ${
                trade.contractUrl ? "bg-white text-ink-soft ring-black/15" : "bg-black/[0.03] text-ink-faint ring-black/5"
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
                  .catch(() => undefined)
                  .finally(() => setRegenerating(false));
              }}
              className="tap inline-flex items-center gap-1.5 rounded-lg bg-brand-50 px-3 py-2 text-[13px] font-bold text-brand-700 ring-1 ring-brand-200 disabled:bg-black/[0.03] disabled:text-ink-faint disabled:ring-black/5"
            >
              <Refresh className={`h-3.5 w-3.5 ${isRegenerating ? "animate-spin" : ""}`} />
              {isRegenerating ? "재생성 중…" : "계약서 재생성"}
            </button>
          </div>
        </div>
      )}

      {confirming && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center" onClick={() => setConfirming(false)}>
          <div className="animate-pop w-full max-w-md rounded-t-2xl bg-white p-5 shadow-pop sm:rounded-2xl" onClick={(e) => e.stopPropagation()}>
            <p className="text-[16px] font-bold text-ink">견적서를 발송할까요?</p>
            <p className="mt-1 text-[13.5px] text-ink-mute">
              {trade.customerName}님 · {trade.customerPhone}
            </p>
            <div className="mt-4 flex gap-2">
              <button onClick={() => setConfirming(false)} className="tap flex-1 rounded-xl bg-black/[0.05] py-3 text-[14px] font-bold text-ink-soft">
                취소
              </button>
              <button
                onClick={() => {
                  sendEstimate(trade.tradeId);
                  setConfirming(false);
                }}
                className="tap flex-1 rounded-xl bg-brand-600 py-3 text-[14px] font-bold text-white shadow-sm"
              >
                발송
              </button>
            </div>
          </div>
        </div>
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
            danger ? "border-attention-ring text-attention-fg" : "border-black/15 text-ink"
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
