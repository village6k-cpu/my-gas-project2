import "server-only";

import {
  buildRentalSnapshot,
  type RentalLedgerRow,
  type RentalScheduleItemRow,
  type RentalTradeRow,
} from "@/lib/inventory-audit/snapshot";
import {
  buildStaffWorkspace,
  isUuid,
  serializeStaffObservation,
} from "@/lib/inventory-audit/staff";
import { getInventoryAuditServiceClient } from "@/lib/server/inventoryAuditDb";

export type InventoryAuditServiceClient = ReturnType<
  typeof getInventoryAuditServiceClient
>;

const PAGE_SIZE = 500;
const TRADE_BATCH_SIZE = 100;
const SESSION_SELECT =
  "id,mode,status,cutoff_at,started_by,movement_frozen,started_at,submitted_at,parent_session_id,created_at,updated_at";
const OWNER_SESSION_SELECT = `${SESSION_SELECT},started_by_email`;
const CATALOG_SELECT = "equipment_id,name,aliases,major,category";
const OBSERVATION_SELECT =
  "id,equipment_id,temporary_code,temporary_label,location,count_normal,count_maintenance,count_damaged,count_condition_unknown,missing_components,note,identification_status,evidence_refs,client_updated_at,created_at,updated_at";

type PageResult<T> = {
  data: T[] | null;
  error: unknown;
};

async function fetchAllPages<T>(
  fetchPage: (from: number, to: number) => PromiseLike<PageResult<T>>,
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const result = await fetchPage(from, from + PAGE_SIZE - 1);
    if (result.error) throw result.error;
    const page = result.data ?? [];
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return rows;
}

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

export async function loadGlobalInventoryAuditDraft(
  client: InventoryAuditServiceClient,
): Promise<Record<string, unknown> | null> {
  const { data, error } = await client
    .from("inventory_audit_sessions")
    .select("id,started_by")
    .eq("mode", "full_shop")
    .eq("status", "draft")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data as Record<string, unknown> | null) ?? null;
}

async function loadLatestCallerSession(
  client: InventoryAuditServiceClient,
  userId: string,
): Promise<Record<string, unknown> | null> {
  const { data, error } = await client
    .from("inventory_audit_sessions")
    .select(SESSION_SELECT)
    .eq("started_by", userId)
    .in("status", ["draft", "submitted", "in_review", "recount_requested"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data as Record<string, unknown> | null) ?? null;
}

async function loadOwnerQueue(
  client: InventoryAuditServiceClient,
): Promise<Record<string, unknown>[]> {
  return fetchAllPages<Record<string, unknown>>((from, to) =>
    client
      .from("inventory_audit_sessions")
      .select(OWNER_SESSION_SELECT)
      .in("status", ["submitted", "in_review"])
      .order("submitted_at", { ascending: true, nullsFirst: false })
      .order("created_at", { ascending: true })
      .range(from, to),
  );
}

async function loadCatalog(
  client: InventoryAuditServiceClient,
  sessionId: string,
): Promise<Record<string, unknown>[]> {
  return fetchAllPages<Record<string, unknown>>((from, to) =>
    client
      .from("inventory_audit_snapshot_items")
      .select(CATALOG_SELECT)
      .eq("session_id", sessionId)
      .order("equipment_id", { ascending: true })
      .range(from, to),
  );
}

async function loadObservations(
  client: InventoryAuditServiceClient,
  sessionId: string,
  userId: string,
): Promise<Record<string, unknown>[]> {
  return fetchAllPages<Record<string, unknown>>((from, to) =>
    client
      .from("inventory_audit_observations")
      .select(OBSERVATION_SELECT)
      .eq("session_id", sessionId)
      .eq("observed_by", userId)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to),
  );
}

export async function loadStaffWorkspace(
  client: InventoryAuditServiceClient,
  userId: string,
  isOwner: boolean,
) {
  const [globalDraft, latestCallerSessionRow, ownerQueueRows] = await Promise.all([
    loadGlobalInventoryAuditDraft(client),
    loadLatestCallerSession(client, userId),
    isOwner ? loadOwnerQueue(client) : Promise.resolve([]),
  ]);
  const activeSessionId =
    latestCallerSessionRow?.status === "draft" &&
    typeof latestCallerSessionRow.id === "string"
      ? latestCallerSessionRow.id
      : null;
  const [catalogRows, observationRows] = activeSessionId
    ? await Promise.all([
        loadCatalog(client, activeSessionId),
        loadObservations(client, activeSessionId, userId),
      ])
    : [[], []];
  const workspace = buildStaffWorkspace({
    userId,
    isOwner,
    globalDraft,
    callerSessions: latestCallerSessionRow ? [latestCallerSessionRow] : [],
    catalogRows,
    observationRows,
    ownerQueueRows,
  });

  // This explicit field is part of the UI contract: submitted staff must not
  // fall back to the start card after their draft becomes immutable.
  return { ...workspace, latestCallerSession: workspace.latestCallerSession };
}

export async function loadInventoryAuditStartSources(
  client: InventoryAuditServiceClient,
): Promise<{
  ledgerRows: RentalLedgerRow[];
  trades: RentalTradeRow[];
  scheduleItems: RentalScheduleItemRow[];
}> {
  const [ledgerRows, trades] = await Promise.all([
    fetchAllPages<RentalLedgerRow>((from, to) =>
      client
        .from("equipment_ledger")
        .select("equipment_id,name,aliases,state")
        .neq("state", "보관종료")
        .neq("equipment_id", "SYS-000")
        .order("equipment_id", { ascending: true })
        .range(from, to),
    ),
    fetchAllPages<RentalTradeRow>((from, to) =>
      client
        .from("trades")
        .select("trade_id,contract_status,return_done")
        .eq("return_done", false)
        .not("contract_status", "in", '("취소","반납완료")')
        .order("trade_id", { ascending: true })
        .range(from, to),
    ),
  ]);
  const scheduleItems: RentalScheduleItemRow[] = [];

  for (const tradeIds of chunks(
    trades.map((trade) => trade.trade_id),
    TRADE_BATCH_SIZE,
  )) {
    const rows = await fetchAllPages<RentalScheduleItemRow>((from, to) =>
      client
        .from("schedule_items")
        .select(
          "schedule_id,trade_id,name,qty,taken_qty,is_set_header,is_component,off_catalog,onsite,checkout_state",
        )
        .in("trade_id", tradeIds)
        .or("taken_qty.gt.0,checkout_state.eq.taken")
        .order("trade_id", { ascending: true })
        .order("schedule_id", { ascending: true })
        .range(from, to),
    );
    scheduleItems.push(...rows);
  }

  return { ledgerRows, trades, scheduleItems };
}

export async function startInventoryAudit(
  client: InventoryAuditServiceClient,
  actor: { id: string; email: string },
  sources: Awaited<ReturnType<typeof loadInventoryAuditStartSources>>,
): Promise<{ sessionId: string; reused: boolean }> {
  const rental = buildRentalSnapshot(
    sources.ledgerRows,
    sources.trades,
    sources.scheduleItems,
  );
  const { data, error } = await client.rpc("start_inventory_audit", {
    p_started_by: actor.id,
    p_started_by_email: actor.email,
    p_movement_frozen: true,
    p_rental_snapshot: [...rental.byEquipment.values()],
    p_rental_exceptions: rental.exceptions,
  });
  if (error) throw error;
  if (!data || typeof data !== "object" || !isUuid(data.session_id)) {
    throw new Error("inventory audit start RPC returned an invalid response");
  }
  return { sessionId: data.session_id, reused: data.reused === true };
}

export async function loadCurrentStaffObservation(
  client: InventoryAuditServiceClient,
  sessionId: string,
  observationId: string,
  userId: string,
) {
  const { data, error } = await client
    .from("inventory_audit_observations")
    .select(OBSERVATION_SELECT)
    .eq("session_id", sessionId)
    .eq("id", observationId)
    .eq("observed_by", userId)
    .maybeSingle();
  if (error) throw error;
  return data
    ? serializeStaffObservation(data as Record<string, unknown>)
    : null;
}
