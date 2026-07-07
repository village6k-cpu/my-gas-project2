"use client";

import { useEffect, useState } from "react";
import type { TabKey, Trade } from "@/lib/domain/types";
import { isCancelledTrade, phaseForDate, setupProgress, timeLabel } from "@/lib/domain/status";
import { ensureTradePhotos, toggleReturn, toggleSetup } from "@/lib/data/store";
import { HandoverChecklist } from "./HandoverChecklist";
import { RiskPanel } from "./RiskPanel";
import { PhotoStrip } from "./PhotoStrip";
import { PaymentControls } from "./PaymentControls";
import { MyReservationLinkButton } from "./MyReservationLinkButton";
import { Check, ChevronRight, Phone } from "./icons";
import { MemoTag } from "./MemoTag";

const STATUS_BADGE: Record<string, string> = {
  예약: "bg-line/40 text-ink-soft",
  반출: "bg-checkout-bg text-checkout-fg",
  반납완료: "bg-checkin-bg text-checkin-fg",
  취소: "bg-attention-bg text-attention-fg line-through",
};

function displayPhase(t: Trade, date: string, tab: TabKey): "checkout" | "checkin" {
  if (tab === "checkout") return "checkout";
  if (tab === "checkin") return "checkin";
  const p = phaseForDate(t, date);
  if (p === "checkout") return "checkout";
  if (p === "checkin") return "checkin";
  if (p === "both") return t.setupDone ? "checkin" : "checkout";
  // 당일 반출/반납이 아님(다일 대여·지연 반납 등): 이미 나갔으면 반납 단계로
  return new Date(t.checkoutAt) <= new Date(`${date}T23:59:59`) ? "checkin" : "checkout";
}

export function ScheduleCard({
  trade,
  date,
  tab,
  saving,
  defaultOpen = false,
}: {
  trade: Trade;
  date: string;
  tab: TabKey;
  saving?: boolean;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const cancelled = isCancelledTrade(trade);
  const phase = displayPhase(trade, date, tab);
  const isCheckout = phase === "checkout";
  const done = isCheckout ? trade.setupDone : trade.returnDone;
  const doneAt = isCheckout ? trade.setupDoneAt : trade.returnDoneAt;
  const prog = setupProgress(trade, phase);
  const accent = isCheckout ? "bg-checkout-fg" : "bg-checkin-fg";
  const time = timeLabel(isCheckout ? trade.checkoutAt : trade.returnAt);
  const overdue = !trade.returnDone && new Date(trade.returnAt) < new Date(`${date}T00:00:00`);

  // 완료되면 상세 자동 접힘 (처리됨 느낌)
  useEffect(() => {
    if (done) setOpen(false);
  }, [done]);

  useEffect(() => {
    ensureTradePhotos([trade.tradeId]);
  }, [trade.tradeId]);

  if (cancelled) return null;

  return (
    <div
      className={`animate-pop relative overflow-hidden rounded-xl2 shadow-card ring-1 transition-all duration-300 ${
        done ? "bg-checkin-bg/40 opacity-75 ring-checkin-ring" : "bg-white ring-line/60"
      }`}
    >
      <span className={`absolute inset-y-0 left-0 w-1 ${done ? "bg-checkin-fg" : accent}`} />

      {/* 헤더 */}
      <div className="flex items-start gap-3 px-4 pl-5 pt-3.5">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={`text-[17px] font-extrabold tabular-nums ${done ? "text-ink-mute" : "text-ink"}`}>{time}</span>
            {done ? (
              <span className="inline-flex items-center gap-1 rounded-md bg-checkin-fg px-1.5 py-0.5 text-[11px] font-bold text-white">
                <Check className="h-3 w-3" /> {isCheckout ? "반출 완료" : "반납 완료"}
                {doneAt && <span className="font-medium opacity-80">{timeLabel(doneAt).replace("오전 ", "").replace("오후 ", "")}</span>}
              </span>
            ) : (
              <>
                <span className={`rounded-md px-1.5 py-0.5 text-[11px] font-bold ${STATUS_BADGE[trade.contractStatus]}`}>
                  {trade.contractStatus}
                </span>
                {overdue && <span className="rounded-md bg-attention-fg px-1.5 py-0.5 text-[11px] font-bold text-white">반납 지연</span>}
              </>
            )}
            {saving && <span className="text-[11px] font-medium text-brand-600">저장 중…</span>}
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 text-[14px]">
            <span className="font-bold text-ink">{trade.customerName}</span>
            {trade.company && <span className="text-ink-faint">· {trade.company}</span>}
          </div>
          <div className="mt-0.5 text-[12px] tabular-nums text-ink-mute">{trade.tradeId}</div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <MyReservationLinkButton tradeId={trade.tradeId} compact />
          {/* PC(넓은 화면)에선 번호 노출 — 보고 폰으로 검 */}
          <span className="hidden text-[13.5px] font-semibold tabular-nums text-ink-soft sm:inline">{trade.customerPhone}</span>
          <a
            href={`tel:${trade.customerPhone.replace(/-/g, "")}`}
            className="tap flex h-9 w-9 items-center justify-center rounded-full bg-paper ring-1 ring-line/60 text-ink-soft"
            aria-label="전화 걸기"
          >
            <Phone className="h-4 w-4" />
          </a>
        </div>
      </div>

      {/* 진행 + 토글 */}
      <div className="flex items-center gap-2.5 px-4 pl-5 pt-3">
        <button
          type="button"
          onClick={() => (isCheckout ? toggleSetup(trade.tradeId) : toggleReturn(trade.tradeId))}
          className={`tap flex flex-1 items-center justify-center gap-2 rounded-xl py-2.5 text-[14px] font-bold ring-1 ${
            done
              ? "bg-checkin-bg text-checkin-fg ring-checkin-ring"
              : isCheckout
                ? "bg-checkout-fg text-white ring-transparent"
                : "bg-checkin-fg text-white ring-transparent"
          }`}
        >
          <span className={`flex h-5 w-5 items-center justify-center rounded-full ${done ? "bg-checkin-fg/15" : "bg-white/25"}`}>
            <Check className="h-3.5 w-3.5" />
          </span>
          {isCheckout ? (done ? "반출 완료됨" : "반출 완료") : done ? "반납 완료됨" : "반납 완료"}
        </button>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="tap flex h-11 items-center gap-1.5 rounded-xl border border-line bg-white px-3 text-[13px] font-bold text-ink-soft shadow-sm"
        >
          {open ? "접기" : "품목 체크"}
          <span className="tabular-nums text-ink-mute">{prog.done}/{prog.total}</span>
          <ChevronRight className={`h-4 w-4 transition-transform ${open ? "-rotate-90" : "rotate-90"}`} />
        </button>
      </div>

      {/* 접힌 상태 메모 미리보기 — 펼치기 전에도 메모 존재와 내용이 보여야 한다 */}
      {!open && <CollapsedMemoPreview trade={trade} onOpen={() => setOpen(true)} />}

      {/* 상세 */}
      {open && (
        <div className="px-4 pb-4 pl-5 pt-1">
          <HandoverChecklist trade={trade} phase={phase} />
          <RiskPanel warnings={trade.riskWarnings} phase={phase} equipments={trade.equipments} />
          <PhotoStrip tradeId={trade.tradeId} photos={trade.photos} />
          <PaymentControls trade={trade} />
        </div>
      )}
    </div>
  );
}

function CollapsedMemoPreview({ trade, onOpen }: { trade: Trade; onOpen: () => void }) {
  const notes: { phase: "checkout" | "checkin"; text: string }[] = [
    { phase: "checkout", text: String(trade.noteCheckout ?? "").trim() },
    { phase: "checkin", text: String(trade.noteCheckin ?? "").trim() },
  ].filter((n) => n.text) as { phase: "checkout" | "checkin"; text: string }[];
  const itemMemoCount = trade.equipments.filter(
    (e) => String(e.memoCheckout || "").trim() || String(e.memoCheckin || "").trim()
  ).length;
  if (!notes.length && !itemMemoCount) return null;
  return (
    <button type="button" onClick={onOpen} className="tap mx-4 mb-3.5 ml-5 mt-2.5 block w-[calc(100%-2.25rem)] text-left">
      <div className="space-y-1 rounded-xl bg-warn-bg/60 px-2.5 py-2 ring-1 ring-warn-ring/70">
        {notes.map((n) => (
          <div key={n.phase} className="flex items-start gap-1.5">
            <span aria-hidden className="text-[12px]">📝</span>
            <MemoTag phase={n.phase} className="mt-[1px]" />
            <span className="line-clamp-2 min-w-0 break-words text-[12px] font-semibold leading-snug text-warn-fg">{n.text}</span>
          </div>
        ))}
        {itemMemoCount > 0 && (
          <div className="text-[11px] font-bold text-warn-fg/80">📌 품목 특이사항 {itemMemoCount}건 — 눌러서 확인</div>
        )}
      </div>
    </button>
  );
}
