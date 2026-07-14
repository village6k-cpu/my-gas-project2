import type { NextRequest } from "next/server";

import {
  buildDeleteObservationRpcInput,
  buildSaveObservationRpcInput,
  mapInventoryAuditError,
  parseDeleteObservationInput,
  parseObservationInput,
  serializeStaffObservation,
  type DeleteObservationInput,
  type ObservationInput,
} from "@/lib/inventory-audit/staff";
import { requireInventoryUser } from "@/lib/server/inventoryAuditAuth";
import { getInventoryAuditServiceClient } from "@/lib/server/inventoryAuditDb";
import {
  inventoryActorFromUser,
  inventoryErrorResponse,
  inventoryJsonResponse,
  inventoryUnauthorizedResponse,
} from "@/lib/server/inventoryAuditHttp";
import {
  loadCurrentStaffObservation,
  type InventoryAuditServiceClient,
} from "@/lib/server/inventoryAuditStaff";

export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ sessionId: string }>;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

async function staleResponse(
  error: unknown,
  client: InventoryAuditServiceClient | null,
  sessionId: string,
  observationId: string | null,
  userId: string,
) {
  const mapped = mapInventoryAuditError(error);
  if (mapped.code !== "stale_write" || !client || !observationId) {
    return inventoryErrorResponse(error);
  }
  let currentObservation = null;
  try {
    currentObservation = await loadCurrentStaffObservation(
      client,
      sessionId,
      observationId,
      userId,
    );
  } catch {
    // The original CAS conflict remains the authoritative response.
  }
  return inventoryErrorResponse(error, { currentObservation });
}

export async function PUT(req: NextRequest, context: RouteContext) {
  const user = await requireInventoryUser(req);
  const actor = inventoryActorFromUser(user);
  if (!actor) return inventoryUnauthorizedResponse();

  let client: InventoryAuditServiceClient | null = null;
  let input: ObservationInput | null = null;
  let sessionId = "";
  try {
    ({ sessionId } = await context.params);
    input = parseObservationInput(await req.json());
    client = getInventoryAuditServiceClient();
    const { data, error } = await client.rpc(
      "save_inventory_audit_observation",
      buildSaveObservationRpcInput(sessionId, actor, input),
    );
    if (error) throw error;
    const result = record(data);
    const observation = record(result?.observation);
    if (!result || !observation) {
      throw new Error("inventory audit save RPC returned an invalid response");
    }
    return inventoryJsonResponse(
      {
        observation: serializeStaffObservation(observation),
        reused: result.reused === true,
      },
      result.created === true ? 201 : 200,
    );
  } catch (error) {
    return staleResponse(error, client, sessionId, input?.id ?? null, actor.id);
  }
}

export async function DELETE(req: NextRequest, context: RouteContext) {
  const user = await requireInventoryUser(req);
  const actor = inventoryActorFromUser(user);
  if (!actor) return inventoryUnauthorizedResponse();

  let client: InventoryAuditServiceClient | null = null;
  let input: DeleteObservationInput | null = null;
  let sessionId = "";
  try {
    ({ sessionId } = await context.params);
    input = parseDeleteObservationInput(await req.json());
    client = getInventoryAuditServiceClient();
    const { data, error } = await client.rpc(
      "delete_inventory_audit_observation",
      buildDeleteObservationRpcInput(sessionId, actor, input),
    );
    if (error) throw error;
    const result = record(data);
    if (!result) {
      throw new Error("inventory audit delete RPC returned an invalid response");
    }
    return inventoryJsonResponse({
      observationId: input.observationId,
      deleted: result.deleted === true,
      reused: result.reused === true,
    });
  } catch (error) {
    return staleResponse(
      error,
      client,
      sessionId,
      input?.observationId ?? null,
      actor.id,
    );
  }
}
