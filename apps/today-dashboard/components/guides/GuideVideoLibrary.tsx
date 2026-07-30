"use client";

import { useEffect, useMemo, useState } from "react";
import type { GuideVideo } from "@/lib/guides/core.mjs";
import { matchesGuideQuery, matchingGuides, sortGuideVideos } from "@/lib/guides/core.mjs";

interface GuideApiResponse {
  success: boolean;
  configured?: boolean;
  guides?: GuideVideo[];
  error?: string;
}

const PUBLIC_GUIDES_URL = "https://www.village6k.co.kr/guide";

function GuideCard({ guide }: { guide: GuideVideo }) {
  const [open, setOpen] = useState(false);
  return (
    <article className={`overflow-hidden rounded-[12px] border bg-white shadow-card ${guide.required ? "border-attention-ring" : "border-line/80"}`}>
      {open ? (
        <div className="aspect-video bg-black">
          <iframe
            src={guide.embedUrl}
            title={guide.title}
            className="h-full w-full"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
            allowFullScreen
          />
        </div>
      ) : (
        <button type="button" onClick={() => setOpen(true)} className="group relative block aspect-video w-full overflow-hidden bg-[#151515] text-left">
          {guide.thumbnailUrl ? (
            <img src={guide.thumbnailUrl} alt="" className="h-full w-full object-cover transition duration-200 group-hover:scale-[1.02]" loading="lazy" />
          ) : null}
          <span className="absolute inset-0 bg-black/15" />
          <span className="absolute left-1/2 top-1/2 flex h-14 w-14 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-brand-600 text-[22px] text-white shadow-pop">
            ▶
          </span>
          <span className="sr-only">{guide.title} 재생</span>
        </button>
      )}
      <div className="p-4">
        <div className="flex flex-wrap items-center gap-1.5">
          {guide.required && <span className="rounded-full bg-attention-bg px-2.5 py-1 text-[11px] font-black text-attention-fg ring-1 ring-attention-ring">필수 확인</span>}
          {guide.equipmentNames.slice(0, 2).map((name) => (
            <span key={name} className="rounded-full bg-paper px-2.5 py-1 text-[11px] font-bold text-ink-mute ring-1 ring-line/70">{name}</span>
          ))}
        </div>
        <h3 className="mt-2.5 text-[16px] font-black leading-snug text-ink">{guide.title}</h3>
        {guide.summary && <p className="mt-1.5 text-[13px] font-semibold leading-relaxed text-ink-mute">{guide.summary}</p>}
        <a href={guide.watchUrl} target="_blank" rel="noopener noreferrer" className="mt-3 inline-flex text-[12px] font-bold text-brand-700 underline decoration-brand-200 underline-offset-4">
          YouTube에서 크게 보기
        </a>
      </div>
    </article>
  );
}

export function GuideVideoLibrary({ mode = "library", equipmentNames = [] }: { mode?: "library" | "reservation"; equipmentNames?: string[] }) {
  const [response, setResponse] = useState<GuideApiResponse | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    let alive = true;
    fetch("/api/guides")
      .then(async (res) => {
        const body = (await res.json().catch(() => null)) as GuideApiResponse | null;
        if (!res.ok || !body) throw new Error(body?.error || `영상 조회 실패 (${res.status})`);
        return body;
      })
      .then((body) => {
        if (alive) setResponse(body);
      })
      .catch((error) => {
        if (alive) setResponse({ success: false, error: error instanceof Error ? error.message : "영상을 불러오지 못했습니다." });
      });
    return () => {
      alive = false;
    };
  }, []);

  const allGuides = useMemo(() => sortGuideVideos(response?.guides ?? []), [response?.guides]);
  const visibleGuides = useMemo(() => {
    if (mode === "reservation") return matchingGuides(allGuides, equipmentNames);
    return allGuides.filter((guide) => matchesGuideQuery(guide, query));
  }, [allGuides, equipmentNames, mode, query]);

  if (mode === "reservation") {
    if (!response || !response.success || !response.configured) return null;
    if (visibleGuides.length === 0) {
      return (
        <a href={PUBLIC_GUIDES_URL} target="_blank" rel="noopener noreferrer" className="tap mt-4 block rounded-[8px] border border-line bg-white px-4 py-3 text-center text-[13px] font-black text-brand-700 shadow-sm">
          장비 사용법 영상 검색
        </a>
      );
    }
    return (
      <section className="mt-4 rounded-[12px] border border-attention-ring bg-attention-bg/45 p-3.5 shadow-card">
        <div className="flex items-start justify-between gap-3 px-1 pb-3">
          <div>
            <h2 className="text-[16px] font-black text-ink">대여 전 꼭 확인하세요</h2>
            <p className="mt-1 text-[12.5px] font-semibold leading-relaxed text-ink-mute">예약 장비의 파손·분실이 잦은 부분만 골랐습니다.</p>
          </div>
          <a href={PUBLIC_GUIDES_URL} target="_blank" rel="noopener noreferrer" className="shrink-0 text-[12px] font-black text-brand-700">홈페이지 검색</a>
        </div>
        <div className="space-y-3">
          {visibleGuides.map((guide) => <GuideCard key={guide.id} guide={guide} />)}
        </div>
      </section>
    );
  }

  return (
    <section>
      <label className="block">
        <span className="sr-only">장비명 또는 문제 검색</span>
        <div className="flex items-center gap-3 rounded-[12px] border border-line bg-white px-4 py-3.5 shadow-card focus-within:border-brand-400 focus-within:ring-2 focus-within:ring-brand-100">
          <span aria-hidden="true" className="text-[18px]">⌕</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="장비명이나 문제를 검색하세요"
            className="min-w-0 flex-1 bg-transparent text-[15px] font-bold text-ink outline-none placeholder:text-ink-faint"
            autoComplete="off"
          />
          {query && <button type="button" onClick={() => setQuery("")} className="rounded-full px-2 py-1 text-[12px] font-bold text-ink-mute">지우기</button>}
        </div>
      </label>

      {!response ? (
        <div className="mt-5 rounded-[12px] border border-line bg-white/80 p-8 text-center text-[14px] font-bold text-ink-mute shadow-card">사용법 영상을 불러오는 중...</div>
      ) : !response.success ? (
        <div className="mt-5 rounded-[12px] border border-attention-ring bg-attention-bg p-6 text-center text-[14px] font-bold text-attention-fg">{response.error || "영상을 불러오지 못했습니다."}</div>
      ) : !response.configured ? (
        <div className="mt-5 rounded-[12px] border border-line bg-white/80 p-8 text-center shadow-card">
          <div className="text-[28px]">🎥</div>
          <p className="mt-2 text-[15px] font-black text-ink">사용법 영상 준비 중입니다</p>
          <p className="mt-1 text-[13px] font-semibold text-ink-mute">영상이 등록되면 이곳에서 바로 검색할 수 있어요.</p>
        </div>
      ) : visibleGuides.length === 0 ? (
        <div className="mt-5 rounded-[12px] border border-line bg-white/80 p-8 text-center shadow-card">
          <p className="text-[15px] font-black text-ink">검색 결과가 없습니다</p>
          <p className="mt-1 text-[13px] font-semibold text-ink-mute">장비 모델명이나 ‘조임쇠’, ‘플레이트’처럼 문제를 바꿔 검색해보세요.</p>
        </div>
      ) : (
        <>
          <div className="mb-3 mt-5 flex items-center justify-between px-1">
            <span className="text-[13px] font-black text-ink">{query ? `검색 결과 ${visibleGuides.length}개` : `전체 영상 ${visibleGuides.length}개`}</span>
            <span className="text-[11px] font-bold text-ink-faint">필수 영상 우선</span>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            {visibleGuides.map((guide) => <GuideCard key={guide.id} guide={guide} />)}
          </div>
        </>
      )}
    </section>
  );
}
