"use client";

import { useEffect, useMemo, useState } from "react";
import type { TabKey, Trade } from "@/lib/domain/types";
import { loadDay, useDashboard } from "@/lib/data/store";
import {
  addDays,
  cardDone,
  formatDateLabel,
  needsAttention,
  tabCounts,
  timeBand,
  timeSortKey,
  tradesForTab,
  ymd,
} from "@/lib/domain/status";
import { ScheduleCard } from "@/components/ScheduleCard";
import { AppSwitcher } from "@/components/AppSwitcher";
import { HandoverBoard } from "@/components/HandoverBoard";
import { Toast } from "@/components/Toast";
import { Calendar, Check, ChevronLeft, ChevronRight, Refresh, Search } from "@/components/icons";

const TABS: { key: TabKey; label: string }[] = [
  { key: "checkout", label: "반출" },
  { key: "checkin", label: "반납" },
  { key: "all", label: "전체" },
  { key: "attention", label: "확인필요" },
];

export default function Page() {
  const [date, setDate] = useState("");
  const [tab, setTab] = useState<TabKey>("checkout");
  const [q, setQ] = useState("");
  const [showDone, setShowDone] = useState(false);
  const data = useDashboard();

  // 마운트 시 오늘 날짜 로드 (하이드레이션 안전) + ?tid 로 진입 시 해당 거래 검색
  useEffect(() => {
    const today = ymd(new Date());
    setDate(today);
    loadDay(today);
    const tid = new URLSearchParams(window.location.search).get("tid");
    if (tid) setQ(tid);
  }, []);

  const go = (d: string) => {
    setDate(d);
    loadDay(d);
    setQ("");
  };

  const counts = useMemo(
    () => (data.trades.length ? tabCounts(data.trades, date) : { checkout: 0, checkin: 0, all: 0, attention: 0 }),
    [data.trades, date],
  );

  const searching = q.trim().length > 0;
  const results = useMemo<Trade[]>(() => {
    if (!searching) return [];
    const k = q.trim().toLowerCase();
    return data.trades.filter(
      (t) =>
        t.customerName.toLowerCase().includes(k) ||
        t.customerPhone.replace(/-/g, "").includes(k.replace(/-/g, "")) ||
        t.tradeId.toLowerCase().includes(k) ||
        t.equipments.some((e) => e.name.toLowerCase().includes(k)),
    );
  }, [q, data.trades, searching]);

  const list = useMemo(() => (searching ? results : tradesForTab(data.trades, date, tab)), [searching, results, data.trades, date, tab]);

  // 처리 완료 카드는 아래로 분리 (검색 모드에선 분리 안 함)
  const activeList = useMemo(() => (searching ? list : list.filter((t) => !cardDone(t, date, tab))), [searching, list, date, tab]);
  const doneList = useMemo(
    () =>
      searching
        ? []
        : list.filter((t) => cardDone(t, date, tab)).sort((a, b) => timeSortKey(tab === "checkin" ? a.returnAt : a.checkoutAt) - timeSortKey(tab === "checkin" ? b.returnAt : b.checkoutAt)),
    [searching, list, date, tab],
  );

  // 시간대 그룹핑 (진행 중인 것만)
  const groups = useMemo(() => {
    const byBand: Record<string, Trade[]> = {};
    const keyTime = (t: Trade) => (tab === "checkin" ? t.returnAt : t.checkoutAt);
    for (const t of [...activeList].sort((a, b) => timeSortKey(keyTime(a)) - timeSortKey(keyTime(b)))) {
      const band = timeBand(keyTime(t));
      (byBand[band] ||= []).push(t);
    }
    return Object.entries(byBand);
  }, [activeList, tab]);

  if (!date) {
    return <div className="flex h-screen items-center justify-center text-ink-faint">불러오는 중…</div>;
  }

  const isToday = date === ymd(new Date());

  let cardIndex = -1;

  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col bg-[#f4f5f7]">
      {/* 상단 고정 헤더 */}
      <header className="safe-top sticky top-0 z-30 bg-white/90 backdrop-blur-md ring-1 ring-black/5">
        <div className="flex items-center justify-between px-4 pt-2.5">
          <AppSwitcher active="today" />
          <button onClick={() => go(date)} className="tap flex h-9 w-9 items-center justify-center rounded-full bg-black/[0.04] text-ink-soft">
            <Refresh className="h-4 w-4" />
          </button>
        </div>

        {/* 날짜 내비 */}
        <div className="flex items-center gap-2 px-4 pt-2">
          <button onClick={() => go(addDays(date, -1))} className="tap flex h-9 w-9 items-center justify-center rounded-lg bg-black/[0.04] text-ink-soft">
            <ChevronLeft className="h-5 w-5" />
          </button>
          <div className="flex-1 text-center">
            <div className="text-[15px] font-extrabold text-ink">{isToday ? "오늘" : formatDateLabel(date).split("(")[0].trim()}</div>
            <div className="text-[11.5px] text-ink-mute">{formatDateLabel(date)}</div>
          </div>
          <button onClick={() => go(addDays(date, 1))} className="tap flex h-9 w-9 items-center justify-center rounded-lg bg-black/[0.04] text-ink-soft">
            <ChevronRight className="h-5 w-5" />
          </button>
          <label className="tap relative flex h-9 w-9 items-center justify-center rounded-lg bg-black/[0.04] text-ink-soft">
            <Calendar className="h-4 w-4" />
            <input type="date" value={date} onChange={(e) => e.target.value && go(e.target.value)} className="absolute inset-0 opacity-0" />
          </label>
          {!isToday && (
            <button onClick={() => go(ymd(new Date()))} className="tap rounded-lg bg-brand-600 px-2.5 text-[12px] font-bold text-white">
              오늘
            </button>
          )}
        </div>

        {/* 검색 */}
        <div className="px-4 pb-2.5 pt-2">
          <div className="flex items-center gap-2 rounded-xl bg-black/[0.05] px-3 py-2">
            <Search className="h-4 w-4 text-ink-faint" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="이름·연락처·장비·거래ID 전체 검색"
              className="flex-1 bg-transparent text-[13.5px] text-ink outline-none placeholder:text-ink-faint"
            />
            {q && (
              <button onClick={() => setQ("")} className="text-ink-faint">✕</button>
            )}
          </div>
        </div>
      </header>

      {/* 본문 */}
      <main className="flex-1 space-y-3 px-4 pb-28 pt-3">
        {!searching && <HandoverBoard notes={data.notes} />}

        {searching && (
          <div className="text-[12.5px] font-semibold text-ink-mute">
            검색 결과 {results.length}건 — “{q.trim()}”
          </div>
        )}

        {groups.length === 0 && doneList.length === 0 && (
          <div className="rounded-xl2 bg-white py-16 text-center text-[14px] text-ink-faint shadow-card ring-1 ring-black/5">
            {searching ? "검색 결과가 없습니다" : "해당 항목이 없습니다"}
          </div>
        )}

        {/* 진행 중 (전부 완료되면 축하 메시지) */}
        {!searching && groups.length === 0 && doneList.length > 0 && (
          <div className="rounded-xl2 bg-checkin-bg/50 py-10 text-center shadow-card ring-1 ring-checkin-ring">
            <div className="text-[15px] font-extrabold text-checkin-fg">오늘 {tab === "checkin" ? "반납" : tab === "checkout" ? "반출" : ""} 다 처리했어요 🎉</div>
            <div className="mt-1 text-[12.5px] text-ink-mute">완료 {doneList.length}건</div>
          </div>
        )}

        {groups.map(([band, items]) => (
          <div key={band} className="space-y-2.5">
            <div className="flex items-center gap-2 pl-1 pt-1">
              <span className="text-[12px] font-bold text-ink-mute">{band}</span>
              <span className="text-[11px] text-ink-faint">{items.length}건</span>
              <span className="h-px flex-1 bg-black/5" />
            </div>
            {items.map((t) => {
              cardIndex += 1;
              return (
                <ScheduleCard
                  key={t.tradeId + (searching ? "-s" : "")}
                  trade={t}
                  date={date}
                  tab={searching ? "all" : tab}
                  saving={!!data.savingTrades[t.tradeId]}
                  defaultOpen={cardIndex === 0}
                />
              );
            })}
          </div>
        ))}

        {/* 완료 — 아래로 치움 (펼쳐서 되돌리기) */}
        {doneList.length > 0 && (
          <div className="pt-1">
            <button
              onClick={() => setShowDone((s) => !s)}
              className="tap flex w-full items-center gap-2 rounded-xl bg-checkin-bg/60 px-3 py-2.5 ring-1 ring-checkin-ring"
            >
              <Check className="h-4 w-4 text-checkin-fg" />
              <span className="text-[13px] font-bold text-checkin-fg">완료 {doneList.length}건</span>
              <ChevronRight className={`ml-auto h-4 w-4 text-checkin-fg transition-transform ${showDone ? "-rotate-90" : "rotate-90"}`} />
            </button>
            {showDone && (
              <div className="mt-2.5 space-y-2.5">
                {doneList.map((t) => (
                  <ScheduleCard
                    key={t.tradeId + "-done"}
                    trade={t}
                    date={date}
                    tab={tab}
                    saving={!!data.savingTrades[t.tradeId]}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </main>

      {/* 하단 탭바 */}
      <nav className="safe-bottom fixed inset-x-0 bottom-0 z-30 mx-auto max-w-md">
        <div className="m-2 flex items-stretch gap-1 rounded-2xl bg-white/95 p-1.5 shadow-pop ring-1 ring-black/5 backdrop-blur">
          {TABS.map((t) => {
            const active = !searching && tab === t.key;
            const count = counts[t.key];
            const isAttn = t.key === "attention";
            return (
              <button
                key={t.key}
                onClick={() => {
                  setQ("");
                  setTab(t.key);
                }}
                className={`tap relative flex flex-1 flex-col items-center rounded-xl py-1.5 ${
                  active ? "bg-brand-50 text-brand-700" : "text-ink-mute"
                }`}
              >
                <span className="text-[12.5px] font-bold">{t.label}</span>
                <span
                  className={`mt-0.5 min-w-5 rounded-full px-1.5 text-[11px] font-bold tabular-nums ${
                    isAttn && count > 0
                      ? "bg-attention-fg text-white"
                      : active
                        ? "bg-brand-600 text-white"
                        : "bg-black/[0.06] text-ink-mute"
                  }`}
                >
                  {count}
                </span>
              </button>
            );
          })}
        </div>
      </nav>

      <Toast />
    </div>
  );
}
