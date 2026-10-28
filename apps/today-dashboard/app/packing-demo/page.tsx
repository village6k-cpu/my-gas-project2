"use client";

import { useState } from "react";
import { PackingChecklist } from "@/components/PackingChecklist";
import { transitionPacking, type PackingCommand } from "@/lib/domain/packing";
import type { Trade } from "@/lib/domain/types";

const example = (): Trade => ({
  tradeId: "demo", customerName: "구성품 체험", customerPhone: "", checkoutAt: "", returnAt: "",
  contractStatus: "예약", setupDone: false, returnDone: false, photos: [], riskWarnings: [],
  equipments: [
    { scheduleId: "monitor-power", name: "스몰HD용 D탭 라인 (9V)", qty: 1, setName: "스몰HD", isComponent: true, checkoutState: "pending" },
    { scheduleId: "monitor-sdi", name: "스몰HD용 SDI 연선", qty: 1, setName: "스몰HD", isComponent: true, checkoutState: "pending" },
    { scheduleId: "teradek-power", name: "테라덱용 D탭 라인 (2핀)", qty: 2, setName: "테라덱", isComponent: true, checkoutState: "pending" },
    { scheduleId: "teradek-sdi", name: "테라덱용 SDI 연선", qty: 2, setName: "테라덱", isComponent: true, checkoutState: "pending" },
    { scheduleId: "motor-power", name: "뉴클-M 모터용 D탭 라인 (7핀)", qty: 1, setName: "뉴클-M", isComponent: true, checkoutState: "pending" },
  ],
});

export default function PackingDemo() {
  const [trade, setTrade] = useState(example);
  const [phase, setPhase] = useState<"checkout" | "checkin">("checkout");
  const [session, setSession] = useState(0);
  const command = async (version: number, cmd: PackingCommand) => {
    if ((trade.packing?.version ?? 0) !== version) throw new Error("최신 내역을 확인해주세요");
    const packing = transitionPacking(trade, cmd, new Date().toISOString());
    setTrade({ ...trade, packing });
  };
  return <main className="mx-auto max-w-2xl px-3 py-6">
    <a href="/" className="text-sm font-bold text-brand-700">← 실제 일정으로</a>
    <h1 className="mt-4 text-xl font-extrabold">구성품 반출·반납 체험</h1>
    <p className="my-3 text-sm text-ink-mute">실제 앱과 같은 조작 화면입니다. 여기서 입력한 내용은 고객 예약에 저장되지 않고 새로고침하면 초기화됩니다. 아래 수량은 체험용 예시입니다.</p>
    <div className="mb-3 flex gap-2">
      <button className={`rounded-lg px-4 py-2 font-bold ${phase === "checkout" ? "bg-brand-600 text-white" : "bg-white"}`} onClick={() => setPhase("checkout")}>1. 반출 준비</button>
      <button disabled={trade.packing?.phase !== "sealed"} className={`rounded-lg px-4 py-2 font-bold disabled:opacity-40 ${phase === "checkin" ? "bg-checkin-fg text-white" : "bg-white"}`} onClick={() => { setTrade({ ...trade, setupDone: true }); setPhase("checkin"); }}>2. 반납 확인</button>
      <button className="ml-auto text-xs font-bold text-ink-mute" onClick={() => { setTrade(example()); setPhase("checkout"); setSession(session + 1); }}>처음부터</button>
    </div>
    <PackingChecklist key={session} trade={trade} phase={phase} onCommand={command} />
  </main>;
}
