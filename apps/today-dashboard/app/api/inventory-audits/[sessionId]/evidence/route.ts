import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import {
  INVENTORY_AUDIT_EVIDENCE_BUCKET,
  InventoryAuditEvidenceInputError,
  InventoryAuditEvidenceUpstreamError,
  expectedInventoryAuditEvidencePath,
  isEvidenceAbortConflict,
  mapInventoryAuditEvidenceError,
  parseEvidenceDeleteInput,
  parseEvidenceQueryObservationId,
  parseEvidenceSessionId,
  persistInventoryAuditEvidence,
  readEvidenceRefPath,
  serializeOwnerEvidence,
  validateEvidenceUpload,
} from "@/lib/inventory-audit/evidence";
import {
  requireInventoryOwner,
  requireInventoryUser,
} from "@/lib/server/inventoryAuditAuth";
import { getInventoryAuditServiceClient } from "@/lib/server/inventoryAuditDb";
import { inventoryActorFromUser } from "@/lib/server/inventoryAuditHttp";

export const dynamic = "force-dynamic";

const SIGNED_URL_SECONDS = 300;
const READ_PAGE_SIZE = 500;
const SIGN_BATCH_SIZE = 100;

type RouteContext = {
  params: Promise<{ sessionId: string }>;
};
type ServiceClient = ReturnType<typeof getInventoryAuditServiceClient>;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function inventoryAuditEvidenceResponse(
  body: Record<string, unknown>,
  status = 200,
) {
  return NextResponse.json(
    { code: "ok", retryable: false, error: null, ...body },
    { status, headers: { "cache-control": "no-store" } },
  );
}

function evidenceErrorResponse(error: unknown) {
  const mapped = mapInventoryAuditEvidenceError(error);
  return inventoryAuditEvidenceResponse(
    {
      code: mapped.code,
      retryable: mapped.retryable,
      error: mapped.error,
    },
    mapped.status,
  );
}

function unauthorizedResponse() {
  return inventoryAuditEvidenceResponse(
    { code: "unauthorized", retryable: false, error: "로그인이 필요합니다." },
    401,
  );
}

function forbiddenResponse() {
  return inventoryAuditEvidenceResponse(
    {
      code: "forbidden",
      retryable: false,
      error: "재고 실사 사진을 검토할 권한이 없습니다.",
    },
    403,
  );
}

async function rpc(
  client: ServiceClient,
  functionName: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  const { data, error } = await client.rpc(functionName, input);
  if (error) throw error;
  return data;
}

function actorRpcInput(
  sessionId: string,
  observationId: string,
  evidenceId: string,
  actorId: string,
) {
  return {
    p_session_id: sessionId,
    p_observation_id: observationId,
    p_evidence_id: evidenceId,
    p_actor_id: actorId,
  };
}

async function removeExactObject(
  client: ServiceClient,
  expectedPath: string,
): Promise<void> {
  const { error } = await client.storage
    .from(INVENTORY_AUDIT_EVIDENCE_BUCKET)
    .remove([expectedPath]);
  if (error) throw error;
}

function assertServerPath(
  value: unknown,
  expectedPath: string,
  allowAbsent = false,
): void {
  const path = readEvidenceRefPath(value);
  if (allowAbsent && record(value)?.status === "absent" && path === null) return;
  if (path !== expectedPath) {
    const error = new Error("inventory audit evidence RPC returned an invalid path") as Error & {
      code: string;
    };
    error.code = "invalid_upstream_evidence_path";
    throw error;
  }
}

function staffEvidence(value: unknown) {
  const result = record(value);
  const evidence = record(result?.evidence);
  return {
    id: typeof evidence?.id === "string" ? evidence.id : null,
    status: typeof evidence?.status === "string" ? evidence.status : null,
    contentType:
      typeof evidence?.content_type === "string" ? evidence.content_type : null,
    sizeBytes:
      typeof evidence?.size_bytes === "number" ? evidence.size_bytes : null,
    createdAt:
      typeof evidence?.created_at === "string" ? evidence.created_at : null,
    uploadedAt:
      typeof evidence?.uploaded_at === "string" ? evidence.uploaded_at : null,
  };
}

export async function POST(req: NextRequest, context: RouteContext) {
  const user = await requireInventoryUser(req);
  const actor = inventoryActorFromUser(user);
  if (!actor) return unauthorizedResponse();

  let client: ServiceClient | null = null;
  let cleanup:
    | {
        sessionId: string;
        observationId: string;
        evidenceId: string;
        actorId: string;
        expectedPath: string;
      }
    | null = null;
  try {
    const { sessionId } = await context.params;
    const form = await req.formData();
    const fileValue = form.get("file");
    if (typeof File === "undefined" || !(fileValue instanceof File)) {
      throw new InventoryAuditEvidenceInputError(
        422,
        "invalid_evidence_file",
        "JPEG 사진 파일이 필요합니다.",
      );
    }
    const input = await validateEvidenceUpload({
      observationId: form.get("observationId"),
      evidenceId: form.get("evidenceId"),
      file: fileValue,
    });
    const expectedPath = expectedInventoryAuditEvidencePath(
      sessionId,
      input.observationId,
      input.evidenceId,
    );
    cleanup = {
      sessionId,
      observationId: input.observationId,
      evidenceId: input.evidenceId,
      actorId: actor.id,
      expectedPath,
    };
    client = getInventoryAuditServiceClient();
    const baseRpcInput = actorRpcInput(
      sessionId,
      input.observationId,
      input.evidenceId,
      actor.id,
    );

    const result = await persistInventoryAuditEvidence({
      expectedPath,
      reserve: async () => {
        const value = await rpc(client!, "reserve_inventory_audit_evidence", {
          ...baseRpcInput,
          p_content_type: "image/jpeg",
          p_size_bytes: input.sizeBytes,
        });
        assertServerPath(value, expectedPath);
        return value;
      },
      upload: async (path) => {
        const { error } = await client!.storage
          .from(INVENTORY_AUDIT_EVIDENCE_BUCKET)
          .upload(path, fileValue, {
            contentType: "image/jpeg",
            upsert: false,
          });
        if (error) throw error;
      },
      complete: async () => {
        const value = await rpc(
          client!,
          "complete_inventory_audit_evidence",
          baseRpcInput,
        );
        assertServerPath(value, expectedPath);
        return value;
      },
      remove: (path) => removeExactObject(client!, path),
    });

    if (result.kind === "discarded") {
      return inventoryAuditEvidenceResponse(
        {
          code: "evidence_discarded",
          retryable: false,
          error: "사진 삭제 요청이 먼저 완료되어 업로드를 반영하지 않았습니다.",
          discarded: true,
        },
        409,
      );
    }
    return inventoryAuditEvidenceResponse({
      uploaded: true,
      reused: result.reused,
      evidence: staffEvidence({ evidence: result.evidence }),
    });
  } catch (error) {
    // A concurrent explicit DELETE may have left an aborting tombstone. POST
    // never starts an abort, but it may finish removing an object that lost
    // the completion race. The browser still receives non-2xx and keeps its
    // local job until the explicit discard path succeeds.
    if (client && cleanup && isEvidenceAbortConflict(error)) {
      try {
        await removeExactObject(client, cleanup.expectedPath);
      } catch {
        // Preserve and report the original state conflict; DELETE is retryable.
      }
      return inventoryAuditEvidenceResponse(
        {
          code: "evidence_discarded",
          retryable: false,
          error: "사진 삭제 요청이 먼저 처리되었습니다.",
          discarded: true,
        },
        409,
      );
    }
    return evidenceErrorResponse(error);
  }
}

export async function DELETE(req: NextRequest, context: RouteContext) {
  const user = await requireInventoryUser(req);
  const actor = inventoryActorFromUser(user);
  if (!actor) return unauthorizedResponse();

  try {
    const { sessionId } = await context.params;
    const input = parseEvidenceDeleteInput(await req.json());
    const expectedPath = expectedInventoryAuditEvidencePath(
      sessionId,
      input.observationId,
      input.evidenceId,
    );
    const client = getInventoryAuditServiceClient();
    const rpcInput = actorRpcInput(
      sessionId,
      input.observationId,
      input.evidenceId,
      actor.id,
    );
    const abortResult = await rpc(
      client,
      "abort_inventory_audit_evidence",
      rpcInput,
    );
    assertServerPath(abortResult, expectedPath, true);
    const abortRecord = record(abortResult);
    const absent = abortRecord?.status === "absent";
    if (!absent) {
      await removeExactObject(client, expectedPath);
      const finalized = await rpc(
        client,
        "finalize_inventory_audit_evidence_abort",
        rpcInput,
      );
      assertServerPath(finalized, expectedPath);
    }
    return inventoryAuditEvidenceResponse({
      discarded: true,
      absent,
      observationId: input.observationId,
      evidenceId: input.evidenceId,
    });
  } catch (error) {
    return evidenceErrorResponse(error);
  }
}

async function loadOwnerEvidenceRows(
  client: ServiceClient,
  sessionId: string,
  observationId: string | null,
): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  for (let from = 0; ; from += READ_PAGE_SIZE) {
    let query = client
      .from("inventory_audit_observations")
      .select("id,evidence_refs")
      .eq("session_id", sessionId)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + READ_PAGE_SIZE - 1);
    if (observationId) query = query.eq("id", observationId);
    const { data, error } = await query;
    if (error) throw error;
    const page = (data ?? []) as Record<string, unknown>[];
    rows.push(...page);
    if (page.length < READ_PAGE_SIZE) break;
  }
  return rows;
}

async function requireExistingAuditSession(
  client: ServiceClient,
  sessionId: string,
): Promise<void> {
  const { data, error } = await client
    .from("inventory_audit_sessions")
    .select("id")
    .eq("id", sessionId)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    const notFound = new Error("inventory audit session not found") as Error & {
      code: string;
    };
    notFound.code = "P0002";
    throw notFound;
  }
}

export async function GET(req: NextRequest, context: RouteContext) {
  const user = await requireInventoryUser(req);
  if (!user) return unauthorizedResponse();
  const owner = await requireInventoryOwner(req, async () => user);
  if (!owner) return forbiddenResponse();

  try {
    const { sessionId: sessionIdValue } = await context.params;
    const sessionId = parseEvidenceSessionId(sessionIdValue);
    const observationId = parseEvidenceQueryObservationId(
      req.nextUrl.searchParams.get("observationId"),
    );
    const client = getInventoryAuditServiceClient();
    await requireExistingAuditSession(client, sessionId);
    const rows = await loadOwnerEvidenceRows(client, sessionId, observationId);
    const uploaded: Array<{
      observationId: string;
      value: unknown;
      path: string;
    }> = [];
    for (const row of rows) {
      if (typeof row.id !== "string" || !Array.isArray(row.evidence_refs)) continue;
      for (const value of row.evidence_refs) {
        const ref = record(value);
        if (ref?.status !== "uploaded" || typeof ref.id !== "string") continue;
        const expectedPath = expectedInventoryAuditEvidencePath(
          sessionId,
          row.id,
          ref.id,
        );
        const path = readEvidenceRefPath(value);
        if (path !== expectedPath) {
          const error = new Error("inventory audit evidence database path is invalid") as Error & {
            code: string;
          };
          error.code = "invalid_upstream_evidence_path";
          throw error;
        }
        uploaded.push({ observationId: row.id, value, path });
      }
    }

    const signedByPath = new Map<string, string>();
    for (let index = 0; index < uploaded.length; index += SIGN_BATCH_SIZE) {
      const paths = uploaded
        .slice(index, index + SIGN_BATCH_SIZE)
        .map((entry) => entry.path);
      const { data, error } = await client.storage
        .from(INVENTORY_AUDIT_EVIDENCE_BUCKET)
        .createSignedUrls(paths, 300);
      if (error) throw error;
      for (const signed of data ?? []) {
        if (signed.error || !signed.signedUrl || !signed.path) {
          throw new InventoryAuditEvidenceUpstreamError(signed.error);
        }
        signedByPath.set(signed.path, signed.signedUrl);
      }
    }
    const evidence = uploaded.map((entry) => {
      const signedUrl = signedByPath.get(entry.path);
      if (!signedUrl) throw new InventoryAuditEvidenceUpstreamError();
      return serializeOwnerEvidence(entry.observationId, entry.value, signedUrl);
    });
    return inventoryAuditEvidenceResponse({
      sessionId,
      observationId,
      signedUrlExpiresInSeconds: SIGNED_URL_SECONDS,
      evidence,
    });
  } catch (error) {
    return evidenceErrorResponse(error);
  }
}
