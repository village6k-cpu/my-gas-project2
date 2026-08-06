import type { Metadata } from "next";
import { VillageLogo } from "@/components/VillageLogo";
import { GuideVideoLibrary } from "@/components/guides/GuideVideoLibrary";

export const metadata: Metadata = {
  title: "장비 사용법 | 빌리지",
  description: "카메라 렌탈샵 빌리지 장비 사용법과 파손·분실 예방 영상",
};

export default function EquipmentGuidesPage() {
  return (
    <main className="min-h-dvh bg-paper px-4 py-7 text-ink sm:px-6 sm:py-10">
      <div className="mx-auto w-full max-w-[920px]">
        <header className="mb-7 text-center">
          <VillageLogo size="lg" />
          <p className="mt-4 text-[12px] font-black tracking-[0.16em] text-brand-600">EQUIPMENT GUIDE</p>
          <h1 className="mt-2 text-[26px] font-black leading-tight sm:text-[34px]">장비 사용법</h1>
          <p className="mx-auto mt-3 max-w-[540px] text-[14px] font-semibold leading-relaxed text-ink-mute sm:text-[15px]">
            헷갈리는 장착 방향부터 파손·분실이 잦은 부분까지.<br className="hidden sm:block" /> 장비명이나 증상을 검색하면 짧은 영상으로 바로 확인할 수 있습니다.
          </p>
        </header>

        <GuideVideoLibrary />

        <footer className="mt-10 border-t border-line/80 pt-6 text-center text-[12px] font-semibold leading-relaxed text-ink-faint">
          영상으로 해결되지 않으면 카카오톡 채널 <b className="text-ink-mute">빌리지</b>로 문의해주세요.
        </footer>
      </div>
    </main>
  );
}
