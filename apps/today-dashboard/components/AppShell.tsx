"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { SideRail } from "@/components/SideRail";
import { BottomTabBar } from "@/components/BottomTabBar";
import type { NavKey } from "@/components/navConfig";

function PaneLoading({ label }: { label: string }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-paper px-4 text-[14px] font-bold text-ink-faint">
      {label} 불러오는 중...
    </div>
  );
}

const TodayView = dynamic(() => import("@/components/TodayView").then((mod) => mod.TodayView), {
  ssr: false,
  loading: () => <PaneLoading label="오늘 일정" />,
});

const ScheduleView = dynamic(() => import("@/components/ScheduleView").then((mod) => mod.ScheduleView), {
  ssr: false,
  loading: () => <PaneLoading label="스케줄" />,
});

const FollowUpView = dynamic(() => import("@/components/FollowUpView").then((mod) => mod.FollowUpView), {
  ssr: false,
  loading: () => <PaneLoading label="후속조치" />,
});

const OperationsView = dynamic(() => import("@/components/OperationsView").then((mod) => mod.OperationsView), {
  ssr: false,
  loading: () => <PaneLoading label="운영판" />,
});

const ConfirmView = dynamic(() => import("@/components/ConfirmView").then((mod) => mod.ConfirmView), {
  ssr: false,
  loading: () => <PaneLoading label="확인요청" />,
});

const InventoryView = dynamic(() => import("@/components/InventoryView").then((mod) => mod.InventoryView), {
  ssr: false,
  loading: () => <PaneLoading label="재고" />,
});

// PC(lg+): 좌측 레일(4섹션) + 가운데 선택 섹션 + 우측 오늘일정 고정(좁은 컬럼이라 더 잘 보임).
// 모바일(<lg): 하단 탭바 5섹션 + 단일 콘텐츠(오늘일정 포함). 방문한 뷰는 mount 유지 → 전환 즉시.
function useIsLg() {
  const [lg, setLg] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const on = () => setLg(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return lg;
}

export function AppShell({ initial = "today" }: { initial?: NavKey }) {
  const isLg = useIsLg();
  const [view, setView] = useState<NavKey>(initial);

  useEffect(() => {
    setView(initial);
  }, [initial]);

  const handleNav = useCallback((next: NavKey) => {
    setView((current) => (current === next ? current : next));
  }, []);

  // PC에선 오늘일정이 우측 고정이라 메인엔 4섹션만 — view가 today면 메인은 스케줄로.
  const mainView: NavKey = isLg && view === "today" ? "schedule" : view;
  const active: NavKey = isLg ? mainView : view;

  const [visited, setVisited] = useState<Set<NavKey>>(() => new Set<NavKey>([initial]));
  useEffect(() => {
    setVisited((prev) => {
      if (prev.has(view) && prev.has(active)) return prev;
      const n = new Set(prev);
      n.add(view);
      n.add(active);
      return n;
    });
  }, [view, active]);

  // 오늘일정 메인 pane은 모바일 전용(PC는 우측 고정). 나머지는 keep-mounted.
  const pane = (key: NavKey, node: ReactNode) =>
    visited.has(key) ? (
      <div key={key} className={active === key ? "" : "hidden"}>
        {node}
      </div>
    ) : null;

  return (
    <div className="lg:flex lg:h-screen lg:overflow-hidden">
      <SideRail view={mainView} onNav={handleNav} />
      <main className="relative flex-1 lg:min-h-0 lg:overflow-y-auto">
        {!isLg && pane("today", <TodayView />)}
        {pane("schedule", <ScheduleView />)}
        {pane("follow", <FollowUpView />)}
        {pane("operations", <OperationsView />)}
        {pane("confirm", <ConfirmView />)}
        {pane("inventory", <InventoryView />)}
      </main>
      {isLg && (
        <aside className="hidden w-[400px] shrink-0 overflow-y-auto border-l border-line/60 lg:block xl:w-[440px]">
          <TodayView />
        </aside>
      )}
      <BottomTabBar view={view} onNav={handleNav} />
    </div>
  );
}
