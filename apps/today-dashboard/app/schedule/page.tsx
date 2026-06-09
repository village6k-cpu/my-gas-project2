"use client";

import { ScheduleView } from "@/components/ScheduleView";

// 모바일 전용 라우트 (PC에선 '/'에 합본으로 표시됨)
export default function SchedulePage() {
  return <ScheduleView />;
}
