"use client";

import { useState } from "react";

type RiskBooking = { tid?: string; customer?: string; from?: string; to?: string; qty?: number; name?: string };
type RiskAlert = { equipment?: string; stock?: number; booked?: number; overBy?: number; severity?: string; kind?: string; reason?: string; start?: string; end?: string; component?: string; candidates?: string[]; bookings?: RiskBooking[] };
export type InventoryRiskViewData = {
  inventoryAlerts?: RiskAlert[];
  inventoryCoverage?: { start?: string; end?: string; allFuture?: boolean; complete?: boolean; schedules?: number };
  inventoryGeneratedAt?: string;
  inventoryTurnaroundMinutes?: number;
  inventoryMonitor?: { enabled?: boolean; lastScanAt?: string; error?: string | null };
};

function when(value?: string) {
  if (!value || Number.isNaN(Date.parse(value))) return "일정 확인 필요";
  return new Date(value).toLocaleString("ko-KR", { timeZone: "Asia/Seoul", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
}

export function InventoryRiskPanel({ data }: { data: InventoryRiskViewData }) {
  const [filter, setFilter] = useState("all");
  const [limit, setLimit] = useState(20);
  const alerts = data.inventoryAlerts || [];
  const conflicts = alerts.filter(a => a.severity === "conflict").length;
  const isNameRisk = (a: RiskAlert) => a.kind === "unknown_equipment" || a.kind === "ambiguous_equipment";
  const filtered = alerts.filter(a => filter === "all" || (filter === "conflict" ? a.severity === "conflict" : isNameRisk(a)));
  const monitor = data.inventoryMonitor;
  const stale = !data.inventoryGeneratedAt || Date.now() - Date.parse(data.inventoryGeneratedAt) > 180_000;
  const monitorLate = !monitor?.lastScanAt || Date.now() - Date.parse(monitor.lastScanAt) > 180_000;
  const clear = data.inventoryCoverage?.complete === true && !alerts.length && !stale;

  return (
    <section className="overflow-hidden rounded-xl bg-white shadow-card ring-1 ring-line/70" aria-label="전체 향후 일정 재고 점검">
      <div className="space-y-1.5 px-3.5 py-3">
        <h2 className={`text-[14px] font-extrabold ${conflicts ? "text-attention-fg" : "text-ink"}`}>
          {clear ? "✅ 재고 충돌·위험 없음" : `📦 재고 점검 · 🔴 부족 ${conflicts}건 · ⚠️ 위험 ${alerts.length - conflicts}건`}
        </h2>
        <p className="text-[11.5px] text-ink-mute">오늘 포함 전체 향후 예약 · 반납 여유 {data.inventoryTurnaroundMinutes ?? 60}분 · {data.inventoryCoverage?.schedules ?? "—"}개 일정</p>
        {data.inventoryGeneratedAt && <p className="text-[11px] text-ink-faint">점검 {when(data.inventoryGeneratedAt)}</p>}
        {(stale || !data.inventoryCoverage?.allFuture) && <p className="text-[12px] font-bold text-attention-fg">⚠️ 최신 점검 결과 확인 필요 — 안전 여부를 확정할 수 없습니다.</p>}
        {!monitor?.enabled ? <p className="text-[12px] font-bold text-warn-fg">🔔 자동 경보 연결 확인 필요</p>
          : (monitor.error || monitorLate) ? <p className="text-[12px] font-bold text-attention-fg">🔔 자동 경보 지연·전송 상태 확인 필요</p>
          : <p className="text-[11.5px] text-ink-mute">🔔 업무지시 채널 자동 경보 · 1분 간격 점검</p>}
        {alerts.length > 0 && (
          <div className="flex flex-wrap gap-1.5 pt-1" role="group" aria-label="위험 종류">
            {[["all", `전체 ${alerts.length}`], ["conflict", `부족 ${conflicts}`], ["names", `이름 확인 ${alerts.filter(isNameRisk).length}`]].map(([value, label]) => (
              <button key={value} aria-pressed={filter === value} onClick={() => { setFilter(value); setLimit(20); }} className={`rounded-full px-3 py-1.5 text-[12px] font-bold ring-1 ring-line ${filter === value ? "bg-ink text-white" : "bg-paper text-ink-soft"}`}>{label}</button>
            ))}
          </div>
        )}
      </div>
      <div className="divide-y divide-line/60">
        {filtered.slice(0, limit).map((a, i) => (
          <article key={`${a.kind}-${a.equipment}-${a.start}-${i}`} className="px-3.5 py-3">
            <div className="flex flex-wrap items-baseline justify-between gap-1">
              <strong className="text-[13px] text-ink">{a.equipment || "장비 확인 필요"}</strong>
              <span className={`text-[12px] font-bold ${a.severity === "conflict" ? "text-attention-fg" : "text-warn-fg"}`}>{a.severity === "conflict" ? `🔴 ${a.overBy}개 부족` : `⚠️ ${a.reason || "확인 필요"}`}</span>
            </div>
            <p className="mt-1 text-[11.5px] text-ink-mute">{when(a.start)}{a.end ? ` ~ ${when(a.end)}` : ""}{a.stock != null ? ` · 가용 ${a.stock} / 필요 ${a.booked}` : ""}</p>
            {!!a.component && <p className="mt-1 text-[12px] text-warn-fg">구성품: {a.component}</p>}
            {!!a.candidates?.length && <p className="mt-1 text-[12px] text-warn-fg">장비명 후보: {a.candidates.join(" / ")}</p>}
            <div className="mt-1.5 space-y-1">
              {(a.bookings || []).map((b, j) => (
                <p key={`${b.tid}-${j}`} className="text-[11.5px] text-ink-soft">
                  {b.tid ? <a className="font-bold underline decoration-dotted underline-offset-2" href={`/?tid=${encodeURIComponent(b.tid)}`}>{b.customer || b.tid}</a> : b.customer || "예약자 확인 필요"}
                  {` · ${b.qty ?? "?"}개 · ${when(b.from)} ~ ${when(b.to)}`}
                  {b.name && b.name !== a.equipment && <span className="block text-ink-mute">등록명: {b.name}</span>}
                </p>
              ))}
            </div>
          </article>
        ))}
      </div>
      {filtered.length > limit && <button onClick={() => setLimit(n => n + 20)} className="w-full bg-paper py-3 text-[13px] font-bold text-ink-soft">20건 더 보기 · 남은 {filtered.length - limit}건</button>}
    </section>
  );
}
