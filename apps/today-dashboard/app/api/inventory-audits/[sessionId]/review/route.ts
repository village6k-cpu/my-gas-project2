import type { NextRequest } from "next/server";

import { isUuid } from "@/lib/inventory-audit/staff";
import { requireInventoryOwner } from "@/lib/server/inventoryAuditAuth";
import { getInventoryAuditServiceClient } from "@/lib/server/inventoryAuditDb";
import {
  inventoryErrorResponse,
  inventoryJsonResponse,
} from "@/lib/server/inventoryAuditHttp";
import { loadInventoryAuditReview } from "@/lib/server/inventoryAuditReview";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ sessionId: string }> };

export async function GET(req: NextRequest, { params }: RouteContext) {
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
    const client = getInventoryAuditServiceClient();
    return inventoryJsonResponse(
      await loadInventoryAuditReview(client, sessionId),
    );
  } catch (error) {
    return inventoryErrorResponse(error);
  }
}
