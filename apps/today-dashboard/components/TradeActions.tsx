"use client";

import { useEffect, useState, type ReactNode } from "react";
import type { EquipmentItem, Trade } from "@/lib/domain/types";
import { isCheckoutBaselineLocked } from "@/lib/domain/status";
import { authFetch } from "@/lib/data/authFetch";
import { deleteTradeRemote } from "@/lib/data/remote";
import {
  cancelTrade,
  DISCOUNT_TYPE_OPTIONS,
  removeTradeLocally,
  setDiscountType,
  setItemName,
  setItemQty,
  updateTradeDetails,
} from "@/lib/data/store";

function localDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso || "").slice(0, 16);
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    hourCycle: "h23",
  }).formatToParts(date);
  const value = (type: string) => parts.find((part) => part.type === type)?.value || "";
  return `${value("year")}-${value("month")}-${value("day")}T${value("hour")}:${value("minute")}`;
}

export function TradeActions({
  trade,
  onRemoved,
  compact = false,
}: {
  trade: Trade;
  onRemoved?: () => void;
  compact?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function handleCancel() {
    if (!window.confirm(`'${trade.customerName}' 예약을 취소할까요?\n\n계약 기록은 남고 스케줄 점유와 계약서 파일은 정리됩니다.`)) return;
    setCancelling(true);
    const result = await cancelTrade(trade.tradeId);
    setCancelling(false);
    if (!result.ok) {
      window.alert(`취소 실패: ${result.error}`);
      return;
    }
    if (result.warning) window.alert(result.warning);
    onRemoved?.();
  }

  async function handleDelete() {
    const typed = window.prompt(
      `⚠️ 이 거래를 완전삭제하려면 거래ID를 그대로 입력하세요.\n\n${trade.customerName} · ${trade.tradeId}\n계약·스케줄·앱 기록이 영구 삭제됩니다.`,
      "",
    );
    if (typed == null) return;
    if (typed.trim() !== trade.tradeId) {
      window.alert("거래ID가 일치하지 않아 삭제를 취소했습니다.");
      return;
    }
    setDeleting(true);
    try {
      const response = await authFetch("/api/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "run", func: "deleteTrade", args: { tradeId: trade.tradeId } }),
      });
      const json = await response.json().catch(() => ({}));
      const ok = json.success || json.status === "OK" || json.result?.status === "OK";
      if (!response.ok || !ok) throw new Error(json.error || json.message || "삭제 실패");
      await deleteTradeRemote(trade.tradeId).catch(() => {});
      removeTradeLocally(trade.tradeId);
      onRemoved?.();
    } catch (error) {
      window.alert("삭제 실패: " + (error instanceof Error ? error.message : String(error)));
      setDeleting(false);
    }
  }

  const buttonBase = compact
    ? "tap flex-1 rounded-lg px-2 py-2 text-[12px] font-extrabold ring-1"
    : "tap flex-1 rounded-xl px-3 py-2.5 text-[13px] font-extrabold ring-1";

  // 할인유형은 반납완료·취소 전까지 카드에서 바로 바꿀 수 있다 — 금액·계약서는 자동 재생성
  const discountLocked = trade.returnDone || trade.contractStatus === "반납완료" || trade.contractStatus === "취소";

  return (
    <>
      <div className="flex w-full gap-2" aria-label="예약 관리">
        <button type="button" onClick={() => setEditing(true)} className={`${buttonBase} bg-brand-50 text-brand-700 ring-brand-200`}>
          ✎ 편집
        </button>
        <button type="button" onClick={handleCancel} disabled={cancelling || deleting} className={`${buttonBase} bg-warn-bg text-warn-fg ring-warn-ring disabled:opacity-50`}>
          {cancelling ? "취소 중…" : "취소"}
        </button>
        <button type="button" onClick={handleDelete} disabled={cancelling || deleting} className={`${buttonBase} bg-attention-bg text-attention-fg ring-attention-ring disabled:opacity-50`}>
          {deleting ? "삭제 중…" : "완전삭제"}
        </button>
      </div>
      <div className="mt-2 flex items-center gap-2" aria-label="할인유형">
        <span className="shrink-0 text-[12px] font-bold text-ink-mute">할인유형</span>
        <select
          value={trade.discountType || ""}
          onChange={(e) => {
            const next = e.target.value;
            if (!next) return;
            void setDiscountType(trade.tradeId, next);
          }}
          disabled={discountLocked}
          className="tap h-9 min-w-0 flex-1 rounded-lg bg-white px-2 text-[12.5px] font-bold text-ink ring-1 ring-line/70 outline-none focus:ring-brand-400 disabled:opacity-50"
        >
          <option value="" disabled>
            선택 안 됨
          </option>
          {DISCOUNT_TYPE_OPTIONS.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
        {trade.contractRegenPending && (
          <span className="shrink-0 animate-pulse rounded-full bg-brand-50 px-2 py-0.5 text-[11px] font-bold text-brand-700">계약서 갱신 중…</span>
        )}
      </div>
      {editing && <TradeEditSheet trade={trade} onClose={() => setEditing(false)} />}
    </>
  );
}

function TradeEditSheet({ trade, onClose }: { trade: Trade; onClose: () => void }) {
  const [customerName, setCustomerName] = useState(trade.customerName);
  const [customerPhone, setCustomerPhone] = useState(trade.customerPhone || "");
  const [company, setCompany] = useState(trade.company || "");
  const [checkoutAt, setCheckoutAt] = useState(() => localDateTime(trade.checkoutAt));
  const [returnAt, setReturnAt] = useState(() => localDateTime(trade.returnAt));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function saveDetails() {
    setError("");
    if (!customerName.trim() || !checkoutAt || !returnAt) {
      setError("예약자명과 반출·반납 일시를 입력해주세요.");
      return;
    }
    if (new Date(checkoutAt).getTime() >= new Date(returnAt).getTime()) {
      setError("반납 일시는 반출 일시보다 뒤여야 합니다.");
      return;
    }
    setSaving(true);
    const result = await updateTradeDetails(trade.tradeId, {
      customerName: customerName.trim(),
      customerPhone: customerPhone.trim(),
      company: company.trim(),
      checkoutDate: checkoutAt.slice(0, 10),
      checkoutTime: checkoutAt.slice(11, 16),
      returnDate: returnAt.slice(0, 10),
      returnTime: returnAt.slice(11, 16),
    });
    setSaving(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onClose();
  }

  const equipmentLocked = isCheckoutBaselineLocked(trade);

  return (
    <div className="fixed inset-0 z-[80] flex items-end justify-center bg-black/45 sm:items-center" onClick={onClose}>
      <div className="animate-pop max-h-[92vh] w-full max-w-xl overflow-y-auto rounded-t-2xl bg-white p-4 pb-8 shadow-pop sm:rounded-2xl" onClick={(event) => event.stopPropagation()}>
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-[17px] font-extrabold text-ink">예약 편집</h2>
            <p className="text-[11.5px] text-ink-mute">{trade.tradeId} · 저장하면 시트와 계약서에도 반영됩니다</p>
          </div>
          <button type="button" onClick={onClose} className="tap rounded-lg px-2 py-1 text-[18px] text-ink-faint" aria-label="닫기">✕</button>
        </div>

        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <EditField label="예약자명"><input value={customerName} onChange={(event) => setCustomerName(event.target.value)} className="inp" /></EditField>
          <EditField label="연락처"><input value={customerPhone} onChange={(event) => setCustomerPhone(event.target.value)} className="inp" inputMode="tel" /></EditField>
          <EditField label="업체명"><input value={company} onChange={(event) => setCompany(event.target.value)} className="inp" /></EditField>
          <div />
          <EditField label="반출 일시"><input type="datetime-local" value={checkoutAt} onChange={(event) => setCheckoutAt(event.target.value)} className="inp" /></EditField>
          <EditField label="반납 일시"><input type="datetime-local" value={returnAt} onChange={(event) => setReturnAt(event.target.value)} className="inp" /></EditField>
        </div>

        <section className="mt-5 border-t border-line pt-4">
          <div className="flex items-baseline justify-between gap-2">
            <h3 className="text-[14px] font-extrabold text-ink">장비명·예약 수량</h3>
            {equipmentLocked && <span className="text-[11px] font-bold text-attention-fg">반출 후 수정 잠김</span>}
          </div>
          <div className="mt-2 space-y-2">
            {trade.equipments.map((item) => (
              <EquipmentEditRow key={item.scheduleId} tradeId={trade.tradeId} item={item} locked={equipmentLocked || !!item.synthetic} />
            ))}
          </div>
        </section>

        {error && <p className="mt-3 rounded-lg bg-attention-bg px-3 py-2 text-[12px] font-bold text-attention-fg">{error}</p>}
        <div className="mt-5 flex gap-2">
          <button type="button" onClick={onClose} className="tap flex-1 rounded-xl bg-white py-3 text-[14px] font-bold text-ink-soft ring-1 ring-line">닫기</button>
          <button type="button" onClick={saveDetails} disabled={saving} className="tap flex-[2] rounded-xl bg-brand-600 py-3 text-[14px] font-extrabold text-white disabled:opacity-50">
            {saving ? "저장 중…" : "예약정보 저장"}
          </button>
        </div>
      </div>
    </div>
  );
}

function EquipmentEditRow({ tradeId, item, locked }: { tradeId: string; item: EquipmentItem; locked: boolean }) {
  const [name, setName] = useState(item.name);
  const [qty, setQty] = useState(String(item.qty || 1));
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    setName(item.name);
    setQty(String(item.qty || 1));
  }, [item.name, item.qty]);

  async function save() {
    const nextQty = Number(qty);
    if (!name.trim() || !Number.isFinite(nextQty) || nextQty < 1) {
      setMessage("이름과 1 이상의 수량을 입력하세요");
      return;
    }
    setSaving(true);
    setMessage("");
    const nameOk = name.trim() === item.name ? true : await setItemName(tradeId, item.scheduleId, name.trim());
    const qtyOk = nextQty === item.qty ? true : await setItemQty(tradeId, item.scheduleId, nextQty);
    setSaving(false);
    setMessage(nameOk && qtyOk ? "저장됨" : "저장 실패");
  }

  return (
    <div className="rounded-xl bg-paper p-2.5 ring-1 ring-line/70">
      <div className="flex gap-2">
        <input aria-label="장비명" value={name} onChange={(event) => setName(event.target.value)} disabled={locked} className="inp min-w-0 flex-1 disabled:opacity-50" />
        <input aria-label="예약 수량" value={qty} onChange={(event) => setQty(event.target.value)} disabled={locked} className="inp w-16 text-center disabled:opacity-50" inputMode="numeric" />
        <button type="button" onClick={save} disabled={locked || saving} className="tap rounded-lg bg-white px-3 text-[12px] font-extrabold text-brand-700 ring-1 ring-brand-200 disabled:opacity-40">
          {saving ? "…" : "저장"}
        </button>
      </div>
      {message && <p className={`mt-1 text-[11px] font-bold ${message === "저장됨" ? "text-checkin-fg" : "text-attention-fg"}`}>{message}</p>}
    </div>
  );
}

function EditField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block text-[12px] font-bold text-ink-mute">
      <span className="mb-1 block">{label}</span>
      {children}
    </label>
  );
}
