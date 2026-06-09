// VILLAGE 워드마크 — 앱 전체 공통 브랜드 마크 (V·마침표 = 시그니처 오렌지)
export function VillageLogo({ size = "md" }: { size?: "sm" | "md" | "lg" }) {
  const cls = size === "lg" ? "text-[30px]" : size === "sm" ? "text-[21px]" : "text-[25px]";
  return (
    <span className={`font-village inline-flex select-none items-end font-black uppercase leading-none tracking-tight text-ink ${cls}`}>
      <span className="text-accent">V</span>
      <span>illage</span>
      <span aria-hidden className="mb-[0.08em] ml-[0.05em] inline-block h-[0.2em] w-[0.2em] bg-accent" />
    </span>
  );
}
