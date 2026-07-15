import type { NextRequest } from "next/server";

import { isUuid } from "@/lib/inventory-audit/staff";
import { requireInventoryOwner } from "@/lib/server/inventoryAuditAuth";
import { getInventoryAuditServiceClient } from "@/lib/server/inventoryAuditDb";
import {
  inventoryErrorResponse,
  inventoryJsonResponse,
} from "@/lib/server/inventoryAuditHttp";

type RouteContext = { params: Promise<{ sessionId: string }> };

export async function PUT(req: NextRequest, { params }: RouteContext) {
  const owner = await requireInventoryOwner(req);
  if (!owner?.email) {
    return inventoryJsonResponse(
      { error: "사장님 권한이 필요합니다.", code: "forbidden" },
      403,
    );
  }
  const { sessionId } = await params;
  if (!isUuid(sessionId)) {
    return inventoryJsonResponse(
      { error: "실사 세션 ID가 올바르지 않습니다.", code: "invalid_session_id" },
      400,
    );
  }

  try {
    const body = (await req.json()) as Record<string, unknown>;
    const exceptionIds = Array.isArray(body.exceptionIds)
      ? body.exceptionIds.filter((value): value is string => typeof value === "string" && isUuid(value))
      : [];
    const resolution = body.resolution;
    const equipmentId =
      typeof body.equipmentId === "string" ? body.equipmentId.trim() : null;
    if (
      exceptionIds.length === 0 ||
      exceptionIds.length !== (Array.isArray(body.exceptionIds) ? body.exceptionIds.length : 0) ||
      !["existing_equipment", "not_inventory"].includes(String(resolution)) ||
      (resolution === "existing_equipment" && !equipmentId)
    ) {
      return inventoryJsonResponse(
        { error: "대여 장비 분류가 올바르지 않습니다.", code: "invalid_rental_resolution" },
        422,
      );
    }

    const client = getInventoryAuditServiceClient();
    const { data, error } = await client.rpc(
      "resolve_inventory_audit_rental_group",
      {
        p_session_id: sessionId,
        p_exception_ids: exceptionIds,
        p_resolution: resolution,
        p_equipment_id: resolution === "existing_equipment" ? equipmentId : null,
        p_reviewer: owner.id,
        p_reviewer_email: owner.email.trim().toLowerCase(),
      },
    );
    if (error) throw error;
    return inventoryJsonResponse(data);
  } catch (error) {
    return inventoryErrorResponse(error);
  }
}
