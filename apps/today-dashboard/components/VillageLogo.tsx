// VILLAGE 워드마크 — 앱 전체 공통 브랜드 마크 (사용자 제공 이미지)
export function VillageLogo({ size = "md" }: { size?: "sm" | "md" | "lg" }) {
  const cls = size === "lg" ? "h-10 w-[195px]" : size === "sm" ? "h-6 w-[117px]" : "h-7 w-[137px]";

  return (
    <img
      src="/village-wordmark.png"
      alt="VILLAGE"
      className={`block select-none object-contain ${cls}`}
      draggable={false}
    />
  );
}
