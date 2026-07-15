import type { NextRequest } from "next/server";

import type { InventoryAuditReviewDecision } from "@/lib/inventory-audit/review";
import { isUuid } from "@/lib/inventory-audit/staff";
import { requireInventoryOwner } from "@/lib/server/inventoryAuditAuth";
import { getInventoryAuditServiceClient } from "@/lib/server/inventoryAuditDb";
import {
  inventoryErrorResponse,
  inventoryJsonResponse,
} from "@/lib/server/inventoryAuditHttp";
import { loadInventoryAuditReview } from "@/lib/server/inventoryAuditReview";

type RouteContext = { params: Promise<{ sessionId: string }> };
type DecisionInput = {
  equipmentId?: unknown;
  decision?: unknown;
  reviewNote?: unknown;
};

const CHECKPOINT_DECISIONS = new Set<InventoryAuditReviewDecision>([
  "apply_audit",
  "keep_ledger",
  "recount",
]);

export async function POST(req: NextRequest, { params }: RouteContext) {
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
    const body = (await req.json()) as { decisions?: unknown };
    if (!Array.isArray(body.decisions)) {
      return inventoryJsonResponse(
        { error: "현재 완료분의 검토 결과가 필요합니다.", code: "invalid_decisions" },
        422,
      );
    }
    const inputs = body.decisions as DecisionInput[];
    const inputMap = new Map<string, DecisionInput>();
    for (const input of inputs) {
      if (
        typeof input.equipmentId !== "string" ||
        typeof input.decision !== "string" ||
        !CHECKPOINT_DECISIONS.has(input.decision as InventoryAuditReviewDecision) ||
        inputMap.has(input.equipmentId)
      ) {
        return inventoryJsonResponse(
          { error: "현재 완료분의 검토 결과가 올바르지 않습니다.", code: "invalid_decisions" },
          422,
        );
      }
      inputMap.set(input.equipmentId, input);
    }

    const client = getInventoryAuditServiceClient();
    const review = await loadInventoryAuditReview(client, sessionId);
    if (review.session.status !== "draft") {
      return inventoryJsonResponse(
        { error: "진행 중인 실사만 중간 확정할 수 있습니다.", code: "checkpoint_not_draft" },
        409,
      );
    }

    const eligible = new Map(
      review.items
        .filter((item) => item.physicalTotal !== null && !item.checkpointApprovedAt)
        .map((item) => [item.equipmentId, item]),
    );
    if ([...inputMap.keys()].some((equipmentId) => !eligible.has(equipmentId))) {
      return inventoryJsonResponse(
        { error: "미계수 또는 이미 확정된 장비가 포함됐습니다.", code: "invalid_checkpoint_items" },
        422,
      );
    }

    const items = [...inputMap.entries()]
      .filter(([, input]) => input.decision !== "recount")
      .map(([equipmentId, input]) => {
        const item = eligible.get(equipmentId)!;
        const decision = input.decision as Exclude<InventoryAuditReviewDecision, "recount">;
        return {
          equipment_id: equipmentId,
          decision,
          final_stock_total: decision === "apply_audit" ? item.candidateTotal : null,
          final_stock_maint:
            decision === "apply_audit" ? item.finalStockMaintenance : null,
          final_state: decision === "apply_audit" ? item.finalState : null,
          final_open_issues:
            decision === "apply_audit" ? item.finalOpenIssues : [],
          other_confirmed_offsite_qty: item.resolvedOffsiteQty,
          review_note:
            typeof input.reviewNote === "string" ? input.reviewNote.trim() : "",
        };
      });
    if (items.length === 0) {
      return inventoryJsonResponse(
        { error: "확정할 장비가 없습니다. 재확인 장비는 다음 근무자가 이어서 셉니다.", code: "empty_checkpoint" },
        422,
      );
    }

    const { data, error } = await client.rpc("approve_inventory_audit_items", {
      p_session_id: sessionId,
      p_approved_by: owner.id,
      p_approved_by_email: owner.email.trim().toLowerCase(),
      p_items: items,
    });
    if (error) throw error;
    return inventoryJsonResponse(data);
  } catch (error) {
    return inventoryErrorResponse(error);
  }
}
