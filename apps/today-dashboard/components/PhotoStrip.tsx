"use client";

import { useState } from "react";
import type { PhotoMeta } from "@/lib/domain/types";
import { Camera } from "./icons";

export function PhotoStrip({ photos }: { photos: PhotoMeta[] }) {
  const [open, setOpen] = useState(false);
  const checkout = photos.filter((p) => p.phase === "checkout");
  const checkin = photos.filter((p) => p.phase === "checkin");

  return (
    <>
      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="tap inline-flex items-center gap-1.5 rounded-lg bg-black/[0.04] px-2.5 py-1.5 text-[12.5px] font-semibold text-ink-soft ring-1 ring-black/5"
        >
          <Camera className="h-4 w-4" />
          사진
          <span className="text-ink-faint">
            반출 {checkout.length} · 반납 {checkin.length}
          </span>
        </button>
        <div className="flex -space-x-2">
          {photos.slice(0, 4).map((p) => (
            <span
              key={p.id}
              className="h-7 w-7 rounded-md ring-2 ring-white"
              style={{ background: p.swatch }}
              aria-label={p.label}
            />
          ))}
        </div>
      </div>

      {open && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center" onClick={() => setOpen(false)}>
          <div
            className="animate-pop max-h-[80vh] w-full max-w-md overflow-y-auto rounded-t-2xl bg-white p-4 shadow-pop sm:rounded-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-[15px] font-bold">반출/반납 사진</h3>
              <button onClick={() => setOpen(false)} className="tap rounded-lg px-2 py-1 text-ink-mute">닫기</button>
            </div>
            {(["checkout", "checkin", "other"] as const).map((ph) => {
              const ps = photos.filter((p) => p.phase === ph);
              if (!ps.length) return null;
              return (
                <div key={ph} className="mb-3">
                  <div className="mb-1.5 text-[12px] font-semibold text-ink-mute">
                    {ph === "checkout" ? "반출" : ph === "checkin" ? "반납" : "기타"}
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    {ps.map((p) => (
                      <div
                        key={p.id}
                        className="flex aspect-square items-end rounded-xl p-2 text-[11px] font-semibold text-white/90"
                        style={{ background: p.swatch }}
                      >
                        {p.label}
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
            <button className="tap mt-1 flex w-full items-center justify-center gap-2 rounded-xl border-2 border-dashed border-black/15 py-3 text-[13px] font-semibold text-ink-mute">
              <Camera className="h-4 w-4" /> 사진 추가 (촬영/업로드)
            </button>
          </div>
        </div>
      )}
    </>
  );
}
