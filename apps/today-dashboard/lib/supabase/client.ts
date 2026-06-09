import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

/** 환경변수가 있으면 Supabase(실데이터) 모드, 없으면 시드 모드 */
export const isSupabase = !!(url && anon);

export const supabase =
  url && anon
    ? createClient(url, anon, {
        db: { schema: "village" },
        auth: { persistSession: false },
        realtime: { params: { eventsPerSecond: 8 } },
      })
    : null;
