"use client";

import { useState } from "react";
import { buildSeed } from "@/lib/data/seed";
import { persistNotes, persistTrade } from "@/lib/data/remote";
import { syncAll } from "@/lib/data/sync";
import { isSupabase } from "@/lib/supabase/client";
import { ymd } from "@/lib/domain/status";

export default function SeedPage() {
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const add = (s: string) => setLog((l) => [...l, s]);

  const run = async () => {
    // 데모(가짜) 거래를 실 DB에 쓰는 파괴적 동작 — 실수로 오늘 반출 준비를 오염시키지 않도록
    // 반드시 명시적 확인을 받는다. (예전엔 확인 없이 바로 upsert되어 가짜 예약이 오늘일정에 섞였다)
    if (typeof window !== "undefined" &&
        !window.confirm("⚠️ 데모(가짜) 거래를 실제 Supabase에 적재합니다.\n오늘 일정·반출 체크리스트에 가짜 예약이 섞입니다.\n정말 진행할까요? (테스트 목적이 아니면 취소하세요)")) {
      return;
    }
    setBusy(true);
    setLog([]);
    try {
      const { trades, notes } = buildSeed(ymd(new Date()));
      add(`시드 생성: 거래 ${trades.length}건, 메모 ${notes.length}개`);
      for (const t of trades) {
        // 실데이터와 구분되도록 거래ID에 DEMO- 접두. 나중에 필터/정리가 쉬워진다.
        const demoTrade = t.tradeId.startsWith("DEMO-") ? t : { ...t, tradeId: `DEMO-${t.tradeId}` };
        await persistTrade(demoTrade);
        add(`✓ ${demoTrade.tradeId} ${t.customerName} (품목 ${t.equipments.length})`);
      }
      await persistNotes(notes);
      add(`✓ 인수인계 메모 ${notes.length}개`);
      add("완료 — DEMO- 접두 거래로 적재됨. 정리하려면 Supabase에서 trade_id LIKE 'DEMO-%' 삭제.");
    } catch (e) {
      add("오류: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
  };

  const sync = async () => {
    setBusy(true);
    setLog([]);
    try {
      await syncAll(add);
      add("→ 이제 /schedule, / 에서 진짜 예약 + 상태·검수·결제가 보입니다.");
    } catch (e) {
      add("동기화 오류: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-xl p-6">
      <h1 className="text-[18px] font-extrabold text-ink">Supabase 시드 적재</h1>
      <p className="mt-2 text-[13.5px] text-ink-mute">
        Supabase 연결 상태: <b className={isSupabase ? "text-checkin-fg" : "text-attention-fg"}>{isSupabase ? "연결됨" : "환경변수 없음(시드 모드)"}</b>
      </p>
      {!isSupabase && (
        <p className="mt-1 text-[12.5px] text-attention-fg">
          .env.local에 NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY 를 넣고 dev 서버를 재시작하세요.
        </p>
      )}
      <div className="mt-4 flex flex-wrap gap-2">
        <button
          onClick={sync}
          disabled={busy || !isSupabase}
          className="tap rounded-xl bg-brand-600 px-4 py-2.5 text-[14px] font-bold text-white shadow-sm disabled:opacity-40"
        >
          {busy ? "처리 중…" : "시트 → Supabase 동기화 (실데이터)"}
        </button>
        <button
          onClick={run}
          disabled={busy || !isSupabase}
          className="tap rounded-xl bg-line/50 px-4 py-2.5 text-[14px] font-bold text-ink-soft disabled:opacity-40"
        >
          시드(데모) 적재
        </button>
      </div>
      <div className="mt-4 space-y-1 rounded-xl bg-white p-3 text-[12.5px] ring-1 ring-line/70">
        {log.length === 0 ? <span className="text-ink-faint">로그가 여기에 표시됩니다.</span> : log.map((l, i) => <div key={i} className="font-mono text-ink-soft">{l}</div>)}
      </div>
    </div>
  );
}
