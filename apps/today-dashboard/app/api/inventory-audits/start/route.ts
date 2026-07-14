import type { NextRequest } from "next/server";

import {
  evaluateStartDraft,
  parseStartInput,
  statusForStartResult,
} from "@/lib/inventory-audit/staff";
import { isInventoryOwner, requireInventoryUser } from "@/lib/server/inventoryAuditAuth";
import { getInventoryAuditServiceClient } from "@/lib/server/inventoryAuditDb";
import {
  inventoryActorFromUser,
  inventoryErrorResponse,
  inventoryJsonResponse,
  inventoryUnauthorizedResponse,
} from "@/lib/server/inventoryAuditHttp";
import {
  loadGlobalInventoryAuditDraft,
  loadInventoryAuditStartSources,
  loadStaffWorkspace,
  startInventoryAudit,
} from "@/lib/server/inventoryAuditStaff";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const user = await requireInventoryUser(req);
  const actor = inventoryActorFromUser(user);
  if (!actor) return inventoryUnauthorizedResponse();

  try {
    parseStartInput(await req.json());
    const client = getInventoryAuditServiceClient();
    const draft = await loadGlobalInventoryAuditDraft(client);
    const preflight = evaluateStartDraft(draft, actor.id);
    if (preflight.kind === "conflict") {
      return inventoryJsonResponse(
        {
          error: "다른 직원이 전체 재고 실사를 진행 중입니다.",
          code: "active_draft_conflict",
        },
        409,
      );
    }
    if (preflight.kind === "reuse") {
      const workspace = await loadStaffWorkspace(
        client,
        actor.id,
        isInventoryOwner(user),
      );
      return inventoryJsonResponse({ ...workspace, start: { reused: true } }, 200);
    }

    const sources = await loadInventoryAuditStartSources(client);
    const result = await startInventoryAudit(client, actor, sources);
    const workspace = await loadStaffWorkspace(
      client,
      actor.id,
      isInventoryOwner(user),
    );
    return inventoryJsonResponse(
      { ...workspace, start: { reused: result.reused } },
      statusForStartResult(result),
    );
  } catch (error) {
    return inventoryErrorResponse(error);
  }
}
