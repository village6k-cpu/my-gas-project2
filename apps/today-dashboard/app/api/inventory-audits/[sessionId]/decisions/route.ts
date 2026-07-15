import type { NextRequest } from "next/server";

import type { InventoryAuditReviewDecision } from "@/lib/inventory-audit/review";
import { resolveInventoryAuditFinalCounts } from "@/lib/inventory-audit/ownerFinalCount";
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
  finalStockTotal?: unknown;
  finalStockMaintenance?: unknown;
};

const DECISIONS = new Set<InventoryAuditReviewDecision>([
  "apply_audit",
  "keep_ledger",
  "recount",
]);

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
    const body = (await req.json()) as { decisions?: unknown };
    if (!Array.isArray(body.decisions)) {
      return inventoryJsonResponse(
        { error: "장비별 검토 결과가 필요합니다.", code: "invalid_decisions" },
        422,
      );
    }
    const inputs = body.decisions as DecisionInput[];
    const inputMap = new Map<string, DecisionInput>();
    for (const input of inputs) {
      if (
        typeof input.equipmentId !== "string" ||
        typeof input.decision !== "string" ||
        !DECISIONS.has(input.decision as InventoryAuditReviewDecision) ||
        inputMap.has(input.equipmentId)
      ) {
        return inventoryJsonResponse(
          { error: "장비별 검토 결과가 올바르지 않습니다.", code: "invalid_decisions" },
          422,
        );
      }
      inputMap.set(input.equipmentId, input);
    }

    const client = getInventoryAuditServiceClient();
    const review = await loadInventoryAuditReview(client, sessionId);
    if (inputMap.size !== review.items.length) {
      return inventoryJsonResponse(
        { error: "모든 장비의 검토 결과가 필요합니다.", code: "incomplete_decisions" },
        422,
      );
    }

    const decisions = review.items.map((item) => {
      const input = inputMap.get(item.equipmentId);
      if (!input) throw new Error(`missing decision for ${item.equipmentId}`);
      const decision = input.decision as InventoryAuditReviewDecision;
      if (decision === "apply_audit" && item.candidateTotal === null) {
        const error = new Error(`${item.name}: 미계수 장비는 실사를 적용할 수 없습니다.`) as Error & { code: string };
        error.code = "22023";
        throw error;
      }
      const finalCounts =
        decision === "apply_audit"
          ? resolveInventoryAuditFinalCounts(input, {
              finalStockTotal: item.candidateTotal,
              finalStockMaintenance: item.finalStockMaintenance,
            })
          : null;
      return {
        equipment_id: item.equipmentId,
        decision,
        final_stock_total: finalCounts?.finalStockTotal ?? null,
        final_stock_maint: finalCounts?.finalStockMaintenance ?? null,
        final_state: decision === "apply_audit" ? item.finalState : null,
        final_open_issues:
          decision === "apply_audit" ? item.finalOpenIssues : [],
        other_confirmed_offsite_qty: item.resolvedOffsiteQty,
        review_note:
          typeof input.reviewNote === "string" ? input.reviewNote.trim() : "",
      };
    });
    const { data, error } = await client.rpc("save_inventory_audit_review", {
      p_session_id: sessionId,
      p_reviewer: owner.id,
      p_reviewer_email: owner.email.trim().toLowerCase(),
      p_decisions: decisions,
    });
    if (error) throw error;
    return inventoryJsonResponse(data);
  } catch (error) {
    return inventoryErrorResponse(error);
  }
}
