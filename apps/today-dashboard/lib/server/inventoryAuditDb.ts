import "server-only";

import { createClient } from "@supabase/supabase-js";

export class InventoryAuditServiceUnavailableError extends Error {
  readonly status = 503 as const;
  readonly code = "inventory_audit_service_unavailable";

  constructor(missing: string[]) {
    super(`재고 실사 서버 설정이 없습니다: ${missing.join(", ")}`);
    this.name = "InventoryAuditServiceUnavailableError";
  }
}

function createServiceClient(url: string, serviceRoleKey: string) {
  return createClient(url, serviceRoleKey, {
    db: { schema: "village" },
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}

// 요청마다 새 클라이언트를 만들지 않도록 모듈 스코프에 재사용 (authCache.ts와 같은 패턴).
// env 값이 바뀌면 재생성한다. env 검증(fail-closed)은 캐시와 무관하게 매 호출 실행.
let cachedClient: ReturnType<typeof createServiceClient> | null = null;
let cachedUrl: string | null = null;
let cachedKey: string | null = null;

/** 서버 라우트 전용. service-role이 없을 때 anon 키로 낮춰 실행하지 않는다. */
export function getInventoryAuditServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !serviceRoleKey) {
    const missing: string[] = [];
    if (!url) missing.push("NEXT_PUBLIC_SUPABASE_URL");
    if (!serviceRoleKey) missing.push("SUPABASE_SERVICE_ROLE_KEY");
    throw new InventoryAuditServiceUnavailableError(missing);
  }

  if (!cachedClient || cachedUrl !== url || cachedKey !== serviceRoleKey) {
    cachedClient = createServiceClient(url, serviceRoleKey);
    cachedUrl = url;
    cachedKey = serviceRoleKey;
  }
  return cachedClient;
}
