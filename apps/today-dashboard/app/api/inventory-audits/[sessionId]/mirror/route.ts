import type { NextRequest } from "next/server";

import {
  InventoryAuditMirrorError,
  getInventoryAuditMirrorConfig,
  isInventoryAuditMirrorUuid,
  runInventoryAuditMirror,
  sanitizeInventoryAuditMirrorError,
} from "@/lib/server/inventoryAuditMirrorCore.mjs";
import { requireInventoryOwner } from "@/lib/server/inventoryAuditAuth";
import { getInventoryAuditServiceClient } from "@/lib/server/inventoryAuditDb";
import { inventoryJsonResponse } from "@/lib/server/inventoryAuditHttp";

export const runtime = "nodejs";
export const maxDuration = 60;

type RouteContext = {
  params: Promise<{ sessionId: string }>;
};

type LedgerPageRequest = {
  from: number;
  to: number;
  signal: AbortSignal;
};

type RpcState = Record<string, unknown>;

function rpcState(value: unknown): RpcState {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as RpcState)
    : {};
}

function safeCount(value: unknown): number | null {
  return Number.isInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function claimedToken(value: unknown): string | null {
  return isInventoryAuditMirrorUuid(value) ? String(value) : null;
}

function failureHttpStatus(status: number): 502 | 503 | 504 {
  if (status === 503) return 503;
  if (status === 504) return 504;
  return 502;
}

export async function POST(req: NextRequest, { params }: RouteContext) {
  const owner = await requireInventoryOwner(req);
  if (!owner?.email) {
    return inventoryJsonResponse(
      { error: "사장님 권한이 필요합니다.", code: "forbidden" },
      403,
    );
  }

  const { sessionId } = await params;
  if (!isInventoryAuditMirrorUuid(sessionId)) {
    return inventoryJsonResponse(
      { error: "실사 세션 ID가 올바르지 않습니다.", code: "invalid_session_id" },
      400,
    );
  }

  let client: ReturnType<typeof getInventoryAuditServiceClient> | null = null;
  let attemptToken: string | null = null;
  try {
    client = getInventoryAuditServiceClient();
    const config = getInventoryAuditMirrorConfig();
    const { data: session, error: sessionError } = await client
      .from("inventory_audit_sessions")
      .select("id,status,mirror_status")
      .eq("id", sessionId)
      .maybeSingle();

    if (sessionError) {
      throw new InventoryAuditMirrorError("mirror_service_unavailable");
    }
    if (!session || session.status !== "approved") {
      return inventoryJsonResponse(
        {
          error: "승인 완료된 실사만 시트에 반영할 수 있습니다.",
          code: "mirror_unapproved",
        },
        409,
      );
    }

    const { data: rawClaim, error: claimError } = await client.rpc(
      "claim_inventory_audit_mirror",
      {
        p_session_id: sessionId,
        p_claimed_by: owner.id,
        p_claimed_by_email: owner.email.trim().toLowerCase(),
      },
    );
    if (claimError) {
      throw new InventoryAuditMirrorError("mirror_service_unavailable");
    }
    const claim = rpcState(rawClaim);
    if (claim.state === "unapproved") {
      return inventoryJsonResponse(
        { error: "승인 완료된 실사가 아닙니다.", code: "mirror_unapproved" },
        409,
      );
    }
    if (claim.state === "busy") {
      return inventoryJsonResponse(
        {
          mirrorStatus: "pending",
          code: "mirror_busy",
          retryAfterSeconds: safeCount(claim.retry_after_seconds) ?? 5,
        },
        202,
      );
    }
    if (claim.state === "synced") {
      return inventoryJsonResponse(
        {
          mirrorStatus: "synced",
          reused: true,
          ledgerRowCount: safeCount(claim.ledger_row_count),
          sheetRowCount: safeCount(claim.sheet_row_count),
          updateCount: safeCount(claim.update_count),
          appendCount: safeCount(claim.append_count),
          updatedCount: safeCount(claim.updated_count),
          appendedCount: safeCount(claim.appended_count),
          syncedAt:
            typeof claim.synced_at === "string" ? claim.synced_at : null,
        },
        200,
      );
    }
    attemptToken = claimedToken(claim.attempt_token);
    if (claim.state !== "claimed" || !attemptToken) {
      throw new InventoryAuditMirrorError("mirror_attempt_stale");
    }

    const loadLedgerPage = async ({
      from,
      to,
      signal,
    }: LedgerPageRequest) => {
      const query = client!
        .from("equipment_ledger")
        .select(
          "equipment_id,major,category,name,stock_total,stock_maint,price,state,note,open_issues",
        )
        .order("equipment_id", { ascending: true })
        .range(from, to)
        .abortSignal(signal);
      const { data, error } = await query;
      if (error || !Array.isArray(data)) {
        throw new InventoryAuditMirrorError("mirror_ledger_read_failed");
      }
      return data;
    };

    const result = await runInventoryAuditMirror({
      sessionId,
      loadLedgerPage,
      ...config,
      timeoutMs: 45_000,
    });
    const { data: rawComplete, error: completeError } = await client.rpc(
      "complete_inventory_audit_mirror",
      {
        p_session_id: sessionId,
        p_attempt_token: attemptToken,
        p_ledger_row_count: result.ledgerRowCount,
        p_sheet_row_count: result.sheetRowCount,
        p_update_count: result.updateCount,
        p_append_count: result.appendCount,
        p_wrote: result.wrote,
        p_updated_count: result.updatedCount,
        p_appended_count: result.appendedCount,
        p_already_current: result.alreadyCurrent,
      },
    );
    const complete = rpcState(rawComplete);
    if (completeError) {
      throw new InventoryAuditMirrorError("mirror_service_unavailable");
    }
    if (complete.state !== "synced") {
      throw new InventoryAuditMirrorError("mirror_attempt_stale");
    }

    return inventoryJsonResponse(
      { mirrorStatus: "synced", reused: false, ...result },
      200,
    );
  } catch (error: unknown) {
    const safe = sanitizeInventoryAuditMirrorError(error);
    if (client && attemptToken) {
      try {
        await client.rpc("fail_inventory_audit_mirror", {
          p_session_id: sessionId,
          p_attempt_token: attemptToken,
          p_error_code: safe.code,
        });
      } catch {
        // The two-minute lease remains recoverable. Never replace the stable
        // response below with a transport exception from failure bookkeeping.
      }
    }
    return inventoryJsonResponse(
      { error: safe.message, code: safe.code },
      failureHttpStatus(safe.status),
    );
  }
}
