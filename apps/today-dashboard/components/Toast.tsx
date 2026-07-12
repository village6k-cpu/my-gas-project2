"use client";

import { useToast } from "@/lib/data/store";
import { Check } from "./icons";

export function Toast() {
  const toast = useToast();
  if (!toast) return null;
  const saved = toast.kind === "saved";
  const isError = toast.kind === "error";
  return (
    <div
      key={toast.id + toast.kind}
      className={
        "animate-toast pointer-events-none fixed bottom-24 left-1/2 z-[60] flex -translate-x-1/2 items-center gap-2 rounded-full px-4 py-2 text-[13px] font-semibold text-white shadow-pop " +
        (isError ? "bg-red-600" : "bg-ink")
      }
    >
      {isError ? (
        <span className="flex h-4 w-4 items-center justify-center font-bold">!</span>
      ) : saved ? (
        <span className="flex h-4 w-4 items-center justify-center rounded-full bg-checkin-fg">
          <Check className="h-3 w-3" />
        </span>
      ) : (
        <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/30 border-t-white" />
      )}
      {toast.text}
    </div>
  );
}
