"use client";

import { useState } from "react";
import { gasRead } from "@/lib/data/writeback";
import { Doc } from "./icons";

type MyPageLinkResponse = {
  success?: boolean;
  error?: string;
  result?: { success?: boolean; error?: string; url?: string };
  url?: string;
};

function myPageUrlFromResponse(res: MyPageLinkResponse) {
  const result = res?.result || res;
  const url = String(result?.url || "").trim();
  if (!url) throw new Error(result?.error || res?.error || "내 예약 링크를 받지 못했습니다");
  if (!/^https?:\/\//i.test(url) && !url.startsWith("/my?")) throw new Error("내 예약 링크 형식이 올바르지 않습니다");
  return url;
}

async function fetchMyPageUrl(tradeId: string) {
  const res = (await gasRead("run", { func: "getMyPageLink", args: tradeId })) as MyPageLinkResponse;
  return myPageUrlFromResponse(res);
}

export function MyReservationLinkButton({ tradeId, compact = false }: { tradeId: string; compact?: boolean }) {
  const [opening, setOpening] = useState(false);

  return (
    <button
      type="button"
      disabled={opening}
      onClick={() => {
        if (opening) return;
        const tab = window.open("about:blank", "_blank");
        setOpening(true);
        fetchMyPageUrl(tradeId)
          .then((url) => {
            if (tab) tab.location.href = url;
            else window.open(url, "_blank", "noopener");
          })
          .catch((err) => {
            if (tab) tab.close();
            window.alert("내 예약 링크 열기 실패: " + (err instanceof Error ? err.message : String(err)));
          })
          .finally(() => setOpening(false));
      }}
      className={
        compact
          ? "tap inline-flex h-9 items-center gap-1.5 rounded-full bg-brand-50 px-3 text-[12px] font-black text-brand-700 ring-1 ring-brand-200 disabled:bg-paper disabled:text-ink-faint disabled:ring-line/70"
          : "tap inline-flex items-center gap-1.5 rounded-lg bg-brand-50 px-3 py-2 text-[13px] font-bold text-brand-700 ring-1 ring-brand-200 disabled:bg-paper disabled:text-ink-faint disabled:ring-line/70"
      }
      aria-label="고객 내 예약 페이지 열기"
    >
      <Doc className="h-3.5 w-3.5" />
      {opening ? "여는 중…" : compact ? "내예약" : "내예약 열기"}
    </button>
  );
}
