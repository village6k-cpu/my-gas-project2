"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { supabase } from "@/lib/supabase/client";
import { authFetch } from "@/lib/data/authFetch";
import { ChevronLeft, Phone } from "@/components/icons";

// 고객 카드 — "이 사람 누구지?"를 3초 안에.
// 5년 프로필(단골 등급/연도별/장비 취향/미수 의심 — 인증 API)과
// 헤이빌리 라이브 거래(파손·분실·결제경고 이력)를 한 장에 모은다. 읽기 전용.

type ReceivableCase = { date: string; equipment: string; status: string; basis: string };
type Profile = {
  name: string;
  rentals_5y: number | null;
  sessions_5y: number | null;
  days_5y: number | null;
  first_use: string | null;
  last_use: string | null;
  top_equipment: { name: string; count: number }[];
  tier: string | null;
  status: string | null;
  coupon: string | null;
  total_rentals_88: number | null;
  yearly: Record<string, number> | null;
  recent_6m: number | null;
  receivable_count: number;
  receivable_cases: ReceivableCase[];
};

type LiveTrade = {
  trade_id: string;
  checkout_at: string | null;
  return_at: string | null;
  contract_status: string | null;
  return_done: boolean | null;
  amount: number | null;
  payment_warning: boolean | null;
  return_counts: Record<string, { good?: number; damaged?: number; lost?: number; memo?: string }> | null;
};

const TIER_STYLE: Record<string, string> = {
  S_슈퍼단골: "bg-brand-600 text-white",
  A_단골: "bg-brand-100 text-brand-700",
  B_일반: "bg-line/40 text-ink-soft",
};

function tierLabel(tier: string | null): string | null {
  if (!tier) return null;
  return tier.replace(/^[A-Z]_/, "");
}
function fmtDate(iso: string | null): string {
  if (!iso) return "?";
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export function CustomerSheet({ name, phone, onClose }: { name: string; phone?: string | null; onClose: () => void }) {
  // "failed"(401/5xx/네트워크)와 null(정말 기록 없음)을 절대 섞지 않는다 —
  // 토큰 만료를 '신규 고객'으로 오표시하면 미수 경고가 무음 소실되기 때문.
  const [profile, setProfile] = useState<Profile | null | "loading" | "failed">("loading");
  const [live, setLive] = useState<LiveTrade[] | null | "failed">(null);

  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = ""; };
  }, []);

  useEffect(() => {
    let dead = false;
    authFetch(`/api/customer?name=${encodeURIComponent(name)}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((d) => { if (!dead) setProfile(d?.found ? (d.profile as Profile) : null); })
      .catch((e) => {
        console.error("[customer] 프로필 조회 실패", e);
        if (!dead) setProfile("failed");
      });

    const sb = supabase;
    if (sb) {
      sb.from("trades")
        .select("trade_id,checkout_at,return_at,contract_status,return_done,amount,payment_warning,return_counts")
        .eq("customer_name", name)
        .order("checkout_at", { ascending: false })
        .limit(12)
        .then(({ data, error }) => {
          if (dead) return;
          if (error) { console.error("[customer] 라이브 이력 조회 실패", error); setLive("failed"); }
          else setLive((data as LiveTrade[]) || []);
        });
    } else setLive("failed");
    return () => { dead = true; };
  }, [name]);

  const liveStats = useMemo(() => {
    if (!live || live === "failed") return null;
    let damaged = 0, lost = 0, warns = 0;
    for (const t of live) {
      if (t.payment_warning) warns += 1;
      for (const rc of Object.values(t.return_counts || {})) { damaged += rc.damaged || 0; lost += rc.lost || 0; }
    }
    return { damaged, lost, warns };
  }, [live]);

  const p = profile === "loading" || profile === "failed" ? null : profile;
  const tier = p ? tierLabel(p.tier) : null;

  if (typeof document === "undefined") return null;
  // 포털 필수 — 카드 내부(done 카드 opacity-75) 마운트 시 시트가 반투명해지고 탭바 아래에 깔린다
  return createPortal(
    <div className="fixed inset-0 z-50 overflow-y-auto bg-paper">
      <div className="mx-auto max-w-2xl px-4 pb-16 pt-3">
        <button onClick={onClose} className="tap mb-2 flex items-center gap-1 rounded-full py-1 pr-3 text-[13px] font-bold text-ink-mute">
          <ChevronLeft className="h-4 w-4" /> 닫기
        </button>

        <div className="flex items-baseline justify-between gap-2">
          <h2 className="text-[20px] font-extrabold leading-tight text-ink">{name}</h2>
          {phone && (
            <a href={`tel:${phone.replace(/-/g, "")}`} className="flex shrink-0 items-center gap-1 text-[13px] font-bold text-brand-700">
              <Phone className="h-3.5 w-3.5" />{phone}
            </a>
          )}
        </div>
        <p className="mt-0.5 text-[10.5px] text-ink-faint">아래 기록은 이름 일치 기준 — 동명이인이 섞일 수 있어요.</p>

        {p && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[12px] font-bold">
            {tier && <span className={`rounded-full px-2.5 py-1 ${TIER_STYLE[p.tier!] || "bg-line/40 text-ink-soft"}`}>{tier}</span>}
            {p.status && <span className="rounded-full bg-white px-2.5 py-1 ring-1 ring-line">{p.status.replace("✅ ", "")}</span>}
            {p.coupon && <span className="rounded-full bg-checkin-fg/10 px-2.5 py-1 text-checkin-fg ring-1 ring-checkin-fg/30">{p.coupon}</span>}
          </div>
        )}

        {/* 미수 의심 — 예약/응대 전에 봐야 하는 경고 */}
        {p && p.receivable_count > 0 && (
          <div className="mt-2.5 rounded-xl bg-attention-fg/10 p-3 ring-1 ring-attention-fg/30">
            <div className="text-[13px] font-extrabold text-attention-fg">미수 의심 {p.receivable_count}건 — 응대 전 확인</div>
            {p.receivable_cases.map((c, i) => (
              <div key={i} className="mt-1 text-[12px] leading-snug text-ink-soft">
                <b className="tabular-nums">{c.date}</b> {c.equipment.slice(0, 40)} — {c.basis}
              </div>
            ))}
            <div className="mt-1 text-[10.5px] text-ink-faint">2026-07 재무기록 대조 기준 의심 건 — 입금 확인되면 무시하세요.</div>
          </div>
        )}

        {profile === "loading" && <p className="mt-6 text-center text-[13px] font-bold text-ink-faint">프로필 찾는 중...</p>}
        {profile === "failed" && (
          <p className="mt-4 rounded-xl bg-warn-bg p-3 text-[12.5px] font-semibold text-warn-fg ring-1 ring-warn-ring">
            프로필을 불러오지 못했어요 — 기록이 없다는 뜻이 아니에요. 다시 열어보고, 계속 안 되면 재로그인해 주세요.
          </p>
        )}
        {profile === null && (
          <p className="mt-4 rounded-xl bg-white p-3 text-[12.5px] text-ink-mute ring-1 ring-line">
            5년 기록엔 없는 이름이에요 — 신규 고객이거나 표기가 다를 수 있어요.
          </p>
        )}

        {p && (
          <>
            <div className="mt-3 grid grid-cols-3 gap-1.5 text-center">
              <StatBox label="5년 대여" value={p.total_rentals_88 ?? p.rentals_5y} suffix="회" />
              <StatBox label="촬영 세션" value={p.sessions_5y} suffix="회" />
              <StatBox label="최근 6개월" value={p.recent_6m} suffix="회" />
            </div>
            {p.first_use && p.last_use && (
              <p className="mt-1 text-right text-[10.5px] text-ink-faint">{p.first_use} 첫 방문 · {p.last_use} 마지막</p>
            )}

            {p.yearly && Object.keys(p.yearly).length > 1 && (
              <div className="mt-2 flex items-end gap-1 rounded-xl bg-white p-2.5 ring-1 ring-line">
                {Object.entries(p.yearly).sort(([a], [b]) => a.localeCompare(b)).map(([y, n]) => {
                  const max = Math.max(...Object.values(p.yearly!), 1);
                  return (
                    <div key={y} className="flex flex-1 flex-col items-center gap-0.5">
                      <span className="text-[10px] font-bold tabular-nums text-ink-mute">{n}</span>
                      <div className="w-full rounded-t bg-brand-600/80" style={{ height: `${Math.max(3, (n / max) * 40)}px` }} />
                      <span className="text-[10px] text-ink-faint">{y.slice(2)}년</span>
                    </div>
                  );
                })}
              </div>
            )}

            {p.top_equipment.length > 0 && (
              <div className="mt-3">
                <h3 className="mb-1.5 text-[12.5px] font-extrabold text-ink-soft">즐겨 쓰는 장비 — 대화가 빨라져요</h3>
                <div className="flex flex-wrap gap-1.5">
                  {p.top_equipment.map((e) => (
                    <span key={e.name} className="rounded-full bg-white px-2.5 py-1 text-[12px] text-ink ring-1 ring-line">
                      {e.name} <b className="text-brand-700">{e.count}회</b>
                    </span>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {/* 헤이빌리 라이브 거래 */}
        <div className="mt-4">
          <h3 className="mb-1.5 flex items-baseline justify-between text-[12.5px] font-extrabold text-ink-soft">
            <span>최근 거래 (헤이빌리 기록)</span>
            {liveStats && (liveStats.damaged > 0 || liveStats.lost > 0 || liveStats.warns > 0) && (
              <span className="text-[11.5px] font-bold text-attention-fg">
                {liveStats.damaged > 0 ? `파손 ${liveStats.damaged} ` : ""}{liveStats.lost > 0 ? `분실 ${liveStats.lost} ` : ""}{liveStats.warns > 0 ? `결제경고 ${liveStats.warns}` : ""}
              </span>
            )}
          </h3>
          {!live && <p className="text-[12.5px] text-ink-faint">불러오는 중...</p>}
          {live === "failed" && <p className="rounded-xl bg-warn-bg p-3 text-[12.5px] font-semibold text-warn-fg ring-1 ring-warn-ring">최근 거래를 불러오지 못했어요 — 기록이 없다는 뜻이 아니에요.</p>}
          {live && live !== "failed" && live.length === 0 && <p className="rounded-xl bg-white p-3 text-[12.5px] text-ink-mute ring-1 ring-line">헤이빌리 기록엔 아직 없어요.</p>}
          {live && live !== "failed" && live.length > 0 && (
            <ul className="divide-y divide-line/60 overflow-hidden rounded-xl bg-white ring-1 ring-line">
              {live.map((t) => {
                let damaged = 0, lost = 0;
                for (const rc of Object.values(t.return_counts || {})) { damaged += rc.damaged || 0; lost += rc.lost || 0; }
                return (
                  <li key={t.trade_id} className="flex items-baseline justify-between gap-2 px-3 py-2 text-[12.5px]">
                    <span className="shrink-0 font-bold tabular-nums text-ink">{fmtDate(t.checkout_at)}–{fmtDate(t.return_at)}</span>
                    <span className="min-w-0 flex-1 truncate text-ink-mute">
                      {t.return_done ? "반납 완료" : t.contract_status || ""}
                      {damaged > 0 && <b className="ml-1 text-attention-fg">파손 {damaged}</b>}
                      {lost > 0 && <b className="ml-1 text-attention-fg">분실 {lost}</b>}
                      {t.payment_warning && <b className="ml-1 text-warn-fg">결제경고</b>}
                    </span>
                    <span className="shrink-0 tabular-nums text-ink-soft">{t.amount ? `${t.amount.toLocaleString()}원` : ""}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function StatBox({ label, value, suffix }: { label: string; value: number | null; suffix: string }) {
  return (
    <div className="rounded-xl bg-white p-2.5 ring-1 ring-line">
      <div className="text-[17px] font-extrabold tabular-nums text-ink">{value != null ? value.toLocaleString() : "—"}<span className="text-[11px] font-bold text-ink-faint">{value != null ? suffix : ""}</span></div>
      <div className="text-[10.5px] text-ink-faint">{label}</div>
    </div>
  );
}
