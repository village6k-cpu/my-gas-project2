"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { supabase } from "@/lib/supabase/client";
import { normalizeStockName } from "@/lib/data/equipmentStock";
import { ymd, addDays } from "@/lib/domain/status";
import { ChevronLeft, Phone } from "@/components/icons";

// 마감 조종석 — "오늘 정리 + 내일 준비"를 퇴근 전 한 화면에.
// 사장님 규칙 그대로: 반납 특이사항은 그날 밤 안에 '누가·무엇이·몇 개'로 보고.
// 내일 반출은 오늘 밤에 꺼내놓는다 — 아침 러시 포장 실수(플레이트 누락류)의 뿌리를 자른다.
// 읽기 전용 + 보고문 클립보드 복사만.

type ItemRow = {
  schedule_id: string;
  trade_id: string;
  name: string;
  qty: number;
  taken_qty: number | null;
  actual_name: string | null;
  actual_taken_qty: number | null;
  set_name: string | null;
  is_set_header: boolean;
  is_component: boolean;
  memo_checkout: string | null;
  memo_checkin: string | null;
  checkout_state: string | null;
};

type RiskWarning = { phase?: string; riskLevel?: string; equipmentName?: string; customerMessage?: string };

type TradeRow = {
  trade_id: string;
  customer_name: string | null;
  customer_phone: string | null;
  checkout_at: string | null;
  return_at: string | null;
  contract_status: string | null;
  setup_done: boolean | null;
  return_done: boolean | null;
  return_done_at: string | null;
  payment_warning: boolean | null;
  risk_warnings: RiskWarning[] | null;
  return_counts: Record<string, { good?: number; damaged?: number; lost?: number; memo?: string }> | null;
};

type LedgerRow = { name: string; aliases: string[]; stock_total: number | null; stock_maint: number; state: string };

type Incident = { customer: string; item: string; damaged: number; lost: number; memo: string | null };

function hhmm(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
function isOn(iso: string | null, day: string): boolean {
  return !!iso && ymd(new Date(iso)) === day;
}

export function ClosingView({ onClose }: { onClose: () => void }) {
  // 마운트 시각으로 고정 — 자정을 넘겨 열어둬도 데이터(마운트 1회 로드)와 표시 날짜가 어긋나지 않게
  const [today] = useState(() => ymd(new Date()));
  const tomorrow = useMemo(() => addDays(today, 1), [today]);
  const [trades, setTrades] = useState<TradeRow[] | null | "failed">(null);
  const [items, setItems] = useState<ItemRow[]>([]);
  const [ledger, setLedger] = useState<LedgerRow[]>([]);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = ""; };
  }, []);

  useEffect(() => {
    let dead = false;
    const sb = supabase;
    if (!sb) { setTrades("failed"); return; }
    (async () => {
      try {
        // 오늘~내일 반출 + 오늘 반납창 + 미반납(2주) + 현재 나가있는 진행 대여(재고 계산용) — 마감에 필요한 거래만.
        // activeOut이 핵심: 어제 나가 모레 반납 예정인 장기 대여는 위 세 창 어디에도 안 걸려서,
        // 없으면 그 팀이 든 장비를 '선반에 있다'고 오판 → 내일 재고 충돌을 놓친다.
        const [byCheckout, byReturn, overdue, activeOut, led] = await Promise.all([
          sb.from("trades").select("*").gte("checkout_at", `${today}T00:00:00+09:00`).lt("checkout_at", `${addDays(tomorrow, 1)}T00:00:00+09:00`),
          sb.from("trades").select("*").gte("return_at", `${today}T00:00:00+09:00`).lt("return_at", `${tomorrow}T00:00:00+09:00`),
          sb.from("trades").select("*").eq("return_done", false).lt("return_at", `${today}T00:00:00+09:00`).gte("return_at", `${addDays(today, -14)}T00:00:00+09:00`),
          sb.from("trades").select("*").eq("return_done", false).eq("contract_status", "반출").limit(500),
          sb.from("equipment_ledger").select("name,aliases,stock_total,stock_maint,state").limit(1000),
        ]);
        const err = [byCheckout, byReturn, overdue, activeOut, led].find((r) => r.error)?.error;
        if (err) throw err;
        const map = new Map<string, TradeRow>();
        for (const t of [...(byCheckout.data || []), ...(byReturn.data || []), ...(overdue.data || []), ...(activeOut.data || [])] as TradeRow[]) map.set(t.trade_id, t);
        const all = [...map.values()].filter((t) => t.contract_status !== "취소");
        const ids = all.map((t) => t.trade_id);
        let rows: ItemRow[] = [];
        for (let i = 0; i < ids.length; i += 60) {
          const { data, error } = await sb
            .from("schedule_items")
            .select("schedule_id,trade_id,name,qty,taken_qty,actual_name,actual_taken_qty,set_name,is_set_header,is_component,memo_checkout,memo_checkin,checkout_state")
            .in("trade_id", ids.slice(i, i + 60));
          if (error) throw error;
          rows = rows.concat((data as ItemRow[]) || []);
        }
        if (!dead) {
          setTrades(all);
          setItems(rows.filter((r) => r.checkout_state !== "excluded"));
          setLedger(((led.data as LedgerRow[]) || []).filter((l) => l.state !== "보관종료"));
        }
      } catch (e) {
        console.error("[closing] 마감 데이터 로드 실패", e);
        if (!dead) setTrades("failed");
      }
    })();
    return () => { dead = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const view = useMemo(() => {
    if (!trades || trades === "failed") return null;
    const itemsBy = new Map<string, ItemRow[]>();
    for (const i of items) {
      if (!itemsBy.has(i.trade_id)) itemsBy.set(i.trade_id, []);
      itemsBy.get(i.trade_id)!.push(i);
    }

    const returnedToday = trades.filter((t) => t.return_done && isOn(t.return_done_at || t.return_at, today));
    const dueTodayOpen = trades.filter((t) => !t.return_done && isOn(t.return_at, today));
    const overdue = trades.filter((t) => !t.return_done && t.return_at && ymd(new Date(t.return_at)) < today);
    const outToday = trades.filter((t) => isOn(t.checkout_at, today) && (t.setup_done || t.contract_status === "반출"));
    const tomorrowOut = trades
      .filter((t) => isOn(t.checkout_at, tomorrow))
      .sort((a, b) => (a.checkout_at || "").localeCompare(b.checkout_at || ""));

    // 오늘 반납 검수에서 나온 특이사항 — '누가·무엇이·몇 개'
    const incidents: Incident[] = [];
    for (const t of returnedToday) {
      const mine = itemsBy.get(t.trade_id) || [];
      for (const i of mine) {
        const rc = t.return_counts?.[i.schedule_id];
        if (!rc) continue;
        if ((rc.damaged || 0) > 0 || (rc.lost || 0) > 0 || rc.memo) {
          incidents.push({ customer: t.customer_name || "?", item: i.actual_name || i.name, damaged: rc.damaged || 0, lost: rc.lost || 0, memo: rc.memo || i.memo_checkin || null });
        }
      }
    }

    // 내일 필요한 장비 vs 지금 선반 — '지금 매장에 없는' 수량 경고 (판단은 사람이)
    const ledgerByKey = new Map<string, LedgerRow>();
    for (const l of ledger) {
      ledgerByKey.set(normalizeStockName(l.name), l);
      for (const a of l.aliases || []) ledgerByKey.set(normalizeStockName(a), l);
    }
    const need = new Map<string, number>();
    for (const t of tomorrowOut) {
      for (const i of itemsBy.get(t.trade_id) || []) {
        if (i.is_set_header && (itemsBy.get(t.trade_id) || []).some((x) => x.set_name === i.name && !x.is_set_header)) continue;
        const actualName = i.actual_name || i.name;
        const actualQty = i.actual_taken_qty ?? i.qty;
        if (actualQty > 0) need.set(actualName, (need.get(actualName) || 0) + actualQty);
      }
    }
    const stillOut = new Map<string, { qty: number; who: string[] }>();
    for (const t of trades) {
      if (t.return_done || !(t.setup_done || t.contract_status === "반출")) continue;
      // 내일 이후 반출 예약분은 미리 세팅됐어도 아직 선반에 있다 — 재고에서 빼면 이중 차감
      if (t.checkout_at && ymd(new Date(t.checkout_at)) > today) continue;
      const mine = itemsBy.get(t.trade_id) || [];
      for (const i of mine) {
        // need와 대칭 — 구성품이 따로 있는 세트 헤더는 물리 장비가 아니라 컨테이너
        if (i.is_set_header && mine.some((x) => x.set_name === i.name && !x.is_set_header)) continue;
        const actualName = i.actual_name || i.name;
        const actualQty = i.actual_taken_qty ?? i.taken_qty ?? i.qty;
        if (actualQty <= 0) continue;
        const key = normalizeStockName(actualName);
        const cur = stillOut.get(key) || { qty: 0, who: [] };
        cur.qty += actualQty;
        const label = `${t.customer_name || "?"}(${t.return_at ? hhmm(t.return_at) + " 반납예정" : "반납일 미상"})`;
        if (!cur.who.includes(label)) cur.who.push(label);
        stillOut.set(key, cur);
      }
    }
    const conflicts: { name: string; need: number; shelf: number | null; out: { qty: number; who: string[] } | null }[] = [];
    for (const [name, n] of need) {
      const key = normalizeStockName(name);
      const l = ledgerByKey.get(key);
      const out = stillOut.get(key) || null;
      if (l?.stock_total == null) continue; // 보유 미기록 — 판단 불가라 경고 안 함
      const shelf = l.stock_total - (l.stock_maint || 0) - (out?.qty || 0);
      if (shelf < n) conflicts.push({ name, need: n, shelf: Math.max(0, shelf), out });
    }

    return { returnedToday, dueTodayOpen, overdue, outToday, tomorrowOut, incidents, conflicts, itemsBy };
  }, [trades, items, ledger, today, tomorrow]);

  // 보고문은 5년치 실제 마감 보고 관습을 따른다:
  // 보고체(~했습니다) · 감독 이름 단위 특이사항 · "이외 특이사항 없습니다" 명시
  const report = useMemo(() => {
    if (!view) return "";
    const L: string[] = [`[마감 보고] ${today}`];
    L.push(`오늘 반납 ${view.returnedToday.length}건 정리했습니다.`);
    if (view.incidents.length) {
      L.push("", "특이사항:");
      for (const i of view.incidents) {
        const parts = [i.damaged > 0 ? `파손 ${i.damaged}` : "", i.lost > 0 ? `분실 ${i.lost}` : ""].filter(Boolean).join(", ");
        L.push(`- ${i.customer} 감독: ${i.item}${parts ? ` — ${parts}` : ""}${i.memo ? ` (${i.memo})` : ""}`);
      }
    }
    if (view.dueTodayOpen.length || view.overdue.length) {
      L.push("", "미반납:");
      for (const t of [...view.dueTodayOpen, ...view.overdue]) {
        L.push(`- ${t.customer_name || "?"} 감독 (${t.trade_id}) — ${t.return_at ? `${ymd(new Date(t.return_at))} ${hhmm(t.return_at)} 반납 예정` : "반납일 미상"}`);
      }
    }
    if (view.tomorrowOut.length) {
      L.push("", `내일 반출 ${view.tomorrowOut.length}건 준비했습니다:`);
      for (const t of view.tomorrowOut) L.push(`- ${hhmm(t.checkout_at)} ${t.customer_name || "?"} 감독`);
    }
    if (view.conflicts.length) {
      L.push("", "재고 확인 필요:");
      for (const c of view.conflicts) L.push(`- ${c.name}: 내일 ${c.need}개 필요한데 매장에 ${c.shelf}개${c.out ? ` (미반납 — ${c.out.who.join(", ")})` : ""}`);
    }
    if (!view.incidents.length && !view.conflicts.length) L.push("", "이외 특이사항 없습니다.");
    else L.push("", "이상입니다.");
    return L.join("\n");
  }, [view, today]);

  const [copyFail, setCopyFail] = useState(false);
  const copyReport = async () => {
    let ok = false;
    try {
      await navigator.clipboard.writeText(report);
      ok = true;
    } catch {
      try {
        const ta = document.createElement("textarea");
        ta.value = report; document.body.appendChild(ta); ta.select();
        ok = document.execCommand("copy"); ta.remove();
      } catch { ok = false; }
    }
    if (ok) { setCopied(true); window.setTimeout(() => setCopied(false), 2000); }
    else { setCopyFail(true); window.setTimeout(() => setCopyFail(false), 3000); }
  };

  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="fixed inset-0 z-50 overflow-y-auto bg-paper">
      <div className="mx-auto max-w-2xl px-4 pb-24 pt-3">
        <button onClick={onClose} className="tap mb-2 flex items-center gap-1 rounded-full py-1 pr-3 text-[13px] font-bold text-ink-mute">
          <ChevronLeft className="h-4 w-4" /> 닫기
        </button>

        <div className="flex items-baseline justify-between">
          <h2 className="text-[20px] font-extrabold text-ink">마감 <span className="text-[13px] font-bold text-ink-mute">{today}</span></h2>
        </div>
        <p className="mt-0.5 text-[12px] text-ink-mute">오늘 정리하고, 내일 꺼내놓고 퇴근 — 특이사항은 그날 밤에 보고.</p>

        {trades === "failed" && <p className="mt-6 rounded-xl bg-warn-bg p-3 text-[12.5px] font-semibold text-warn-fg ring-1 ring-warn-ring">마감 데이터를 불러오지 못했어요 — 새로고침 후 다시 열어주세요.</p>}
        {!view && trades !== "failed" && <p className="mt-6 text-center text-[13px] font-bold text-ink-faint">오늘 하루 모으는 중...</p>}

        {view && (
          <>
            {/* 오늘 요약 */}
            <div className="mt-3 grid grid-cols-4 gap-1.5 text-center">
              <Num label="반납 완료" v={view.returnedToday.length} />
              <Num label="미반납" v={view.dueTodayOpen.length + view.overdue.length} warn={view.dueTodayOpen.length + view.overdue.length > 0} />
              <Num label="오늘 반출" v={view.outToday.length} />
              <Num label="내일 반출" v={view.tomorrowOut.length} />
            </div>

            {/* 특이사항 — 누가·무엇이·몇 개. 사장님 규칙(2025-06 카톡): "모든 특이사항 무조건 전부 남기세요, 아주 작은 사소한 거라도" */}
            <Section title={`오늘 특이사항 ${view.incidents.length ? view.incidents.length + "건" : "— 없음 ✨"}`}>
              {view.incidents.length > 0 && (
                <ul className="space-y-1.5">
                  {view.incidents.map((i, k) => (
                    <li key={k} className="rounded-xl bg-attention-fg/10 px-3 py-2 text-[13px] leading-snug ring-1 ring-attention-fg/30">
                      <b>{i.customer}</b> / {i.item}
                      {i.damaged > 0 && <b className="ml-1 text-attention-fg">파손 {i.damaged}</b>}
                      {i.lost > 0 && <b className="ml-1 text-attention-fg">분실 {i.lost}</b>}
                      {i.memo && <div className="mt-0.5 text-[12px] text-ink-soft">{i.memo}</div>}
                    </li>
                  ))}
                </ul>
              )}
            </Section>

            {/* 미반납 */}
            {(view.dueTodayOpen.length > 0 || view.overdue.length > 0) && (
              <Section title={`미반납 ${view.dueTodayOpen.length + view.overdue.length}건 — 퇴근 전 연락`}>
                <ul className="divide-y divide-line/60 overflow-hidden rounded-xl bg-white ring-1 ring-line">
                  {[...view.dueTodayOpen, ...view.overdue].map((t) => (
                    <li key={t.trade_id} className="flex items-center justify-between gap-2 px-3 py-2 text-[13px]">
                      <span className="min-w-0">
                        <b className="text-ink">{t.customer_name || "?"}</b>
                        <span className="ml-1.5 text-[11.5px] text-ink-faint">{t.trade_id}</span>
                        <span className="ml-1.5 text-[12px] text-attention-fg">
                          {t.return_at && ymd(new Date(t.return_at)) < today ? `${ymd(new Date(t.return_at))}부터 지연` : `오늘 ${hhmm(t.return_at)} 예정`}
                        </span>
                      </span>
                      {t.customer_phone && (
                        <a href={`tel:${t.customer_phone.replace(/-/g, "")}`} className="tap flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-paper ring-1 ring-line/60 text-ink-soft">
                          <Phone className="h-3.5 w-3.5" />
                        </a>
                      )}
                    </li>
                  ))}
                </ul>
              </Section>
            )}

            {/* 재고 확인 필요 */}
            {view.conflicts.length > 0 && (
              <Section title={`내일 재고 확인 필요 ${view.conflicts.length}건`}>
                <ul className="space-y-1.5">
                  {view.conflicts.map((c) => (
                    <li key={c.name} className="rounded-xl bg-warn-bg px-3 py-2 text-[13px] leading-snug ring-1 ring-warn-ring">
                      <b className="text-warn-fg">{c.name}</b> — 내일 {c.need}개 필요한데 지금 매장에 {c.shelf}개
                      {c.out && c.out.qty > 0 && <div className="mt-0.5 text-[12px] text-ink-soft">미반납 {c.out.qty}개: {c.out.who.join(", ")}</div>}
                      <div className="mt-0.5 text-[10.5px] text-ink-faint">원장 보유수 기준 추정 — 실물 확인 후 판단하세요.</div>
                    </li>
                  ))}
                </ul>
              </Section>
            )}

            {/* 내일 반출 준비 */}
            <Section title={view.tomorrowOut.length ? `내일 반출 준비 ${view.tomorrowOut.length}건 — 오늘 밤에 꺼내놓기` : "내일 반출"}>
              {view.tomorrowOut.length === 0 && <p className="rounded-xl bg-white p-3 text-[12.5px] text-ink-mute ring-1 ring-line">내일 반출 예약이 없어요.</p>}
              <div className="space-y-2">
                {view.tomorrowOut.map((t) => {
                  const mine = (view.itemsBy.get(t.trade_id) || []);
                  const warns = (t.risk_warnings || []).filter((w) => w.phase === "checkout");
                  return (
                    <div key={t.trade_id} className="rounded-xl bg-white p-3 shadow-card ring-1 ring-line">
                      <div className="flex items-baseline justify-between">
                        <span className="text-[14px] font-extrabold text-ink">{hhmm(t.checkout_at)} <span className="ml-1">{t.customer_name || "?"}</span></span>
                        <span className="text-[11px] font-semibold text-ink-faint">{t.trade_id}</span>
                      </div>
                      <ul className="mt-1.5 space-y-0.5">
                        {mine.map((i) => (
                          <li key={i.schedule_id} className={`flex items-baseline justify-between text-[12.5px] ${i.is_set_header ? "font-extrabold text-brand-700" : i.is_component ? "pl-3 text-ink-soft" : "text-ink"}`}>
                            <span className="min-w-0 truncate">{i.name}{i.memo_checkout ? <span className="ml-1 text-[11px] font-bold text-warn-fg">📝 {i.memo_checkout}</span> : null}</span>
                            <span className="shrink-0 font-bold tabular-nums">×{i.qty}</span>
                          </li>
                        ))}
                      </ul>
                      {warns.length > 0 && (
                        <div className="mt-1.5 space-y-1">
                          {warns.slice(0, 3).map((w, k) => (
                            <div key={k} className="rounded-lg bg-warn-bg px-2 py-1 text-[11.5px] font-semibold leading-snug text-warn-fg ring-1 ring-warn-ring">
                              ⚠ {w.equipmentName}: {w.customerMessage}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </Section>
          </>
        )}
      </div>

      {/* 하단 고정 — 보고 복사 */}
      {view && (
        <div className="safe-bottom fixed bottom-0 left-0 right-0 z-[55] border-t border-line/60 bg-paper/95 p-3 backdrop-blur">
          <button onClick={copyReport} className={`tap mx-auto block w-full max-w-2xl rounded-xl py-3 text-[15px] font-extrabold text-white ${copyFail ? "bg-attention-fg" : "bg-brand-600"}`}>
            {copyFail ? "복사 실패 — 길게 눌러 직접 복사해 주세요" : copied ? "복사됐어요 — 단체방에 붙여넣기 ✓" : "마감 보고 복사 (누가·무엇이·몇 개)"}
          </button>
        </div>
      )}
    </div>,
    document.body,
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-4">
      <h3 className="mb-1.5 text-[12.5px] font-extrabold text-ink-soft">{title}</h3>
      {children}
    </div>
  );
}

function Num({ label, v, warn }: { label: string; v: number; warn?: boolean }) {
  return (
    <div className={`rounded-xl p-2.5 ring-1 ${warn ? "bg-attention-fg/10 ring-attention-fg/30" : "bg-white ring-line"}`}>
      <div className={`text-[18px] font-extrabold tabular-nums ${warn ? "text-attention-fg" : "text-ink"}`}>{v}</div>
      <div className="text-[10.5px] text-ink-faint">{label}</div>
    </div>
  );
}
