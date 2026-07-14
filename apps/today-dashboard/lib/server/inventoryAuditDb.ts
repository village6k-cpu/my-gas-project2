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

  return createClient(url, serviceRoleKey, {
    db: { schema: "village" },
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}
