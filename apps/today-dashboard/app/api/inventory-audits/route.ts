import type { NextRequest } from "next/server";

import { isInventoryOwner, requireInventoryUser } from "@/lib/server/inventoryAuditAuth";
import { getInventoryAuditServiceClient } from "@/lib/server/inventoryAuditDb";
import {
  inventoryActorFromUser,
  inventoryErrorResponse,
  inventoryJsonResponse,
  inventoryUnauthorizedResponse,
} from "@/lib/server/inventoryAuditHttp";
import { loadStaffWorkspace } from "@/lib/server/inventoryAuditStaff";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const user = await requireInventoryUser(req);
  const actor = inventoryActorFromUser(user);
  if (!actor) return inventoryUnauthorizedResponse();

  try {
    const client = getInventoryAuditServiceClient();
    const workspace = await loadStaffWorkspace(
      client,
      actor.id,
      isInventoryOwner(user),
    );
    return inventoryJsonResponse(workspace);
  } catch (error) {
    return inventoryErrorResponse(error);
  }
}
