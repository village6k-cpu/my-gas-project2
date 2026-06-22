// 고객용 "내 예약 페이지" — 토큰 링크(?t=...)로 본인 예약 1건만 조회 (읽기 전용).
// 첫 화면은 즉시 렌더링하고, 예약 데이터는 /api/my를 통해 불러온다.
// 변경/연장/취소 요청은 이 페이지에서 받지 않고 카카오톡 채널로 안내한다.

import type { ReactNode } from "react";
import { VillageLogo } from "@/components/VillageLogo";
import { MyPageClient, MyPageLoading } from "./MyPageClient";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

type SearchParamValue = string | string[] | undefined;
type SearchParams = Promise<Record<string, SearchParamValue>>;

function firstParam(value: SearchParamValue) {
  return Array.isArray(value) ? value[0] || "" : value || "";
}

function MyPageFrame({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-dvh bg-paper px-4 py-8 text-ink">
      <div className="mx-auto w-full max-w-[560px]">
        <header className="mb-6 flex flex-col items-center text-center">
          <VillageLogo size="lg" />
          <h1 className="mt-4 text-[20px] font-black leading-tight">내 예약</h1>
        </header>
        {children}
        <footer className="mt-8 text-center text-[12px] font-medium text-ink-faint">
          카메라 렌탈샵 빌리지 · 문의는 카카오톡 채널로
        </footer>
      </div>
    </div>
  );
}

export default async function MyReservationPage({ searchParams }: { searchParams?: SearchParams }) {
  const params = searchParams ? await searchParams : {};
  const token = firstParam(params.t);

  return (
    <MyPageFrame>
      <noscript>
        <MyPageLoading />
      </noscript>
      <MyPageClient token={token} />
    </MyPageFrame>
  );
}
