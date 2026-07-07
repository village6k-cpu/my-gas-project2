"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase/client";
import type { PhotoMeta } from "@/lib/domain/types";
import { ChevronLeft, Phone } from "@/components/icons";

// 장비 블랙박스 — "이 장비, 마지막으로 누가 만졌나".
// 파손·분실이 발견됐을 때 최근 대여 타임라인 + 반출/반납 사진 증거 + 반납 검수 기록을
// 한 화면에 모은다. 철저히 읽기 전용 — village.schedule_items / trades 조회만, 어떤 쓰기도 없다.
// (PhotoStrip은 업로드 위젯이라 여기선 쓰지 않는다 — 과거 거래 오업로드 방지)

type ItemRow = {
  schedule_id: string;
  trade_id: string;
  name: string;
  qty: number;
  taken_qty: number | null;
  set_name: string | null;
  is_set_header: boolean;
  memo_checkout: string | null;
  memo_checkin: string | null;
  settlement: string | null;
  checkout_state: string | null;
};

type TradeRow = {
  trade_id: string;
  customer_name: string | null;
  customer_phone: string | null;
  company: string | null;
  checkout_at: string | null;
  return_at: string | null;
  contract_status: string | null;
  return_done: boolean | null;
  return_done_at: string | null;
  note_checkout: string | null;
  note_checkin: string | null;
  photos: PhotoMeta[] | null;
  return_counts: Record<string, { good?: number; damaged?: number; lost?: number; memo?: string }> | null;
};

type TimelineEntry = {
  trade: TradeRow;
  items: ItemRow[];
  damaged: number;
  lost: number;
  memos: { phase: "반출" | "반납"; text: string }[];
};

type DeepStats = { rentals: number; customers: number; yearly: Record<string, number> };

const MAX_TRADES = 40;
// schedule_items 무제한 조회 금지 — PostgREST 기본 상한(1000)에 걸리면 조용히 절단된다.
// created_at desc + limit으로 최신 위주로 가져오고, trade .in() URL 길이도 함께 억제한다.
const MAX_ITEM_ROWS = 500;
const MAX_TRADE_IDS = 120;

const ITEM_SELECT = "schedule_id,trade_id,name,qty,taken_qty,set_name,is_set_header,memo_checkout,memo_checkin,settlement,checkout_state";
const TRADE_SELECT = "trade_id,customer_name,customer_phone,company,checkout_at,return_at,contract_status,return_done,return_done_at,note_checkout,note_checkin,photos,return_counts";

function fmtDate(iso: string | null): string {
  if (!iso) return "?";
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}
function fmtYear(iso: string | null): string {
  if (!iso) return "";
  return `${new Date(iso).getFullYear()}`;
}
// ilike 패턴: %/_ 이스케이프 후 공백 뭉치를 %로 — 대소문자·공백 변형까지 매칭
// (원장 이름과 계약 품목명이 표기만 다른 경우를 구제. 나머지 앱의 normalizeStockName과 같은 취지)
function ilikePattern(name: string): string {
  return name.replace(/[\\%_]/g, (m) => "\\" + m).trim().replace(/\s+/g, "%");
}

export function EquipmentBlackbox({ name, aliases, onClose }: { name: string; aliases: string[]; onClose: () => void }) {
  const [entries, setEntries] = useState<TimelineEntry[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [failed, setFailed] = useState(false);
  const [deep, setDeep] = useState<DeepStats | null>(null);

  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = ""; };
  }, []);

  // 5년 연혁(집계만, 개인정보 없음) — 없으면 조용히 생략
  useEffect(() => {
    fetch("/blackbox-stats.json")
      .then((r) => (r.ok ? r.json() : null))
      .then((m: Record<string, DeepStats> | null) => setDeep(m?.[name] ?? null))
      .catch(() => {});
  }, [name]);

  useEffect(() => {
    let dead = false;
    (async () => {
      const sb = supabase;
      if (!sb) { setFailed(true); return; }
      try {
        const names = [name, ...(aliases || [])].filter(Boolean);
        // 1) 완전일치(인덱스 친화) + 2) 대소문자·공백 변형(ilike) — 최신 위주 limit
        const exactQueries = [
          sb.from("schedule_items").select(ITEM_SELECT).in("name", names).order("created_at", { ascending: false }).limit(MAX_ITEM_ROWS),
          sb.from("schedule_items").select(ITEM_SELECT).in("set_name", names).order("created_at", { ascending: false }).limit(MAX_ITEM_ROWS),
        ];
        const fuzzyQueries = names.flatMap((n) => [
          sb.from("schedule_items").select(ITEM_SELECT).ilike("name", ilikePattern(n)).order("created_at", { ascending: false }).limit(200),
          sb.from("schedule_items").select(ITEM_SELECT).ilike("set_name", ilikePattern(n)).order("created_at", { ascending: false }).limit(200),
        ]);
        const results = await Promise.all([...exactQueries, ...fuzzyQueries]);
        const firstError = results.find((r) => r.error)?.error;
        if (firstError) throw firstError;

        const byId = new Map<string, ItemRow>();
        for (const r of results.flatMap((x) => (x.data || []) as ItemRow[])) {
          if (r.checkout_state === "excluded") continue; // 제외 품목 = 실제로 안 나간 줄
          byId.set(r.schedule_id, r);
        }
        const items = [...byId.values()];
        // created_at desc로 모았으므로 등장 순서가 대략 최신순 — trade .in() URL 폭주 방지 상한
        const tradeIds = [...new Set(items.map((i) => i.trade_id))].slice(0, MAX_TRADE_IDS);
        if (!tradeIds.length) { if (!dead) setEntries([]); return; }

        // 41건째 존재 여부로 절단 판정 — 정확히 40건일 때 '+'가 붙는 오표기 방지
        const { data: trades, error } = await sb
          .from("trades")
          .select(TRADE_SELECT)
          .in("trade_id", tradeIds)
          .order("checkout_at", { ascending: false })
          .limit(MAX_TRADES + 1);
        if (error) throw error;

        const all = (trades as TradeRow[]) || [];
        const cut = all.length > MAX_TRADES || tradeIds.length >= MAX_TRADE_IDS;
        const list: TimelineEntry[] = all.slice(0, MAX_TRADES).map((t) => {
          const mine = items.filter((i) => i.trade_id === t.trade_id);
          let damaged = 0, lost = 0;
          const memos: TimelineEntry["memos"] = [];
          for (const i of mine) {
            const rc = t.return_counts?.[i.schedule_id];
            if (rc) { damaged += rc.damaged || 0; lost += rc.lost || 0; if (rc.memo) memos.push({ phase: "반납", text: rc.memo }); }
            if (i.memo_checkout) memos.push({ phase: "반출", text: i.memo_checkout });
            if (i.memo_checkin) memos.push({ phase: "반납", text: i.memo_checkin });
          }
          return { trade: t, items: mine, damaged, lost, memos };
        });
        if (!dead) { setEntries(list); setTruncated(cut); }
      } catch (e) {
        console.error("[blackbox] 이력 조회 실패", e);
        if (!dead) setFailed(true);
      }
    })();
    return () => { dead = true; };
    // aliases는 호출부에서 원장 행의 배열 그대로 — name 기준으로만 재조회
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name]);

  const stats = useMemo(() => {
    if (!entries) return null;
    const damaged = entries.reduce((s, e) => s + e.damaged, 0);
    const lost = entries.reduce((s, e) => s + e.lost, 0);
    return { trades: entries.length, damaged, lost };
  }, [entries]);

  const scopeLabel = truncated ? `최근 ${MAX_TRADES}건 기준` : null;

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-paper">
      <div className="mx-auto max-w-2xl px-4 pb-16 pt-3">
        <button onClick={onClose} className="tap mb-2 flex items-center gap-1 rounded-full py-1 pr-3 text-[13px] font-bold text-ink-mute">
          <ChevronLeft className="h-4 w-4" /> 재고로
        </button>

        <h2 className="text-[19px] font-extrabold leading-tight text-ink">{name}</h2>
        <p className="mt-0.5 text-[12px] text-ink-mute">
          블랙박스 — 이 장비가 나갔던 거래를 최신순으로. 파손·분실 분쟁 때 사진 증거부터 찾으세요.
        </p>

        {stats && (
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5 text-[12px] font-bold">
            <span className="rounded-full bg-white px-2.5 py-1 ring-1 ring-line">기록 {stats.trades}건{truncated ? "+" : ""}</span>
            {stats.damaged > 0 && <span className="rounded-full bg-warn-bg px-2.5 py-1 text-warn-fg ring-1 ring-warn-ring">파손 {stats.damaged}</span>}
            {stats.lost > 0 && <span className="rounded-full bg-attention-fg/10 px-2.5 py-1 text-attention-fg ring-1 ring-attention-fg/30">분실 {stats.lost}</span>}
            {deep && <span className="rounded-full bg-brand-100 px-2.5 py-1 text-brand-700">5년 {deep.rentals.toLocaleString()}회 · {deep.customers.toLocaleString()}팀</span>}
            {scopeLabel && <span className="text-[11px] font-semibold text-ink-faint">파손/분실 수치는 {scopeLabel}</span>}
          </div>
        )}

        {deep && Object.keys(deep.yearly).length > 1 && (
          <div className="mt-2 flex items-end gap-1 rounded-xl bg-white p-2.5 ring-1 ring-line">
            {Object.entries(deep.yearly).sort(([a], [b]) => a.localeCompare(b)).map(([y, n]) => {
              const max = Math.max(...Object.values(deep.yearly), 1);
              return (
                <div key={y} className="flex flex-1 flex-col items-center gap-0.5">
                  <span className="text-[10px] font-bold tabular-nums text-ink-mute">{n}</span>
                  <div className="w-full rounded-t bg-brand-600/80" style={{ height: `${Math.max(3, (n / max) * 44)}px` }} />
                  <span className="text-[10px] text-ink-faint">{y.slice(2)}년</span>
                </div>
              );
            })}
          </div>
        )}

        {failed && (
          <div className="mt-6 text-center">
            <p className="text-[13px] font-semibold text-ink-mute">이력을 불러오지 못했어요. 잠시 후 다시 열어주세요.</p>
          </div>
        )}
        {!failed && !entries && <p className="mt-6 text-center text-[13px] font-bold text-ink-faint">이력 뒤지는 중...</p>}
        {entries && entries.length === 0 && (
          <p className="mt-6 text-center text-[13px] text-ink-mute">
            헤이빌리 거래 기록엔 아직 이 장비가 없어요.<br />
            <span className="text-[11.5px] text-ink-faint">(원장 별칭과 계약서 품목명이 다르면 재고 탭의 이름연결로 이어주세요)</span>
          </p>
        )}

        <div className="mt-3 space-y-2.5">
          {entries?.map((e) => <TradeCard key={e.trade.trade_id} entry={e} highlightName={name} />)}
        </div>
      </div>
    </div>
  );
}

function TradeCard({ entry, highlightName }: { entry: TimelineEntry; highlightName: string }) {
  const { trade: t, items, damaged, lost, memos } = entry;
  const incident = damaged > 0 || lost > 0 || memos.length > 0;
  const year = fmtYear(t.checkout_at);
  const photos = (t.photos || []).filter((p) => !p.status && (p.thumbnailUrl || p.url));

  return (
    <div className={`rounded-xl bg-white p-3 shadow-card ring-1 ${incident ? "ring-attention-fg/40" : "ring-line"}`}>
      <div className="flex items-baseline justify-between gap-2">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="shrink-0 text-[13px] font-extrabold tabular-nums text-ink">
            {year && <span className="mr-1 text-[11px] font-bold text-ink-faint">{year}</span>}
            {fmtDate(t.checkout_at)}–{fmtDate(t.return_at)}
          </span>
          <span className="truncate text-[13.5px] font-bold text-ink">{t.customer_name || "?"}</span>
          {t.company && <span className="truncate text-[11.5px] text-ink-mute">{t.company}</span>}
        </div>
        <span className="shrink-0 text-[11px] font-semibold text-ink-faint">{t.trade_id}</span>
      </div>

      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11.5px] text-ink-mute">
        {t.customer_phone && (
          <a href={`tel:${t.customer_phone.replace(/-/g, "")}`} className="flex items-center gap-0.5 font-semibold text-brand-700">
            <Phone className="h-3 w-3" />{t.customer_phone}
          </a>
        )}
        <span>{t.return_done ? "반납 완료" : t.contract_status || "진행 중"}</span>
        {items.map((i) => (
          <span key={i.schedule_id} className="rounded bg-paper px-1.5 py-0.5">
            {i.set_name && i.set_name !== i.name && !i.is_set_header ? `[${i.set_name}] ` : ""}
            {i.name === highlightName ? <b>{i.name}</b> : i.name} ×{i.taken_qty ?? i.qty}
            {i.settlement && <b className="ml-1 text-warn-fg">정산 {i.settlement}</b>}
          </span>
        ))}
      </div>

      {(damaged > 0 || lost > 0) && (
        <div className="mt-1.5 text-[12.5px] font-extrabold text-attention-fg">
          이 거래에서 {damaged > 0 ? `파손 ${damaged}` : ""}{damaged > 0 && lost > 0 ? " · " : ""}{lost > 0 ? `분실 ${lost}` : ""}
        </div>
      )}

      {memos.length > 0 && (
        <div className="mt-1.5 space-y-1">
          {memos.map((m, i) => (
            <div key={i} className="rounded-lg bg-warn-bg px-2 py-1 text-[12px] font-semibold leading-snug text-warn-fg ring-1 ring-warn-ring">
              <span className="mr-1 rounded bg-white/60 px-1 text-[10px] font-bold">{m.phase}</span>{m.text}
            </div>
          ))}
        </div>
      )}

      {(t.note_checkout || t.note_checkin) && (
        <p className="mt-1.5 text-[11.5px] leading-snug text-ink-mute">
          {t.note_checkout && <>반출: {t.note_checkout} </>}
          {t.note_checkin && <>반납: {t.note_checkin}</>}
        </p>
      )}

      {/* 읽기 전용 사진 그리드 — PhotoStrip(업로드 위젯) 금지. 탭하면 원본 새 탭 */}
      {photos.length > 0 && (
        <div className="mt-2 grid grid-cols-4 gap-1.5 sm:grid-cols-6">
          {photos.map((p) => (
            <a
              key={p.id}
              href={p.url || p.thumbnailUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="relative block aspect-square overflow-hidden rounded-lg bg-paper ring-1 ring-line/70"
              title={`${p.phase === "checkin" ? "반납" : p.phase === "checkout" ? "반출" : ""} ${p.label || "사진"}`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={p.thumbnailUrl || p.url}
                alt={p.label || "사진"}
                loading="lazy"
                className="h-full w-full object-cover"
                onError={(ev) => { (ev.currentTarget.parentElement as HTMLElement).style.display = "none"; }}
              />
              <span className={`absolute left-1 top-1 rounded px-1 text-[9px] font-bold text-white ${p.phase === "checkin" ? "bg-checkin-fg" : "bg-brand-600"}`}>
                {p.phase === "checkin" ? "반납" : p.phase === "checkout" ? "반출" : "기타"}
              </span>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
