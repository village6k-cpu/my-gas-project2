import "server-only";

import { buildInventoryAuditReview } from "@/lib/inventory-audit/review";
import { getInventoryAuditServiceClient } from "@/lib/server/inventoryAuditDb";

export type InventoryAuditReviewClient = ReturnType<
  typeof getInventoryAuditServiceClient
>;

async function requireRows<T>(
  query: PromiseLike<{ data: T[] | null; error: unknown }>,
): Promise<T[]> {
  const { data, error } = await query;
  if (error) throw error;
  return data ?? [];
}

export async function loadInventoryAuditReview(
  client: InventoryAuditReviewClient,
  sessionId: string,
) {
  const { data: session, error: sessionError } = await client
    .from("inventory_audit_sessions")
    .select("id,status,started_by_email,submitted_at,approved_at")
    .eq("id", sessionId)
    .maybeSingle();
  if (sessionError) throw sessionError;
  if (!session) {
    const error = new Error("재고 실사를 찾지 못했습니다.") as Error & {
      code: string;
    };
    error.code = "P0002";
    throw error;
  }

  const [snapshotRows, observationRows, rentalExceptionRows, decisionRows, approvalRows, ledgerRows] =
    await Promise.all([
      requireRows<Record<string, unknown>>(
        client
          .from("inventory_audit_snapshot_items")
          .select(
            "equipment_id,name,major,category,ledger_stock_total,ledger_stock_maint,ledger_state,ledger_open_issues,ledger_updated_at,active_rental_qty,rental_match_status",
          )
          .eq("session_id", sessionId)
          .order("equipment_id", { ascending: true }),
      ),
      requireRows<Record<string, unknown>>(
        client
          .from("inventory_audit_observations")
          .select(
            "id,equipment_id,temporary_code,temporary_label,location,count_normal,count_maintenance,count_damaged,count_condition_unknown,missing_components,note,identification_status,client_updated_at",
          )
          .eq("session_id", sessionId)
          .order("created_at", { ascending: true }),
      ),
      requireRows<Record<string, unknown>>(
        client
          .from("inventory_audit_snapshot_rental_exceptions")
          .select(
            "id,raw_name,normalized_name,reported_qty,reason,resolution,resolved_equipment_id,reviewed_at",
          )
          .eq("session_id", sessionId)
          .order("raw_name", { ascending: true }),
      ),
      requireRows<Record<string, unknown>>(
        client
          .from("inventory_audit_decisions")
          .select("equipment_id,decision,final_stock_total,final_stock_maint,review_note,reviewed_at")
          .eq("session_id", sessionId),
      ),
      requireRows<Record<string, unknown>>(
        client
          .from("inventory_audit_item_approvals")
          .select("equipment_id,decision,final_stock_total,final_stock_maint,approved_by_email,approved_at")
          .eq("session_id", sessionId),
      ),
      requireRows<Record<string, unknown>>(
        client
          .from("equipment_ledger")
          .select("equipment_id,updated_at")
          .order("equipment_id", { ascending: true }),
      ),
    ]);

  return buildInventoryAuditReview({
    session: session as Record<string, unknown>,
    snapshotRows,
    observationRows,
    rentalExceptionRows,
    decisionRows,
    approvalRows,
    ledgerRows,
  });
}
