"use client";

import { useEffect, useMemo, useState } from "react";
import type { TabKey, Trade } from "@/lib/domain/types";
import { loadDay, repairSearchResults, useDashboard } from "@/lib/data/store";
import {
  addDays,
  cardDone,
  formatDateLabel,
  searchTradeEvents,
  tabCounts,
  type TradeSearchEvent,
  timeBand,
  timeSortKey,
  tradesForTab,
  ymd,
} from "@/lib/domain/status";
import { ScheduleCard } from "@/components/ScheduleCard";
import { ViewHeader } from "@/components/ViewHeader";
import { HandoverBoard } from "@/components/HandoverBoard";
import { Toast } from "@/components/Toast";
import { Calendar, Check, ChevronLeft, ChevronRight, Refresh, Search } from "@/components/icons";

const TABS: { key: TabKey; label: string }[] = [
  { key: "checkout", label: "반출" },
  { key: "checkin", label: "반납" },
  { key: "all", label: "전체" },
  { key: "attention", label: "확인필요" },
];

export function TodayView() {
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
  const searchEvents = useMemo<TradeSearchEvent[]>(() => (searching ? searchTradeEvents(data.trades, q) : []), [q, data.trades, searching]);

  useEffect(() => {
    if (!searching) return;
    const timer = setTimeout(() => repairSearchResults(q), 350);
    return () => clearTimeout(timer);
  }, [q, searching]);

  const list = useMemo(() => tradesForTab(data.trades, date, tab), [data.trades, date, tab]);

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

  const searchGroups = useMemo(() => {
    const byGroup: Record<string, TradeSearchEvent[]> = {};
    for (const event of searchEvents) {
      (byGroup[event.groupLabel] ||= []).push(event);
    }
    return Object.entries(byGroup);
  }, [searchEvents]);

  if (!date) {
    return <div className="flex h-screen items-center justify-center text-ink-faint">불러오는 중…</div>;
  }

  const isToday = date === ymd(new Date());

  let cardIndex = -1;

  return (
    <div className="flex min-h-screen flex-col bg-paper lg:min-h-full">
      {/* 상단 고정 헤더 */}
      <header className="safe-top sticky top-0 z-30 bg-paper/90 backdrop-blur-md ring-1 ring-line/70">
        <ViewHeader title="오늘 일정">
          <button onClick={() => go(date)} className="tap flex h-9 w-9 items-center justify-center rounded-full bg-white ring-1 ring-line/60 text-ink-soft" title="새로고침">
            <Refresh className="h-4 w-4" />
          </button>
        </ViewHeader>

        {/* 날짜 내비 */}
        <div className="flex items-center gap-2 px-4 pt-2">
          <button onClick={() => go(addDays(date, -1))} className="tap flex h-9 w-9 items-center justify-center rounded-lg bg-white ring-1 ring-line/60 text-ink-soft">
            <ChevronLeft className="h-5 w-5" />
          </button>
          <div className="flex-1 text-center">
            <div className="text-[15px] font-extrabold text-ink">{isToday ? "오늘" : formatDateLabel(date).split("(")[0].trim()}</div>
            <div className="text-[11.5px] text-ink-mute">{formatDateLabel(date)}</div>
          </div>
          <button onClick={() => go(addDays(date, 1))} className="tap flex h-9 w-9 items-center justify-center rounded-lg bg-white ring-1 ring-line/60 text-ink-soft">
            <ChevronRight className="h-5 w-5" />
          </button>
          <label className="tap relative flex h-9 w-9 items-center justify-center rounded-lg bg-white ring-1 ring-line/60 text-ink-soft">
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
          <div className="flex items-center gap-2 rounded-xl bg-white ring-1 ring-line/60 px-3 py-2">
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

        {/* 오늘일정 내부 필터 (반출/반납/전체/확인필요) — 세그먼트 */}
        <div className="flex items-stretch gap-1 px-3 pb-2">
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
                className={`tap relative flex flex-1 items-center justify-center gap-1.5 rounded-lg py-1.5 ${
                  active ? "bg-brand-50 text-brand-700 ring-1 ring-brand-100" : "text-ink-mute"
                }`}
              >
                <span className="text-[12.5px] font-bold">{t.label}</span>
                <span
                  className={`min-w-[18px] rounded-full px-1 text-center text-[10.5px] font-bold tabular-nums ${
                    isAttn && count > 0 ? "bg-attention-fg text-white" : active ? "bg-brand-600 text-white" : "bg-line/40 text-ink-mute"
                  }`}
                >
                  {count}
                </span>
              </button>
            );
          })}
        </div>
      </header>

      {/* 본문 */}
      <main className="flex-1 space-y-3 px-4 pb-24 pt-3">
        {!searching && <HandoverBoard notes={data.notes} />}

        {searching && (
          <div className="text-[12.5px] font-semibold text-ink-mute">
            검색 결과 {searchEvents.length}건 — “{q.trim()}”
          </div>
        )}

        {(searching ? searchGroups.length === 0 : groups.length === 0 && doneList.length === 0) && (
          <div className="rounded-xl2 bg-white py-16 text-center text-[14px] text-ink-faint shadow-card ring-1 ring-line/70">
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

        {searching
          ? searchGroups.map(([group, events]) => (
              <div key={group} className="space-y-2.5">
                <div className="flex items-center gap-2 pl-1 pt-1">
                  <span className="text-[12px] font-bold text-ink-mute">{group}</span>
                  <span className="text-[11px] text-ink-faint">{events.length}건</span>
                  <span className="h-px flex-1 bg-line/60" />
                </div>
                {events.map((event) => {
                  cardIndex += 1;
                  return (
                    <ScheduleCard
                      key={event.key}
                      trade={event.trade}
                      date={event.date}
                      tab={event.phase}
                      saving={!!data.savingTrades[event.trade.tradeId]}
                      defaultOpen={cardIndex === 0}
                    />
                  );
                })}
              </div>
            ))
          : groups.map(([band, items]) => (
              <div key={band} className="space-y-2.5">
                <div className="flex items-center gap-2 pl-1 pt-1">
                  <span className="text-[12px] font-bold text-ink-mute">{band}</span>
                  <span className="text-[11px] text-ink-faint">{items.length}건</span>
                  <span className="h-px flex-1 bg-line/60" />
                </div>
                {items.map((t) => {
                  cardIndex += 1;
                  return (
                    <ScheduleCard
                      key={t.tradeId}
                      trade={t}
                      date={date}
                      tab={tab}
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

      <Toast />
    </div>
  );
}
