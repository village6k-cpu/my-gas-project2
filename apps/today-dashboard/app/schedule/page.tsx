"use client";

import { useEffect, useMemo, useState } from "react";
import { loadDay, useDashboard } from "@/lib/data/store";
import { ymd } from "@/lib/domain/status";
import { buildItems, type GroupMode } from "@/lib/domain/timeline";
import { AppSwitcher } from "@/components/AppSwitcher";
import { VillageTimeline } from "@/components/VillageTimeline";
import { Search } from "@/components/icons";

const MODES: { v: GroupMode; label: string }[] = [
  { v: "set", label: "세트별" },
  { v: "customer", label: "고객별" },
  { v: "status", label: "상태별" },
];

export default function SchedulePage() {
  const [today, setToday] = useState("");
  const [mode, setMode] = useState<GroupMode>("set");
  const [q, setQ] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const data = useDashboard();

  useEffect(() => {
    const t = ymd(new Date());
    setToday(t);
    loadDay(t);
  }, []);

  const items = useMemo(() => buildItems(data.trades), [data.trades]);
  const filterOn = !!(from && to);

  if (!today) return <div className="flex h-screen items-center justify-center text-ink-faint">불러오는 중…</div>;

  return (
    <div className="mx-auto flex min-h-screen max-w-5xl flex-col bg-[#f4f5f7]">
      <header className="safe-top sticky top-0 z-40 bg-white/90 backdrop-blur-md ring-1 ring-black/5">
        <div className="flex items-center justify-between px-4 pt-2.5">
          <AppSwitcher active="schedule" />
          <span className="text-[12px] text-ink-faint">장비별 예약 현황</span>
        </div>

        <div className="flex flex-wrap items-center gap-2 px-4 pb-2.5 pt-2">
          <div className="flex items-center gap-0.5 rounded-lg bg-black/[0.05] p-0.5">
            {MODES.map((m) => (
              <button key={m.v} onClick={() => setMode(m.v)} className={`tap rounded-md px-2.5 py-1.5 text-[12.5px] font-bold ${mode === m.v ? "bg-white text-brand-700 shadow-sm" : "text-ink-mute"}`}>
                {m.label}
              </button>
            ))}
          </div>

          <div className="flex min-w-[180px] flex-1 items-center gap-2 rounded-lg bg-black/[0.05] px-3 py-2">
            <Search className="h-4 w-4 text-ink-faint" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="예약자·장비·거래ID 검색" className="flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-faint" />
            {q && <button onClick={() => setQ("")} className="text-ink-faint">✕</button>}
          </div>

          {/* 날짜 범위 필터 */}
          <div className="flex items-center gap-1 rounded-lg bg-black/[0.05] px-2 py-1.5 text-[12.5px]">
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="bg-transparent text-ink outline-none" />
            <span className="text-ink-faint">~</span>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="bg-transparent text-ink outline-none" />
            {filterOn && (
              <button onClick={() => { setFrom(""); setTo(""); }} className="ml-1 text-ink-faint">✕</button>
            )}
          </div>
        </div>
      </header>

      <main className="flex-1 p-3">
        <VillageTimeline items={items} trades={data.trades} mode={mode} search={q} today={today} filterStart={filterOn ? from : undefined} filterEnd={filterOn ? to : undefined} />
        <p className="mt-2 px-1 text-[11.5px] text-ink-faint">
          막대 드래그 → 날짜 이동 · 좌우 끝 끌기 → 기간 조절 · 탭 → 상세 · 우클릭/롱프레스 → 메뉴 · 빨강 테두리 = 재고 충돌
        </p>
      </main>
    </div>
  );
}
