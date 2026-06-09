"use client";

import { useState } from "react";
import { ScheduleView } from "@/components/ScheduleView";
import { FollowUpView } from "@/components/FollowUpView";

// PC 합본 우측 패널 — 빌리지 스케줄 ↔ 후속조치 토글 (왼쪽 오늘일정은 고정)
export function RightPanel() {
  const [tab, setTab] = useState<"schedule" | "follow">("schedule");
  const on = "rounded-full bg-white px-3 py-1 text-brand-700 shadow-sm";
  const off = "px-3 py-1 text-ink-faint";
  const toggle = (
    <div className="flex items-center gap-1 rounded-full bg-black/[0.05] p-0.5 text-[13px] font-bold">
      <button onClick={() => setTab("schedule")} className={tab === "schedule" ? on : off}>
        빌리지 스케줄
      </button>
      <button onClick={() => setTab("follow")} className={tab === "follow" ? on : off}>
        후속조치
      </button>
    </div>
  );
  return tab === "schedule" ? <ScheduleView embedded headerLeft={toggle} /> : <FollowUpView embedded headerLeft={toggle} />;
}
