"use client";

import { useEffect, useRef, useState } from "react";
import type { Phase, PhotoMeta } from "@/lib/domain/types";
import { refreshTradePhotos, uploadTradePhoto } from "@/lib/data/store";
import { Camera } from "./icons";

const PHASES: Phase[] = ["checkout", "checkin"];

function phaseTitle(phase: Phase | "other"): string {
  return phase === "checkout" ? "반출" : phase === "checkin" ? "반납" : "기타";
}

function PhotoTile({ photo }: { photo: PhotoMeta }) {
  const src = photo.thumbnailUrl || photo.url;
  if (src) {
    return (
      <a href={photo.url || src} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-xl bg-black/[0.04] ring-1 ring-black/10">
        <img src={src} alt={photo.label} className="aspect-square w-full object-cover" loading="lazy" />
      </a>
    );
  }
  return (
    <div
      className="flex aspect-square items-end rounded-xl p-2 text-[11px] font-semibold text-white/90"
      style={{ background: photo.swatch }}
    >
      {photo.label}
    </div>
  );
}

export function PhotoStrip({ tradeId, photos }: { tradeId: string; photos: PhotoMeta[] }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState<Phase | null>(null);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const nextPhaseRef = useRef<Phase>("checkout");

  const checkout = photos.filter((p) => p.phase === "checkout");
  const checkin = photos.filter((p) => p.phase === "checkin");

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setLoading(true);
    setError("");
    refreshTradePhotos(tradeId)
      .catch((err) => {
        if (alive) setError(err instanceof Error ? err.message : "사진을 불러오지 못했습니다");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [open, tradeId]);

  const pickPhoto = (phase: Phase) => {
    nextPhaseRef.current = phase;
    inputRef.current?.click();
  };

  const onFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;

    const nextPhase = nextPhaseRef.current;
    setUploading(nextPhase);
    setError("");
    try {
      await uploadTradePhoto(tradeId, nextPhase, file);
    } catch (err) {
      setError(err instanceof Error ? err.message : "사진 업로드에 실패했습니다");
    } finally {
      setUploading(null);
    }
  };

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
          {photos.slice(0, 4).map((p) => {
            const src = p.thumbnailUrl || p.url;
            return src ? (
              <img key={p.id} src={src} alt={p.label} className="h-7 w-7 rounded-md object-cover ring-2 ring-white" loading="lazy" />
            ) : (
              <span
                key={p.id}
                className="h-7 w-7 rounded-md ring-2 ring-white"
                style={{ background: p.swatch }}
                aria-label={p.label}
              />
            );
          })}
        </div>
      </div>

      <input ref={inputRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={onFileChange} />

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

            {error && <div className="mb-3 rounded-xl bg-attention-bg px-3 py-2 text-[12px] font-semibold text-attention-fg">{error}</div>}
            {loading && <div className="mb-3 text-[12px] font-semibold text-ink-faint">사진 불러오는 중…</div>}

            {PHASES.map((phase) => {
              const ps = photos.filter((p) => p.phase === phase);
              return (
                <div key={phase} className="mb-4">
                  <div className="mb-2 flex items-center justify-between">
                    <div className="text-[12px] font-semibold text-ink-mute">{phaseTitle(phase)}</div>
                    <button
                      type="button"
                      onClick={() => pickPhoto(phase)}
                      disabled={uploading !== null}
                      className="tap inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-2.5 py-1.5 text-[12px] font-bold text-white disabled:opacity-50"
                    >
                      <Camera className="h-4 w-4" />
                      {uploading === phase ? "업로드 중…" : `${phaseTitle(phase)} 사진 추가`}
                    </button>
                  </div>
                  {ps.length ? (
                    <div className="grid grid-cols-3 gap-2">
                      {ps.map((p) => (
                        <PhotoTile key={p.id} photo={p} />
                      ))}
                    </div>
                  ) : (
                    <div className="rounded-xl border border-dashed border-black/15 px-3 py-5 text-center text-[12px] font-semibold text-ink-faint">
                      등록된 사진 없음
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}
