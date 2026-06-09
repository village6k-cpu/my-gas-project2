"use client";

import { OperationsView } from "@/components/OperationsView";

// 모바일 전용 라우트 (PC에선 '/' 우측 패널 토글로 표시됨)
export default function OperationsPage() {
  return <OperationsView />;
}
