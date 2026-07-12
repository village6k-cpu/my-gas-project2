"use client";

import { useEffect, useRef, useState } from "react";
import type { Phase, PhotoMeta } from "@/lib/domain/types";
import {
  discardTradePhotoUpload,
  getPhotoPreview,
  refreshTradePhotos,
  retryTradePhotoUpload,
  uploadTradePhoto,
} from "@/lib/data/store";
import { Camera } from "./icons";

const PHASES: Phase[] = ["checkout", "checkin"];

function phaseTitle(phase: Phase | "other"): string {
  return phase === "checkout" ? "반출" : phase === "checkin" ? "반납" : "기타";
}

function photoSrc(photo: PhotoMeta): string | undefined {
  return photo.thumbnailUrl || photo.url || getPhotoPreview(photo.queueId);
}

function PhotoTile({ tradeId, photo }: { tradeId: string; photo: PhotoMeta }) {
  const src = photoSrc(photo);

  // 업로드 대기/실패 타일 — 서버 URL이 아직 없으므로 로컬 미리보기 위에 상태를 덧씌운다
  if (photo.status) {
    return (
      <div className="relative aspect-square overflow-hidden rounded-xl bg-paper ring-1 ring-line">
        {src ? (
          <img src={src} alt={photo.label} className="h-full w-full object-cover" loading="lazy" />
        ) : (
          <div className="h-full w-full" style={{ background: photo.swatch }} />
        )}
        {photo.status === "uploading" ? (
          <div className="absolute inset-x-0 bottom-0 bg-black/55 px-1.5 py-1 text-center text-[10px] font-bold text-white">
            업로드 중…
          </div>
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-black/60 p-1.5">
            <div className="text-[10px] font-bold text-white">업로드 실패</div>
            <div className="flex gap-1">
              <button
                type="button"
                onClick={() => retryTradePhotoUpload(tradeId, photo.queueId || "")}
                className="tap rounded-md bg-white px-2 py-1 text-[10px] font-bold text-ink"
              >
                재시도
              </button>
              <button
                type="button"
                onClick={() => discardTradePhotoUpload(tradeId, photo.queueId || "")}
                className="tap rounded-md bg-white/25 px-2 py-1 text-[10px] font-bold text-white"
              >
                삭제
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  if (src) {
    return (
      <a href={photo.url || src} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-xl bg-paper ring-1 ring-line">
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
  const [preparing, setPreparing] = useState<Phase | null>(null);
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

  // 압축이 끝나면 즉시 타일이 뜨고, 전송은 백그라운드 큐가 맡는다 — 여기서 네트워크를 기다리지 않는다.
  const onFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";
    if (!files.length) return;

    const nextPhase = nextPhaseRef.current;
    setPreparing(nextPhase);
    setError("");
    try {
      for (const file of files) {
        await uploadTradePhoto(tradeId, nextPhase, file);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "사진 업로드에 실패했습니다");
    } finally {
      setPreparing(null);
    }
  };

  return (
    <>
      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="tap inline-flex items-center gap-1.5 rounded-lg bg-paper px-2.5 py-1.5 text-[12.5px] font-semibold text-ink-soft ring-1 ring-line/70"
        >
          <Camera className="h-4 w-4" />
          사진
          <span className="text-ink-faint">
            반출 {checkout.length} · 반납 {checkin.length}
          </span>
        </button>
        <div className="flex -space-x-2">
          {photos.slice(0, 4).map((p) => {
            const src = photoSrc(p);
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

      {/* capture 속성 제거 — 카메라 강제 대신 OS 선택창(카메라/사진 보관함/파일)이 뜨게 해서
          기존에 찍어둔 사진도 올릴 수 있다. */}
      <input ref={inputRef} type="file" accept="image/*" multiple className="hidden" onChange={onFileChange} />

      {open && (
        <div
          className="fixed inset-0 z-[120] flex items-end justify-center bg-black/45 px-2 pb-[env(safe-area-inset-bottom)] sm:items-center sm:p-4"
          onClick={() => setOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            className="animate-pop max-h-[calc(100dvh-1rem)] w-full max-w-md overflow-y-auto overscroll-contain rounded-t-2xl bg-white p-4 pb-[calc(env(safe-area-inset-bottom)+1rem)] shadow-pop sm:max-h-[min(80vh,720px)] sm:rounded-2xl sm:pb-4"
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
                      disabled={preparing !== null}
                      className="tap inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-2.5 py-1.5 text-[12px] font-bold text-white disabled:opacity-50"
                    >
                      <Camera className="h-4 w-4" />
                      {preparing === phase ? "사진 준비 중…" : `${phaseTitle(phase)} 사진 추가`}
                    </button>
                  </div>
                  {ps.length ? (
                    <div className="grid grid-cols-3 gap-2">
                      {ps.map((p) => (
                        <PhotoTile key={p.id} tradeId={tradeId} photo={p} />
                      ))}
                    </div>
                  ) : (
                    <div className="rounded-xl border border-dashed border-line px-3 py-5 text-center text-[12px] font-semibold text-ink-faint">
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
