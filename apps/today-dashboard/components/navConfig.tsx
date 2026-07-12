import type { ComponentType } from "react";
import { Today, Timeline, Chat, Chart, Clipboard, Archive } from "@/components/icons";

// 하단탭/좌측레일에 노출되는 "메인 업무" 섹션. 상태기반 전환(라우트 X).
// dojang(훈련소)·재방문/장비수익 레이더·오토파일럿 같은 분석·성장·교육 도구는 여기서 빼고
// 운영판(operations) 안의 '도구 & 성장' 섹션에서 진입한다. (/dojang 등 라우트는 그대로 유지)
export type NavKey = "today" | "schedule" | "follow" | "operations" | "confirm" | "inventory" | "dojang";

export const NAV_ITEMS: { key: NavKey; label: string; href: string; Icon: ComponentType<{ className?: string }> }[] = [
  { key: "today", label: "오늘 일정", href: "/", Icon: Today },
  { key: "schedule", label: "스케줄", href: "/schedule", Icon: Timeline },
  { key: "follow", label: "후속조치", href: "/follow-ups", Icon: Chat },
  { key: "operations", label: "운영판", href: "/operations", Icon: Chart },
  { key: "confirm", label: "확인요청", href: "/confirm", Icon: Clipboard },
  { key: "inventory", label: "재고", href: "/inventory", Icon: Archive },
];
