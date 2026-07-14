import "server-only";

import type { User } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

import {
  mapInventoryAuditError,
  type InventoryActor,
} from "@/lib/inventory-audit/staff";

export function inventoryActorFromUser(user: User | null): InventoryActor | null {
  const email = user?.email?.trim().toLowerCase();
  return user && email ? { id: user.id, email } : null;
}

export function inventoryUnauthorizedResponse() {
  return NextResponse.json(
    { error: "로그인이 필요합니다.", code: "unauthorized" },
    { status: 401, headers: { "cache-control": "no-store" } },
  );
}

export function inventoryJsonResponse(
  body: unknown,
  status = 200,
) {
  return NextResponse.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

export function inventoryErrorResponse(
  error: unknown,
  extra?: Record<string, unknown>,
) {
  const mapped = mapInventoryAuditError(error);
  return inventoryJsonResponse(
    { error: mapped.message, code: mapped.code, ...(extra ?? {}) },
    mapped.status,
  );
}
