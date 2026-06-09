"use client";

import { useState } from "react";
import { ScheduleView } from "@/components/ScheduleView";
import { FollowUpView } from "@/components/FollowUpView";
import { OperationsView } from "@/components/OperationsView";
import { ConfirmView } from "@/components/ConfirmView";

type RightKey = "schedule" | "follow" | "operations" | "confirm";

const TABS: { key: RightKey; label: string }[] = [
  { key: "schedule", label: "빌리지 스케줄" },
  { key: "follow", label: "후속조치" },
  { key: "operations", label: "운영판" },
  { key: "confirm", label: "확인요청" },
];

// PC 합본 우측 패널 — 빌리지스케줄·후속조치·운영판·확인요청 4개 동등 토글 (왼쪽 오늘일정은 고정).
export function RightPanel() {
  const [tab, setTab] = useState<RightKey>("schedule");
  const on = "rounded-full bg-white px-3 py-1 text-accent-700 shadow-sm";
  const off = "px-3 py-1 text-ink-faint";
  const toggle = (
    <div className="flex items-center gap-0.5 overflow-x-auto rounded-full bg-black/[0.05] p-0.5 text-[13px] font-bold [&::-webkit-scrollbar]:hidden">
      {TABS.map((t) => (
        <button key={t.key} onClick={() => setTab(t.key)} className={`shrink-0 whitespace-nowrap ${tab === t.key ? on : off}`}>
          {t.label}
        </button>
      ))}
    </div>
  );

  if (tab === "schedule") return <ScheduleView embedded headerLeft={toggle} />;
  if (tab === "follow") return <FollowUpView embedded headerLeft={toggle} />;
  if (tab === "operations") return <OperationsView embedded headerLeft={toggle} />;
  return <ConfirmView embedded headerLeft={toggle} />;
}
