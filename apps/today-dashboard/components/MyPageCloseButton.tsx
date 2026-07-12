"use client";

// 내 예약(/my)에서 빠져나갈 방법 — 특히 사장이 헤이빌리(홈 화면 앱/PWA)에서
// '내예약 열기'로 진입하면 브라우저 탭 UI가 없어 되돌아갈 길이 없었다.
// 히스토리가 있으면 뒤로, 스크립트로 열린 탭이면 닫는다. 고객이 카톡 링크로
// 직접 본 경우엔 안전하게 아무 일도 하지 않는다(자기 예약 페이지에 그대로 머묾).
export function MyPageCloseButton() {
  return (
    <button
      type="button"
      onClick={() => {
        if (typeof window === "undefined") return;
        if (window.history.length > 1) {
          window.history.back();
          return;
        }
        window.close();
      }}
      aria-label="닫기"
      className="tap absolute left-0 top-0 inline-flex items-center gap-1 rounded-full bg-white/70 px-3 py-1.5 text-[13px] font-bold text-ink-mute ring-1 ring-line/70 backdrop-blur"
    >
      ← 닫기
    </button>
  );
}
