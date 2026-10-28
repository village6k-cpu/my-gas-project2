"use client";

import { useState } from "react";
import { HandoverChecklist } from "@/components/HandoverChecklist";
import { transitionPacking, type PackingCommand } from "@/lib/domain/packing";
import type { Trade } from "@/lib/domain/types";

const example = (): Trade => ({
  tradeId: "demo", customerName: "구성품 체험", customerPhone: "", checkoutAt: "", returnAt: "",
  contractStatus: "예약", setupDone: false, returnDone: false, photos: [], riskWarnings: [],
  equipments: [
    {scheduleId:"fx",name:"소니 FX6 풀세트",qty:1,setName:"소니 FX6 풀세트",isSetHeader:true,checkoutState:"pending"},
    {scheduleId:"body",name:"소니 FX6 바디(케이지)",qty:1,setName:"소니 FX6 풀세트",isComponent:true,checkoutState:"pending"},
    {scheduleId:"monitor",name:"7인치 모니터",qty:1,setName:"소니 FX6 풀세트",isComponent:true,checkoutState:"pending"},
    {scheduleId:"lvm",name:"LVM-170A",qty:1,setName:"소니 FX6 풀세트",isComponent:true,checkoutState:"pending"},
    {scheduleId:"bundle",name:"SDI 롱라인, SDI 라인, 노가암",qty:1,setName:"소니 FX6 풀세트",isComponent:true,checkoutState:"pending"},
    {scheduleId:"pyro",name:"파이로 7",qty:1,setName:"파이로 7",isSetHeader:true,checkoutState:"pending"},
    {scheduleId:"pyro-bundle",name:"D탭*1 / SDI or HDMI*1 / 안테나*2",qty:1,setName:"파이로 7",isComponent:true,checkoutState:"pending"},
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
    <p className="my-3 text-sm text-ink-mute">실제 앱과 같은 조작 화면입니다. 여기서 입력한 내용은 고객 예약에 저장되지 않고 새로고침하면 초기화됩니다. 실제 예약과 같은 장비 목록에서 구성품 준비를 시작하고, 7인치 모니터의 실제 모델을 선택해보세요.</p>
    <div className="mb-3 flex gap-2">
      <button className={`rounded-lg px-4 py-2 font-bold ${phase === "checkout" ? "bg-brand-600 text-white" : "bg-white"}`} onClick={() => setPhase("checkout")}>1. 반출 준비</button>
      <button disabled={trade.packing?.phase !== "sealed"} className={`rounded-lg px-4 py-2 font-bold disabled:opacity-40 ${phase === "checkin" ? "bg-checkin-fg text-white" : "bg-white"}`} onClick={() => { setTrade({ ...trade, setupDone: true }); setPhase("checkin"); }}>2. 반납 확인</button>
      <button className="ml-auto text-xs font-bold text-ink-mute" onClick={() => { setTrade(example()); setPhase("checkout"); setSession(session + 1); }}>처음부터</button>
    </div>
    <HandoverChecklist key={session} trade={trade} phase={phase} onPackingCommand={command} preview />
  </main>;
}
