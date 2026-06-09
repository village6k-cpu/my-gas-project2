import type { ComponentType } from "react";
import { Today, Timeline, Chat, Chart, Clipboard } from "@/components/icons";

// 다 동등한 5개 섹션 — 하나의 통합앱. 상태기반 전환(라우트 X).
export type NavKey = "today" | "schedule" | "follow" | "operations" | "confirm";

export const NAV_ITEMS: { key: NavKey; label: string; href: string; Icon: ComponentType<{ className?: string }> }[] = [
  { key: "today", label: "오늘 일정", href: "/", Icon: Today },
  { key: "schedule", label: "스케줄", href: "/schedule", Icon: Timeline },
  { key: "follow", label: "후속조치", href: "/follow-ups", Icon: Chat },
  { key: "operations", label: "운영판", href: "/operations", Icon: Chart },
  { key: "confirm", label: "확인요청", href: "/confirm", Icon: Clipboard },
];
