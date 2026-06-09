"use client";

import { TodayView } from "@/components/TodayView";
import { ScheduleView } from "@/components/ScheduleView";

// 모바일: 오늘일정만(헤더 토글로 스케줄 이동) · PC(lg+): 오늘일정 + 빌리지스케줄 한 화면
export default function Page() {
  return (
    <div className="lg:flex lg:h-screen lg:overflow-hidden">
      {/* 오늘 일정 — 모바일 전체폭, PC 좌측 패널(420px) */}
      <div className="mx-auto w-full max-w-md lg:mx-0 lg:w-[420px] lg:max-w-none lg:shrink-0 lg:overflow-y-auto lg:border-r lg:border-black/5">
        <TodayView />
      </div>
      {/* 빌리지 스케줄 — PC에서만 우측에 함께 */}
      <div className="hidden lg:block lg:flex-1 lg:overflow-y-auto">
        <ScheduleView embedded />
      </div>
    </div>
  );
}
