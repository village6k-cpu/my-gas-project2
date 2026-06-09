"use client";

import { TodayView } from "@/components/TodayView";
import { RightPanel } from "@/components/RightPanel";

// 모바일: 오늘일정만(헤더 토글로 스케줄/후속조치 이동)
// PC(lg+): 왼쪽 오늘일정 고정 + 오른쪽 패널에서 빌리지스케줄↔후속조치 토글
export default function Page() {
  return (
    <div className="lg:flex lg:h-screen lg:overflow-hidden">
      {/* 오늘 일정 — 모바일 전체폭, PC 좌측 패널(420px) 고정 */}
      <div className="mx-auto w-full max-w-md lg:mx-0 lg:w-[420px] lg:max-w-none lg:shrink-0 lg:overflow-y-auto lg:border-r lg:border-black/5">
        <TodayView />
      </div>
      {/* PC 우측 — 빌리지 스케줄 ↔ 후속조치 토글 */}
      <div className="hidden lg:block lg:flex-1 lg:overflow-y-auto">
        <RightPanel />
      </div>
    </div>
  );
}
