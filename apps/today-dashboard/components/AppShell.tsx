"use client";

import { useEffect, useState, type ReactNode } from "react";
import { SideRail } from "@/components/SideRail";
import { BottomTabBar } from "@/components/BottomTabBar";
import { TodayView } from "@/components/TodayView";
import { ScheduleView } from "@/components/ScheduleView";
import { FollowUpView } from "@/components/FollowUpView";
import { OperationsView } from "@/components/OperationsView";
import { ConfirmView } from "@/components/ConfirmView";
import type { NavKey } from "@/components/navConfig";

// 하나의 통합 셸 — 5섹션을 상태로 전환(라우트 X). 방문한 뷰는 mount 유지(hidden 토글)해
// 재진입 시 재fetch·재계산 없이 즉시(instant) 표시. 모바일=하단탭바, PC=좌측 레일.
export function AppShell({ initial = "today" }: { initial?: NavKey }) {
  const [view, setView] = useState<NavKey>(initial);
  const [visited, setVisited] = useState<Set<NavKey>>(() => new Set<NavKey>([initial]));

  useEffect(() => {
    setVisited((prev) => (prev.has(view) ? prev : new Set(prev).add(view)));
  }, [view]);

  const pane = (key: NavKey, node: ReactNode) =>
    visited.has(key) ? (
      <div key={key} className={view === key ? "" : "hidden"}>
        {node}
      </div>
    ) : null;

  return (
    <div className="lg:flex lg:h-screen lg:overflow-hidden">
      <SideRail view={view} onNav={setView} />
      <main className="relative flex-1 lg:min-h-0 lg:overflow-y-auto">
        {pane("today", <TodayView />)}
        {pane("schedule", <ScheduleView />)}
        {pane("follow", <FollowUpView />)}
        {pane("operations", <OperationsView />)}
        {pane("confirm", <ConfirmView />)}
      </main>
      <BottomTabBar view={view} onNav={setView} />
    </div>
  );
}
