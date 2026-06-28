import { createClient } from "@supabase/supabase-js";
import type { Session } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const projectRef = url ? new URL(url).hostname.split(".")[0] : "";
const storageKey = projectRef ? `sb-${projectRef}-auth-token` : "";

/** 환경변수가 있으면 Supabase(실데이터) 모드, 없으면 시드 모드 */
export const isSupabase = !!(url && anon);

export const supabase =
  url && anon
    ? createClient(url, anon, {
        db: { schema: "village" },
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
        realtime: { params: { eventsPerSecond: 8 } },
      })
    : null;

export function readPersistedSupabaseSession(): Session | null {
  if (!storageKey || typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const session = (parsed?.currentSession ?? parsed) as Session | null;
    if (!session?.access_token || !session?.refresh_token || !session?.user) return null;
    if (session.expires_at && session.expires_at <= Math.floor(Date.now() / 1000)) return null;
    return session;
  } catch {
    return null;
  }
}
