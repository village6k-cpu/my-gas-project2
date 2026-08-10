"use client";

import { useToast } from "@/lib/data/store";
import { Check } from "./icons";

export function Toast() {
  const toast = useToast();
  if (!toast) return null;
  const isError = toast.kind === "error";
  return (
    <div
      key={toast.id + toast.kind}
      className={
        "animate-toast fixed bottom-24 left-1/2 z-[60] flex -translate-x-1/2 items-center gap-2 rounded-full px-4 py-2 text-[13px] font-semibold text-white shadow-pop " +
        // 액션이 없으면 종전대로 클릭을 통과시킨다(화면 조작을 가리지 않게).
        (toast.action ? "" : "pointer-events-none ") +
        (isError ? "bg-red-600" : "bg-ink")
      }
    >
      {isError ? (
        <span className="flex h-4 w-4 items-center justify-center font-bold">!</span>
      ) : (
        <span className="flex h-4 w-4 items-center justify-center rounded-full bg-checkin-fg">
          <Check className="h-3 w-3" />
        </span>
      )}
      {toast.text}
      {toast.action && (
        <button
          onClick={toast.action.run}
          className="tap -mr-1.5 ml-1 rounded-full bg-white/20 px-2.5 py-1 text-[12.5px] font-extrabold text-white"
        >
          {toast.action.label}
        </button>
      )}
    </div>
  );
}
