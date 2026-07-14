import type { NextRequest } from "next/server";

import {
  assertEmptyBody,
  buildCancelRpcInput,
} from "@/lib/inventory-audit/staff";
import { requireInventoryUser } from "@/lib/server/inventoryAuditAuth";
import { getInventoryAuditServiceClient } from "@/lib/server/inventoryAuditDb";
import {
  inventoryActorFromUser,
  inventoryErrorResponse,
  inventoryJsonResponse,
  inventoryUnauthorizedResponse,
} from "@/lib/server/inventoryAuditHttp";

export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ sessionId: string }>;
};

export async function POST(req: NextRequest, context: RouteContext) {
  const user = await requireInventoryUser(req);
  const actor = inventoryActorFromUser(user);
  if (!actor) return inventoryUnauthorizedResponse();

  try {
    const { sessionId } = await context.params;
    assertEmptyBody(await req.text());
    const client = getInventoryAuditServiceClient();
    const { data, error } = await client.rpc(
      "cancel_inventory_audit",
      buildCancelRpcInput(sessionId, actor),
    );
    if (error) throw error;
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new Error("inventory audit cancel RPC returned an invalid response");
    }
    return inventoryJsonResponse({
      session: {
        id: typeof data.session_id === "string" ? data.session_id : sessionId,
        status: data.status === "cancelled" ? "cancelled" : null,
      },
      reused: data.reused === true,
    });
  } catch (error) {
    return inventoryErrorResponse(error);
  }
}
