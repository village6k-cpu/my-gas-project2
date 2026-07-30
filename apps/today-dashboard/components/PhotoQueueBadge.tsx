"use client";

// 사진 업로드 큐 전역 배지 — 실패/전송 중 잡이 있으면 화면 어느 탭에서든 보인다.
// 거래 카드가 날짜/검색 윈도우 밖으로 나가도 IndexedDB의 실패 잡(손상 분쟁 증빙)이
// 침묵하지 않도록, 탭하면 실패 목록과 일괄 재시도/폐기를 제공한다.
import { useState } from "react";
import {
  discardTradePhotoUpload,
  getPhotoPreview,
  listFailedPhotoJobs,
  retryTradePhotoUpload,
  usePhotoQueueSummary,
  type FailedPhotoJobView,
} from "@/lib/data/store";

function jobTimeLabel(createdAt: number): string {
  try {
    const d = new Date(createdAt);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  } catch {
    return "";
  }
}

export function PhotoQueueBadge() {
  const summary = usePhotoQueueSummary();
  const [open, setOpen] = useState(false);
  const [jobs, setJobs] = useState<FailedPhotoJobView[]>([]);

  if (!summary.failed && !summary.uploading) return null;

  const openSheet = () => {
    setJobs(listFailedPhotoJobs());
    setOpen(true);
  };

  const refresh = () => setJobs(listFailedPhotoJobs());

  return (
    <>
      <button
        type="button"
        onClick={openSheet}
        aria-label="사진 업로드 상태"
        className={`tap fixed bottom-20 right-3 z-[70] flex items-center gap-1.5 rounded-full px-3 py-2 text-[12px] font-extrabold shadow-pop ring-1 lg:bottom-4 ${
          summary.failed
            ? "bg-attention-bg text-attention-fg ring-attention-ring"
            : "bg-white text-ink-soft ring-line/70"
        }`}
      >
        📷 {summary.failed ? `실패 ${summary.failed}` : `전송 중 ${summary.uploading}`}
      </button>

      {open && (
        <div className="fixed inset-0 z-[80] flex items-end justify-center bg-black/45 sm:items-center" onClick={() => setOpen(false)}>
          <div
            className="animate-pop max-h-[85vh] w-full max-w-md overflow-y-auto rounded-t-2xl bg-white p-4 pb-8 shadow-pop sm:rounded-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="text-[16px] font-extrabold text-ink">사진 업로드 상태</h2>
                <p className="text-[11.5px] text-ink-mute">
                  실패 {summary.failed}건 · 전송 중 {summary.uploading}건 — 실패한 사진 원본은 폐기 전까지 이 기기에 보존됩니다
                </p>
              </div>
              <button type="button" onClick={() => setOpen(false)} className="tap rounded-lg px-2 py-1 text-[18px] text-ink-faint" aria-label="닫기">
                ✕
              </button>
            </div>

            <div className="mt-3 space-y-2">
              {jobs.length === 0 && (
                <div className="rounded-lg bg-paper/70 px-3 py-4 text-center text-[12.5px] text-ink-mute">
                  실패한 사진이 없습니다. 전송 중인 사진은 자동으로 이어서 올라갑니다.
                </div>
              )}
              {jobs.map((job) => {
                const preview = getPhotoPreview(job.queueId);
                return (
                  <div key={job.queueId} className="flex items-center gap-3 rounded-xl bg-paper/70 p-2.5 ring-1 ring-line/60">
                    {preview ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={preview} alt="" className="h-12 w-12 shrink-0 rounded-lg object-cover" />
                    ) : (
                      <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-line/40 text-[18px]">📷</div>
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-bold text-ink">
                        {job.tradeId} · {job.phase === "checkout" ? "반출" : "반납"} 사진
                      </div>
                      <div className="truncate text-[11px] text-ink-mute">
                        {jobTimeLabel(job.createdAt)}{job.permanent ? " · 서버 거절" : ""} {job.lastError ? `· ${job.lastError}` : ""}
                      </div>
                    </div>
                    <div className="flex shrink-0 gap-1.5">
                      {!job.permanent && (
                        <button
                          type="button"
                          onClick={() => {
                            retryTradePhotoUpload(job.tradeId, job.queueId);
                            refresh();
                          }}
                          className="tap rounded-lg bg-brand-50 px-2.5 py-1.5 text-[12px] font-bold text-brand-700 ring-1 ring-brand-200"
                        >
                          재시도
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => {
                          if (window.confirm("이 사진 원본을 폐기할까요?\n폐기하면 이 기기에서 복구할 수 없습니다.")) {
                            discardTradePhotoUpload(job.tradeId, job.queueId);
                            refresh();
                          }
                        }}
                        className="tap rounded-lg bg-attention-bg px-2.5 py-1.5 text-[12px] font-bold text-attention-fg ring-1 ring-attention-ring"
                      >
                        폐기
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
