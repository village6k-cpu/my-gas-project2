"use client";

import { useEffect, useMemo, useState } from "react";
import { ViewHeader } from "@/components/ViewHeader";
import { Search, Check, ChevronLeft } from "@/components/icons";

// 훈련소 — 신입을 최단시간에 현장 투입 가능하게 만드는 학습 모듈.
// 데이터는 /dojang.json (village-ai 컴파일러가 5년 실데이터에서 생성, 정적).
// 학습 순서 = 5년 대여 빈도순 — 신입이 첫 주에 실제로 만날 확률 순서다.

interface Incident {
  kind: "분실" | "파손" | "실수" | "요령";
  ym: string | null;
  story: string;
  lesson: string;
  quote: string | null;
  equipment: string | null;
}
interface DojangCard {
  id: string;
  name: string;
  category: string;
  image: string | null;
  price: number | null;
  rentals: number | null;
  customers: number | null;
  components: { name: string; qty: number }[];
  checkout: string[];
  return: string[];
  incidents: Incident[];
  companions: { name: string; count: number }[];
}
interface DojangData {
  built_at: string;
  totals: { cards: number; cautions: number; incidents: number; rental_records: number };
  cards: DojangCard[];
  stories: Incident[];
}

const READ_KEY = "dojang.read.v1";
const DRILL_KEY = "dojang.drill.v1";

function loadSet(key: string): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(key) || "[]")); } catch { return new Set(); }
}
function saveSet(key: string, s: Set<string>) {
  try { localStorage.setItem(key, JSON.stringify([...s])); } catch { /* ignore */ }
}

// 날짜 시드 난수 — 팀 전체가 같은 "오늘의 드릴"을 푼다
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function todaySeed() {
  const d = new Date();
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}

type Quiz = { q: string; options: string[]; answer: number; why: string; equipment?: string };

function buildQuizzes(data: DojangData, rand: () => number, n = 10): Quiz[] {
  const cards = data.cards.filter((c) => c.rentals);
  const pool: Quiz[] = [];
  const pick = <T,>(arr: T[]) => arr[Math.floor(rand() * arr.length)];
  const shuffle = <T,>(arr: T[]) => arr.map((v) => [rand(), v] as const).sort((a, b) => a[0] - b[0]).map(([, v]) => v);

  // 1) 구성품 수량 문제
  for (const c of cards.filter((c) => c.components.length >= 3)) {
    const comp = pick(c.components.filter((x) => x.qty >= 1));
    if (!comp) continue;
    const wrongSet = new Set([comp.qty + 1, comp.qty - 1, comp.qty + 2, comp.qty + 3].filter((w) => w >= 1 && w !== comp.qty));
    const wrong = [...wrongSet].slice(0, 3);
    if (wrong.length < 3) continue;
    const options = shuffle([`${comp.qty}개`, ...wrong.map((w) => `${w}개`)]);
    pool.push({
      q: `「${c.name}」 반납이 들어왔다. ${comp.name}은(는) 몇 개여야 할까?`,
      options,
      answer: options.indexOf(`${comp.qty}개`),
      why: `세트마스터 기준 ${comp.name} ×${comp.qty}. 수량이 다르면 그 자리에서 고객에게 확인한다.`,
      equipment: c.name,
    });
  }
  // 2) 반납 체크포인트 문제
  const withReturn = cards.filter((c) => c.return.length > 0);
  for (const c of withReturn) {
    const correct = pick(c.return);
    const others = shuffle(withReturn.filter((x) => x.id !== c.id)).slice(0, 3).map((x) => pick(x.return));
    if (others.length < 3) continue;
    const options = shuffle([correct, ...others]);
    pool.push({
      q: `「${c.name}」 반납 검수 — 이 장비에서 꼭 확인해야 하는 것은?`,
      options,
      answer: options.indexOf(correct),
      why: `실제 사고·지시 기록에서 나온 이 장비의 체크포인트다.`,
      equipment: c.name,
    });
  }
  // 3) 실전 사례 문제
  const storyPool = data.stories.filter((s) => s.lesson && s.story.length > 20);
  for (const s of storyPool) {
    const others = shuffle(storyPool.filter((x) => x !== s && x.lesson !== s.lesson)).slice(0, 3).map((x) => x.lesson);
    if (others.length < 3) continue;
    const options = shuffle([s.lesson, ...others]);
    pool.push({
      q: `실화: ${s.story}\n\n→ 여기서 배울 교훈은?`,
      options,
      answer: options.indexOf(s.lesson),
      why: s.quote ? `사장님: "${s.quote}"` : "5년 기록에 실제로 있었던 일이다.",
      equipment: s.equipment ?? undefined,
    });
  }
  return shuffle(pool).slice(0, n);
}

export function DojangView() {
  const [data, setData] = useState<DojangData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<"cards" | "drill" | "stories">("cards");
  const [read, setRead] = useState<Set<string>>(new Set());

  useEffect(() => {
    setRead(loadSet(READ_KEY));
    fetch("/dojang.json")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setData)
      .catch((e) => setErr(String(e?.message || e)));
  }, []);

  const markRead = (id: string) => {
    setRead((prev) => {
      const n = new Set(prev); n.add(id); saveSet(READ_KEY, n); return n;
    });
  };

  if (err) return <div className="p-6 text-[13px] text-ink-mute">훈련소 데이터를 못 불러왔어요: {err}</div>;
  if (!data) return <div className="flex min-h-[50vh] items-center justify-center text-[14px] font-bold text-ink-faint">훈련소 여는 중...</div>;

  return (
    <div className="mx-auto max-w-2xl pb-24 lg:pb-8">
      <ViewHeader title="훈련소" />
      <div className="px-4">
        <div className="mb-1 flex items-baseline justify-between">
          <h1 className="text-[22px] font-extrabold tracking-tight text-ink">훈련소</h1>
          <span className="text-[11.5px] text-ink-faint">대여기록 {data.totals.rental_records.toLocaleString()}건에서 배운다</span>
        </div>
        <p className="mb-3 text-[12.5px] leading-relaxed text-ink-mute">
          장비 도감은 <b className="text-ink">현장에서 만날 확률 순서</b>예요. 위에서부터 읽으면 첫 주 준비 끝.
        </p>

        {/* 진행도 */}
        <Progress read={read.size} total={data.cards.length} />

        {/* 탭 */}
        <div className="mb-3 mt-3 flex overflow-hidden rounded-xl ring-1 ring-line">
          {([["cards", "장비 도감"], ["drill", "오늘의 드릴"], ["stories", "실전 사례집"]] as const).map(([k, label]) => (
            <button
              key={k}
              onClick={() => setTab(k)}
              className={`tap flex-1 py-2.5 text-[13px] font-bold ${tab === k ? "bg-brand-600 text-white" : "bg-white text-ink-mute"}`}
            >
              {label}
            </button>
          ))}
        </div>

        {tab === "cards" && <CardList data={data} read={read} onRead={markRead} />}
        {tab === "drill" && <Drill data={data} />}
        {tab === "stories" && <Stories stories={data.stories} />}
      </div>
    </div>
  );
}

function Progress({ read, total }: { read: number; total: number }) {
  const pct = total ? Math.round((read / total) * 100) : 0;
  return (
    <div className="rounded-xl bg-white p-3 shadow-card ring-1 ring-line">
      <div className="flex items-baseline justify-between text-[12px]">
        <span className="font-bold text-ink">도감 학습 진행</span>
        <span className="tabular-nums text-ink-mute">{read}/{total} · {pct}%</span>
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-line/40">
        <div className="h-full rounded-full bg-brand-600 transition-all" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/* ── 장비 도감 ── */
function CardList({ data, read, onRead }: { data: DojangData; read: Set<string>; onRead: (id: string) => void }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<DojangCard | null>(null);
  const items = useMemo(() => {
    const needle = q.trim().toLowerCase().replace(/\s+/g, "");
    return data.cards.filter((c) => !needle || c.name.toLowerCase().replace(/\s+/g, "").includes(needle));
  }, [data.cards, q]);

  return (
    <div>
      <div className="relative mb-2">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="장비 검색 (예: FX3, 어퓨쳐)"
          className="w-full rounded-xl border border-line bg-white py-2.5 pl-9 pr-3 text-[14px] outline-none placeholder:text-ink-faint focus:border-brand-500"
        />
      </div>
      <ul className="space-y-1.5">
        {items.map((c, i) => (
          <li key={c.id}>
            <button
              onClick={() => { setOpen(c); onRead(c.id); }}
              className="tap flex w-full items-center gap-3 rounded-xl bg-white p-2.5 text-left shadow-card ring-1 ring-line"
            >
              <span className="w-6 shrink-0 text-center text-[12px] font-bold tabular-nums text-ink-faint">{i + 1}</span>
              <Thumb card={c} size={44} />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className="truncate text-[13.5px] font-bold text-ink">{c.name}</span>
                  {read.has(c.id) && <Check className="h-3.5 w-3.5 shrink-0 text-checkin-fg" />}
                </span>
                <span className="text-[11.5px] text-ink-mute">
                  {c.rentals ? `5년간 ${c.rentals.toLocaleString()}회 대여` : c.category}
                  {c.incidents.length > 0 && <span className="ml-1.5 font-bold text-attention-fg">사고기록 {c.incidents.length}</span>}
                </span>
              </span>
              <span className="text-[11px] font-bold text-ink-faint">
                체크 {c.checkout.length + c.return.length}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {open && <CardDetail card={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function Thumb({ card, size }: { card: DojangCard; size: number }) {
  return (
    <span className="flex shrink-0 items-center justify-center overflow-hidden rounded-lg bg-paper ring-1 ring-line/60" style={{ width: size, height: size }}>
      {card.image ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={card.image} alt="" loading="lazy" className="h-full w-full object-contain mix-blend-multiply" />
      ) : (
        <span className="text-ink-faint">📷</span>
      )}
    </span>
  );
}

function CardDetail({ card, onClose }: { card: DojangCard; onClose: () => void }) {
  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = ""; };
  }, []);
  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-paper">
      <div className="mx-auto max-w-2xl px-4 pb-16 pt-3">
        <button onClick={onClose} className="tap mb-2 flex items-center gap-1 rounded-full py-1 pr-3 text-[13px] font-bold text-ink-mute">
          <ChevronLeft className="h-4 w-4" /> 도감으로
        </button>

        <div className="flex items-start gap-3">
          <Thumb card={card} size={84} />
          <div className="min-w-0 flex-1">
            <h2 className="text-[18px] font-extrabold leading-tight text-ink">{card.name}</h2>
            <p className="mt-0.5 text-[12px] text-ink-mute">
              {card.category}
              {card.price ? ` · ${card.price.toLocaleString()}원/일` : ""}
            </p>
            {card.rentals && (
              <p className="mt-1 inline-block rounded-full bg-brand-100 px-2 py-0.5 text-[11.5px] font-bold text-brand-700">
                5년간 {card.rentals.toLocaleString()}회 · 고객 {card.customers?.toLocaleString() ?? "?"}명
              </p>
            )}
          </div>
        </div>

        {card.components.length > 0 && (
          <Section title={`구성품 ${card.components.length}종 — 반납 때 전부 세어본다`}>
            <ul className="divide-y divide-line/60 overflow-hidden rounded-xl bg-white ring-1 ring-line">
              {card.components.map((c) => (
                <li key={c.name} className="flex items-center justify-between px-3 py-2 text-[13px]">
                  <span className="text-ink">{c.name}</span>
                  <span className="font-bold tabular-nums text-ink">×{c.qty}</span>
                </li>
              ))}
            </ul>
          </Section>
        )}

        {card.checkout.length > 0 && (
          <Section title="반출 전 체크">
            <ChecklistBox items={card.checkout} tone="out" />
          </Section>
        )}
        {card.return.length > 0 && (
          <Section title="반납 검수 체크">
            <ChecklistBox items={card.return} tone="in" />
          </Section>
        )}

        {card.incidents.length > 0 && (
          <Section title="이 장비에서 실제로 있었던 일">
            <div className="space-y-2">
              {card.incidents.map((s, i) => <StoryCard key={i} s={s} compact />)}
            </div>
          </Section>
        )}

        {card.companions.length > 0 && (
          <Section title="같이 나가는 경우가 많은 장비 — 반출 때 함께 챙길 것">
            <div className="flex flex-wrap gap-1.5">
              {card.companions.map((c) => (
                <span key={c.name} className="rounded-full bg-white px-2.5 py-1 text-[12px] text-ink ring-1 ring-line">
                  {c.name} <b className="text-brand-700">{c.count}회</b>
                </span>
              ))}
            </div>
          </Section>
        )}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-4">
      <h3 className="mb-1.5 text-[12.5px] font-extrabold text-ink-soft">{title}</h3>
      {children}
    </div>
  );
}

function ChecklistBox({ items, tone }: { items: string[]; tone: "out" | "in" }) {
  return (
    <ul className="space-y-1.5">
      {items.map((t, i) => (
        <li key={i} className={`flex items-start gap-2 rounded-xl px-3 py-2 text-[13px] leading-snug ring-1 ${tone === "in" ? "bg-warn-bg text-warn-fg ring-warn-ring" : "bg-white text-ink ring-line"}`}>
          <span className="mt-0.5 shrink-0 text-[11px] font-black">{tone === "in" ? "✓" : "→"}</span>
          <span>{t}</span>
        </li>
      ))}
    </ul>
  );
}

/* ── 오늘의 드릴 ── */
function Drill({ data }: { data: DojangData }) {
  const [session, setSession] = useState<Quiz[] | null>(null);
  const [idx, setIdx] = useState(0);
  const [picked, setPicked] = useState<number | null>(null);
  const [score, setScore] = useState(0);
  const [history, setHistory] = useState<{ d: string; score: number; total: number }[]>([]);

  useEffect(() => {
    try { setHistory(JSON.parse(localStorage.getItem(DRILL_KEY) || "[]")); } catch { /* ignore */ }
  }, []);

  const start = () => {
    const rand = mulberry32(todaySeed());
    setSession(buildQuizzes(data, rand, 10));
    setIdx(0); setPicked(null); setScore(0);
  };

  if (!session) {
    const today = new Date().toISOString().slice(0, 10);
    const doneToday = history.find((h) => h.d === today);
    return (
      <div className="rounded-xl bg-white p-4 text-center shadow-card ring-1 ring-line">
        <div className="text-[15px] font-extrabold text-ink">오늘의 드릴 10문제</div>
        <p className="mt-1 text-[12.5px] leading-relaxed text-ink-mute">
          구성품 수량 · 반납 체크포인트 · 실전 사례.<br />
          문제는 매일 바뀌고, 오늘은 팀 전체가 같은 문제를 풀어요.
        </p>
        {doneToday && (
          <p className="mt-2 text-[12.5px] font-bold text-brand-700">오늘 기록: {doneToday.score}/{doneToday.total}</p>
        )}
        <button onClick={start} className="tap mt-3 rounded-xl bg-brand-600 px-6 py-2.5 text-[14px] font-extrabold text-white">
          {doneToday ? "다시 풀기" : "시작"}
        </button>
        {history.length > 0 && (
          <div className="mt-3 border-t border-line/60 pt-2 text-[11.5px] text-ink-faint">
            최근: {history.slice(-5).map((h) => `${h.score}/${h.total}`).join(" · ")}
          </div>
        )}
      </div>
    );
  }

  if (idx >= session.length) {
    return (
      <div className="rounded-xl bg-white p-5 text-center shadow-card ring-1 ring-line">
        <div className="text-[28px] font-extrabold text-ink">{score} / {session.length}</div>
        <p className="mt-1 text-[13px] text-ink-mute">
          {score === session.length ? "만점 — 현장 투입 준비 완료 💪" : score >= 7 ? "좋아요. 틀린 장비 도감만 다시 보면 끝." : "도감 위에서부터 다시 한 번 — 만날 확률 순이에요."}
        </p>
        <button
          onClick={() => {
            const today = new Date().toISOString().slice(0, 10);
            const next = [...history.filter((h) => h.d !== today), { d: today, score, total: session.length }];
            setHistory(next);
            try { localStorage.setItem(DRILL_KEY, JSON.stringify(next.slice(-30))); } catch { /* ignore */ }
            setSession(null);
          }}
          className="tap mt-3 rounded-xl bg-brand-600 px-6 py-2.5 text-[14px] font-extrabold text-white"
        >
          기록 저장
        </button>
      </div>
    );
  }

  const quiz = session[idx];
  return (
    <div className="rounded-xl bg-white p-4 shadow-card ring-1 ring-line">
      <div className="mb-2 flex items-center justify-between text-[11.5px] font-bold text-ink-faint">
        <span>문제 {idx + 1} / {session.length}</span>
        <span className="tabular-nums">맞힘 {score}</span>
      </div>
      <p className="whitespace-pre-line text-[14px] font-bold leading-relaxed text-ink">{quiz.q}</p>
      <div className="mt-3 space-y-1.5">
        {quiz.options.map((opt, i) => {
          const state = picked == null ? "idle" : i === quiz.answer ? "right" : i === picked ? "wrong" : "dim";
          return (
            <button
              key={i}
              disabled={picked != null}
              onClick={() => { setPicked(i); if (i === quiz.answer) setScore((s) => s + 1); }}
              className={`tap w-full rounded-xl px-3 py-2.5 text-left text-[13.5px] leading-snug ring-1 transition-colors ${
                state === "right" ? "bg-checkin-fg font-bold text-white ring-checkin-fg"
                : state === "wrong" ? "bg-attention-fg/10 text-attention-fg ring-attention-fg/40"
                : state === "dim" ? "bg-white text-ink-faint ring-line"
                : "bg-white text-ink ring-line active:bg-paper"
              }`}
            >
              {opt}
            </button>
          );
        })}
      </div>
      {picked != null && (
        <div className="mt-3 rounded-xl bg-paper p-3 text-[12.5px] leading-relaxed text-ink-soft">
          {quiz.why}
          <button onClick={() => { setIdx((i) => i + 1); setPicked(null); }} className="tap mt-2 block w-full rounded-lg bg-brand-600 py-2 text-center text-[13px] font-extrabold text-white">
            다음
          </button>
        </div>
      )}
    </div>
  );
}

/* ── 실전 사례집 ── */
function Stories({ stories }: { stories: Incident[] }) {
  const [kind, setKind] = useState<"전체" | "분실" | "파손" | "실수" | "요령">("전체");
  const list = stories.filter((s) => kind === "전체" || s.kind === kind);
  return (
    <div>
      <div className="mb-2 flex gap-1.5">
        {(["전체", "분실", "파손", "실수", "요령"] as const).map((k) => (
          <button
            key={k}
            onClick={() => setKind(k)}
            className={`tap rounded-full px-3 py-1.5 text-[12px] font-bold ring-1 ${kind === k ? "bg-brand-600 text-white ring-brand-600" : "bg-white text-ink-mute ring-line"}`}
          >
            {k}
          </button>
        ))}
      </div>
      <div className="space-y-2">
        {list.map((s, i) => <StoryCard key={i} s={s} />)}
        {!list.length && <p className="py-8 text-center text-[13px] text-ink-faint">이 분류엔 아직 사례가 없어요.</p>}
      </div>
    </div>
  );
}

const KIND_STYLE: Record<string, string> = {
  분실: "bg-attention-fg/10 text-attention-fg",
  파손: "bg-warn-bg text-warn-fg",
  실수: "bg-brand-100 text-brand-700",
  요령: "bg-checkin-fg/10 text-checkin-fg",
};

function StoryCard({ s, compact = false }: { s: Incident; compact?: boolean }) {
  return (
    <div className="rounded-xl bg-white p-3 shadow-card ring-1 ring-line">
      <div className="mb-1 flex items-center gap-1.5 text-[11px] font-bold">
        <span className={`rounded px-1.5 py-0.5 ${KIND_STYLE[s.kind] || "bg-line/40 text-ink-mute"}`}>{s.kind}</span>
        {!compact && s.equipment && <span className="truncate text-ink-mute">{s.equipment}</span>}
        {s.ym && <span className="ml-auto shrink-0 font-medium text-ink-faint">{s.ym}</span>}
      </div>
      <p className="text-[13px] leading-relaxed text-ink">{s.story}</p>
      <p className="mt-1.5 text-[12.5px] font-bold leading-snug text-brand-700">→ {s.lesson}</p>
      {s.quote && (
        <p className="mt-1.5 rounded-lg bg-paper px-2.5 py-1.5 text-[12px] italic leading-relaxed text-ink-soft">
          사장님: "{s.quote}"
        </p>
      )}
    </div>
  );
}
