"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Trade } from "@/lib/domain/types";
import type { GroupMode, TLItem } from "@/lib/domain/timeline";
import { DAY, computeConflicts, dateOnlyMs, daysBetween, groupItems, revenueByDay, statusBar } from "@/lib/domain/timeline";
import { removeItem, resizeEquipment, shiftEquipmentDates } from "@/lib/data/store";
import { parseYmd, timeLabel } from "@/lib/domain/status";
import { ChevronRight, Doc, Plus } from "./icons";

const ROW_H = 40;
const BAR_H = 28;
const HEAD_H = 52;
const REV_H = 50;
const WEEKDAY = ["일", "월", "화", "수", "목", "금", "토"];

export function VillageTimeline({
  items,
  trades,
  mode,
  search,
  today,
  filterStart,
  filterEnd,
}: {
  items: TLItem[];
  trades: Trade[];
  mode: GroupMode;
  search: string;
  today: string;
  filterStart?: string;
  filterEnd?: string;
}) {
  const [colW, setColW] = useState(120);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [sel, setSel] = useState<TLItem | null>(null);
  const [menu, setMenu] = useState<{ item: TLItem; x: number; y: number; mobile: boolean } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const router = useRouter();

  // 표시 범위: 필터 있으면 그 범위, 없으면 오늘 기준 3주만 보여준다.
  const { rangeStartMs, rangeEndMs, days } = useMemo(() => {
    const t = dateOnlyMs(today + "T00:00:00");
    if (filterStart && filterEnd) {
      const s = parseYmd(filterStart).getTime();
      const e = parseYmd(filterEnd).getTime();
      return { rangeStartMs: s, rangeEndMs: e, days: Math.max(1, daysBetween(s, e) + 1) };
    }
    const s = t - 7 * DAY;
    const e = t + 14 * DAY;
    return { rangeStartMs: s, rangeEndMs: e, days: daysBetween(s, e) + 1 };
  }, [today, filterStart, filterEnd]);

  const visibleItems = useMemo(() => items.filter((it) => it.endMs >= rangeStartMs && it.startMs <= rangeEndMs), [items, rangeStartMs, rangeEndMs]);
  const groups = useMemo(() => groupItems(visibleItems, mode, search), [visibleItems, mode, search]);
  const conflicts = useMemo(() => computeConflicts(visibleItems), [visibleItems]);

  const todayMs = dateOnlyMs(today + "T00:00:00");
  const todayOff = daysBetween(rangeStartMs, todayMs);
  const scrollOff = Math.min(days - 1, Math.max(0, todayOff));
  const totalW = days * colW;
  const dates = useMemo(() => Array.from({ length: days }, (_, i) => rangeStartMs + i * DAY), [rangeStartMs, days]);
  const revenue = useMemo(() => revenueByDay(trades, rangeStartMs, days), [trades, rangeStartMs, days]);
  const maxRev = Math.max(1, ...revenue);

  const scrollToToday = () => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ left: scrollOff * colW - el.clientWidth / 2 + colW / 2, behavior: "smooth" });
  };
  const didScroll = useRef(false);
  useEffect(() => {
    const el = scrollRef.current;
    if (el && !didScroll.current && totalW > 0) {
      el.scrollLeft = scrollOff * colW - el.clientWidth / 2 + colW / 2;
      didScroll.current = true;
    }
  }, [scrollOff, colW, totalW]);

  // Ctrl/⌘ + 휠 줌
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const mouseX = e.clientX - rect.left + el.scrollLeft;
      setColW((prev) => {
        const next = Math.min(220, Math.max(44, Math.round(prev * (e.deltaY < 0 ? 1.12 : 1 / 1.12))));
        const ratio = next / prev;
        requestAnimationFrame(() => {
          if (scrollRef.current) scrollRef.current.scrollLeft = mouseX * ratio - (e.clientX - rect.left);
        });
        return next;
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const openMenu = (item: TLItem, x: number, y: number) =>
    setMenu({ item, x, y, mobile: typeof window !== "undefined" && window.innerWidth < 640 });

  // ── 이동 드래그 (관성) ──────────────────────────────────────────
  const drag = useRef<{ el: HTMLElement; sx: number; sy: number; tx: number; ty: number; cx: number; cy: number; raf: number; moved: boolean; lp: number; lpFired: boolean } | null>(null);
  const resetEl = (el: HTMLElement) => {
    el.style.transition = "";
    el.style.transform = "";
    el.style.zIndex = "";
    el.style.cursor = "";
  };
  const loop = () => {
    const d = drag.current;
    if (!d) return;
    d.cx += (d.tx - d.cx) * 0.3;
    d.cy += (d.ty - d.cy) * 0.3;
    d.el.style.transform = `translate3d(${d.cx}px,${d.cy}px,0)`;
    d.raf = requestAnimationFrame(loop);
  };
  const onDown = (e: React.PointerEvent, it: TLItem) => {
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    el.style.transition = "none";
    el.style.zIndex = "40";
    el.style.cursor = "grabbing";
    const sx = e.clientX;
    const sy = e.clientY;
    const lp = window.setTimeout(() => {
      const d = drag.current;
      if (!d || d.moved) return;
      d.lpFired = true;
      cancelAnimationFrame(d.raf);
      resetEl(d.el);
      openMenu(it, sx, sy);
    }, 500);
    drag.current = { el, sx, sy, tx: 0, ty: 0, cx: 0, cy: 0, raf: requestAnimationFrame(loop), moved: false, lp, lpFired: false };
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.lpFired) return;
    d.tx = e.clientX - d.sx;
    d.ty = e.clientY - d.sy;
    if (Math.abs(d.tx) > 4 || Math.abs(d.ty) > 4) {
      d.moved = true;
      clearTimeout(d.lp);
    }
  };
  const onUp = (it: TLItem) => {
    const d = drag.current;
    if (!d) return;
    clearTimeout(d.lp);
    if (d.lpFired) {
      drag.current = null;
      return;
    }
    cancelAnimationFrame(d.raf);
    const el = d.el;
    if (!d.moved) {
      resetEl(el);
      drag.current = null;
      setSel(it);
      return;
    }
    const dayShift = Math.round(d.tx / colW);
    el.style.transition = "transform 0.14s ease-out";
    el.style.transform = `translate3d(${dayShift * colW}px,0,0)`;
    drag.current = null;
    window.setTimeout(() => {
      resetEl(el);
      if (dayShift) shiftEquipmentDates(it.tradeId, it.scheduleId, dayShift);
    }, 150);
  };
  const onCtx = (e: React.MouseEvent, it: TLItem) => {
    e.preventDefault();
    const d = drag.current;
    if (d) {
      clearTimeout(d.lp);
      cancelAnimationFrame(d.raf);
      resetEl(d.el);
      drag.current = null;
    }
    openMenu(it, e.clientX, e.clientY);
  };

  // ── 리사이즈 (관성 없음, document 리스너) ──────────────────────
  const rsDown = (e: React.PointerEvent, it: TLItem, edge: "start" | "end") => {
    e.stopPropagation();
    e.preventDefault();
    const bar = (e.currentTarget as HTMLElement).parentElement as HTMLElement;
    const sx = e.clientX;
    const baseLeft = bar.offsetLeft;
    const baseWidth = bar.offsetWidth;
    const min = colW - 4;
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - sx;
      if (edge === "end") {
        bar.style.width = Math.max(min, baseWidth + dx) + "px";
      } else {
        const w = Math.max(min, baseWidth - dx);
        bar.style.left = baseLeft + (baseWidth - w) + "px";
        bar.style.width = w + "px";
      }
    };
    const up = (ev: PointerEvent) => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      const dayShift = Math.round((ev.clientX - sx) / colW);
      if (dayShift) resizeEquipment(it.tradeId, it.scheduleId, edge, dayShift);
      else {
        bar.style.left = "";
        bar.style.width = "";
      }
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
  };

  const runMenu = (action: "addEquip" | "deleteEquip" | "contract", it: TLItem) => {
    setMenu(null);
    if (action === "contract") {
      if (it.contractUrl) window.open(it.contractUrl, "_blank", "noopener");
      return;
    }
    if (action === "addEquip") {
      router.push(`/?tid=${it.tradeId}`);
      return;
    }
    if (action === "deleteEquip" && confirm(`${it.label} 을(를) 이 거래에서 삭제할까요?`)) removeItem(it.tradeId, it.scheduleId);
  };

  const gridBg = `repeating-linear-gradient(to right, transparent 0 ${colW - 1}px, rgba(0,0,0,0.05) ${colW - 1}px ${colW}px), repeating-linear-gradient(to bottom, transparent 0 ${ROW_H - 1}px, rgba(0,0,0,0.04) ${ROW_H - 1}px ${ROW_H}px)`;

  const rows: React.ReactNode[] = [];
  for (const g of groups) {
    const isCol = collapsed[g.key];
    rows.push(
      <div key={"g_" + g.key} className="relative flex items-center" style={{ height: ROW_H, width: totalW }}>
        <button onClick={() => setCollapsed((c) => ({ ...c, [g.key]: !c[g.key] }))} className="tap sticky left-0 z-10 flex h-full items-center gap-1.5 bg-white/95 pl-3 pr-4 backdrop-blur">
          <ChevronRight className={`h-3.5 w-3.5 text-ink-mute transition-transform ${isCol ? "" : "rotate-90"}`} />
          <span className="text-[13px] font-bold text-ink">{g.key}</span>
          <span className="rounded-full bg-black/[0.05] px-1.5 text-[11px] font-semibold text-ink-mute">{g.items.length}</span>
        </button>
      </div>,
    );
    if (isCol) continue;
    for (const it of g.items) {
      const s = Math.max(0, daysBetween(rangeStartMs, it.startMs));
      const e2 = Math.min(days - 1, daysBetween(rangeStartMs, it.endMs));
      const span = Math.max(1, e2 - s + 1);
      const clipL = it.startMs < rangeStartMs;
      const clipR = it.endMs > rangeEndMs;
      const sc = statusBar(it.statusKey);
      const conf = conflicts.has(it.id);
      rows.push(
        <div key={it.id} className="relative" style={{ height: ROW_H, width: totalW }}>
          <button
            onPointerDown={(ev) => onDown(ev, it)}
            onPointerMove={onMove}
            onPointerUp={() => onUp(it)}
            onContextMenu={(ev) => onCtx(ev, it)}
            className={`tl-bar group absolute flex items-center gap-1 overflow-hidden rounded-[5px] px-2 text-[11px] font-semibold shadow-sm ${sc.bar} ${sc.strike ? "line-through" : ""} ${conf ? "conflict" : ""}`}
            style={{ left: s * colW + 2, width: span * colW - 4, top: 6, height: BAR_H, touchAction: "none", cursor: "grab" }}
            title={`${it.label} · ${it.custName}`}
          >
            {!clipL && (
              <span onPointerDown={(ev) => rsDown(ev, it, "start")} className="absolute left-0 top-0 z-10 h-full w-2 cursor-col-resize bg-black/10 opacity-0 group-hover:opacity-100" style={{ touchAction: "none" }} />
            )}
            {clipL && <span className="shrink-0">◀</span>}
            <span className="truncate">
              {it.label} · {it.custName}
              {it.qty > 1 ? ` ×${it.qty}` : ""}
            </span>
            {clipR && <span className="ml-auto shrink-0">▶</span>}
            {!clipR && (
              <span onPointerDown={(ev) => rsDown(ev, it, "end")} className="absolute right-0 top-0 z-10 h-full w-2 cursor-col-resize bg-black/10 opacity-0 group-hover:opacity-100" style={{ touchAction: "none" }} />
            )}
          </button>
        </div>,
      );
    }
  }

  return (
    <div className="relative overflow-hidden rounded-xl2 bg-white shadow-card ring-1 ring-black/5">
      <div ref={scrollRef} className="overflow-auto" style={{ maxHeight: "calc(100vh - 190px)" }}>
        <div style={{ width: totalW, position: "relative" }}>
          {/* 날짜 헤더 */}
          <div className="sticky top-0 z-30 flex border-b border-black/10 bg-white/95 backdrop-blur" style={{ height: HEAD_H }}>
            {dates.map((ms, i) => {
              const dt = new Date(ms);
              const dow = dt.getDay();
              const isToday = ms === todayMs;
              const weekend = dow === 0 || dow === 6;
              return (
                <div key={ms} style={{ width: colW }} className={`flex shrink-0 flex-col items-center justify-center ${isToday ? "bg-brand-50" : weekend ? "bg-black/[0.015]" : ""}`}>
                  {(dt.getDate() === 1 || i === 0) && <span className="text-[9.5px] font-bold text-ink-faint">{dt.getMonth() + 1}월</span>}
                  <span className={`text-[13px] font-bold ${isToday ? "text-brand-600" : dow === 0 ? "text-attention-fg" : dow === 6 ? "text-checkout-fg" : "text-ink"}`}>{dt.getDate()}</span>
                  {colW >= 60 && <span className="text-[9.5px] text-ink-faint">{WEEKDAY[dow]}</span>}
                </div>
              );
            })}
          </div>

          {/* 본문 */}
          <div className="relative">
            <div className="absolute inset-0" style={{ backgroundImage: gridBg }} />
            {dates.map((ms, i) => {
              const dow = new Date(ms).getDay();
              const isToday = ms === todayMs;
              if (!isToday && dow !== 0 && dow !== 6) return null;
              return <div key={ms} className={`absolute top-0 bottom-0 ${isToday ? "bg-brand-50/60" : "bg-black/[0.012]"}`} style={{ left: i * colW, width: colW }} />;
            })}
            {todayOff >= 0 && todayOff < days && (
              <div className="absolute top-0 bottom-0 z-20" style={{ left: todayOff * colW + Math.round(colW / 2) - 1, width: 2, background: "#d2440f" }}>
                <span className="absolute left-1/2 -translate-x-1/2 rounded-b bg-brand-600 px-1 text-[9px] font-bold text-white">오늘</span>
              </div>
            )}
            <div className="relative z-10">{rows.length ? rows : <div className="py-16 text-center text-[14px] text-ink-faint">예약이 없어요</div>}</div>
          </div>

          {/* 매출바 (모바일 숨김) */}
          <div className="sticky bottom-0 z-20 hidden border-t border-black/10 bg-white/95 backdrop-blur sm:block" style={{ height: REV_H }}>
            <div className="relative h-full">
              {revenue.map((r, i) =>
                r > 0 ? (
                  <div
                    key={i}
                    title={`${Math.round(r).toLocaleString("ko-KR")}원`}
                    className="absolute bottom-1 rounded-sm bg-brand-500/30 transition-colors hover:bg-brand-500/60"
                    style={{ left: i * colW + colW * 0.2, width: colW * 0.6, height: Math.max(2, (r / maxRev) * (REV_H - 14)) }}
                  />
                ) : null,
              )}
              <span className="sticky left-0 inline-block px-2 pt-1 text-[10px] font-bold text-ink-faint">일 매출</span>
            </div>
          </div>
        </div>
      </div>

      {/* 컨트롤 (오늘 + 줌) */}
      <div className="absolute bottom-3 right-3 z-40 flex items-center gap-1 rounded-xl bg-white/95 p-1 shadow-pop ring-1 ring-black/10 backdrop-blur">
        <button onClick={scrollToToday} className="tap mr-1 rounded-lg px-2.5 py-1 text-[12px] font-bold text-brand-700">오늘</button>
        <button onClick={() => setColW((w) => Math.max(44, Math.round(w / 1.3)))} className="tap flex h-8 w-8 items-center justify-center rounded-lg text-[18px] font-bold text-ink-soft">−</button>
        <button onClick={() => setColW((w) => Math.min(220, Math.round(w * 1.3)))} className="tap flex h-8 w-8 items-center justify-center rounded-lg text-[18px] font-bold text-ink-soft">＋</button>
      </div>

      {sel && <BarSheet it={sel} onClose={() => setSel(null)} />}

      {menu && (
        <>
          <div className="fixed inset-0 z-50" onClick={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null); }} />
          <div
            className={`fixed z-50 overflow-hidden bg-white shadow-pop ring-1 ring-black/10 ${menu.mobile ? "inset-x-0 bottom-0 rounded-t-2xl pb-[env(safe-area-inset-bottom)]" : "w-56 rounded-xl"}`}
            style={menu.mobile ? undefined : { left: Math.min(menu.x, (typeof window !== "undefined" ? window.innerWidth : 9999) - 232), top: menu.y }}
          >
            <MenuItem onClick={() => runMenu("addEquip", menu.item)}>
              <Plus className="h-4 w-4" /> 이 예약에 장비 추가
            </MenuItem>
            <MenuItem danger onClick={() => runMenu("deleteEquip", menu.item)}>
              <span className="text-[15px] leading-none">🗑</span> 이 장비 삭제
            </MenuItem>
            <MenuItem onClick={() => runMenu("contract", menu.item)}>
              <Doc className="h-4 w-4" /> 계약서 열기
            </MenuItem>
          </div>
        </>
      )}
    </div>
  );
}

function MenuItem({ children, onClick, danger }: { children: React.ReactNode; onClick: () => void; danger?: boolean }) {
  return (
    <button onClick={onClick} className={`tap flex w-full items-center gap-2.5 px-4 py-3 text-left text-[14px] font-semibold active:bg-black/[0.04] ${danger ? "text-attention-fg" : "text-ink"}`}>
      {children}
    </button>
  );
}

function BarSheet({ it, onClose }: { it: TLItem; onClose: () => void }) {
  const co = new Date(it.checkoutAt);
  const ro = new Date(it.returnAt);
  const fmt = (d: Date, iso: string) => `${d.getMonth() + 1}/${d.getDate()} ${timeLabel(iso)}`;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center" onClick={onClose}>
      <div className="animate-pop w-full max-w-md rounded-t-2xl bg-white p-5 shadow-pop sm:rounded-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2">
          <span className="text-[16px] font-extrabold text-ink">{it.label}</span>
          {it.qty > 1 && <span className="rounded-md bg-warn-bg px-1.5 py-0.5 text-[12px] font-bold text-warn-fg">×{it.qty}</span>}
        </div>
        <div className="mt-2 space-y-1 text-[13.5px] text-ink-soft">
          <div>
            <span className="text-ink-mute">예약자</span> <span className="font-bold text-ink">{it.custName}</span> · {it.tradeId}
          </div>
          <div>
            <span className="text-ink-mute">반출</span> {fmt(co, it.checkoutAt)}
          </div>
          <div>
            <span className="text-ink-mute">반납</span> {fmt(ro, it.returnAt)}
          </div>
          <div>
            <span className="text-ink-mute">상태</span> {it.status}
          </div>
        </div>
        <div className="mt-4 flex gap-2">
          <button onClick={onClose} className="tap flex-1 rounded-xl bg-black/[0.05] py-3 text-[14px] font-bold text-ink-soft">닫기</button>
          <Link href={`/?tid=${it.tradeId}`} className="tap flex-1 rounded-xl bg-brand-600 py-3 text-center text-[14px] font-bold text-white shadow-sm">
            이 거래 보기
          </Link>
        </div>
      </div>
    </div>
  );
}
