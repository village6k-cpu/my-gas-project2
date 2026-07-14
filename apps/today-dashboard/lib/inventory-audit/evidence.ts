export const INVENTORY_AUDIT_EVIDENCE_BUCKET = "inventory-audit-evidence";
export const INVENTORY_AUDIT_EVIDENCE_MAX_BYTES = 3_500_000;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class InventoryAuditEvidenceInputError extends Error {
  readonly status: 413 | 422;
  readonly code: string;

  constructor(status: 413 | 422, code: string, message: string) {
    super(message);
    this.name = "InventoryAuditEvidenceInputError";
    this.status = status;
    this.code = code;
  }
}

export class InventoryAuditEvidencePendingError extends Error {
  readonly status = 502 as const;
  readonly code = "evidence_completion_pending" as const;
  readonly retryable = true as const;

  constructor() {
    super("사진 저장 완료 확인을 다시 시도해 주세요.");
    this.name = "InventoryAuditEvidencePendingError";
  }
}

export class InventoryAuditEvidenceUpstreamError extends Error {
  readonly status = 502 as const;
  readonly code = "storage_upstream_error" as const;
  readonly retryable = true as const;

  constructor(cause?: unknown) {
    super("사진 저장소 응답을 확인하지 못했습니다.", {
      cause: cause instanceof Error ? cause : undefined,
    });
    this.name = "InventoryAuditEvidenceUpstreamError";
  }
}

export interface EvidenceFileLike {
  size: number;
  type: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface EvidenceUploadInput {
  observationId: string;
  evidenceId: string;
  file: EvidenceFileLike;
  sizeBytes: number;
}

export interface InventoryAuditEvidenceError {
  status: number;
  code: string;
  retryable: boolean;
  error: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function requireUuid(value: unknown, code: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new InventoryAuditEvidenceInputError(
      422,
      code,
      "사진 식별자가 올바르지 않습니다.",
    );
  }
  return value;
}

function exactObject(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new InventoryAuditEvidenceInputError(
      422,
      "invalid_json_body",
      "JSON 객체가 필요합니다.",
    );
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new InventoryAuditEvidenceInputError(
      422,
      "invalid_request_fields",
      "사진 요청 필드가 올바르지 않습니다.",
    );
  }
  return value;
}

function isEvidenceFileLike(value: unknown): value is EvidenceFileLike {
  return (
    isRecord(value) &&
    typeof value.size === "number" &&
    typeof value.type === "string" &&
    typeof value.arrayBuffer === "function"
  );
}

export function expectedInventoryAuditEvidencePath(
  sessionIdValue: unknown,
  observationIdValue: unknown,
  evidenceIdValue: unknown,
): string {
  const sessionId = requireUuid(sessionIdValue, "invalid_session_id");
  const observationId = requireUuid(
    observationIdValue,
    "invalid_observation_id",
  );
  const evidenceId = requireUuid(evidenceIdValue, "invalid_evidence_id");
  return `${sessionId}/${observationId}/${evidenceId}.jpg`;
}

export async function validateEvidenceUpload(value: {
  observationId?: unknown;
  evidenceId?: unknown;
  file?: unknown;
}): Promise<EvidenceUploadInput> {
  const observationId = requireUuid(
    value.observationId,
    "invalid_observation_id",
  );
  const evidenceId = requireUuid(value.evidenceId, "invalid_evidence_id");
  if (!isEvidenceFileLike(value.file)) {
    throw new InventoryAuditEvidenceInputError(
      422,
      "invalid_evidence_file",
      "JPEG 사진 파일이 필요합니다.",
    );
  }
  const file = value.file;
  if (file.type !== "image/jpeg") {
    throw new InventoryAuditEvidenceInputError(
      422,
      "invalid_evidence_type",
      "사진은 JPEG 형식이어야 합니다.",
    );
  }
  if (file.size <= 0) {
    throw new InventoryAuditEvidenceInputError(
      422,
      "invalid_evidence_file",
      "비어 있는 사진은 업로드할 수 없습니다.",
    );
  }
  if (file.size > INVENTORY_AUDIT_EVIDENCE_MAX_BYTES) {
    throw new InventoryAuditEvidenceInputError(
      413,
      "evidence_too_large",
      "사진은 3.5MB 이하여야 합니다.",
    );
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (
    bytes.length < 3 ||
    bytes[0] !== 0xff ||
    bytes[1] !== 0xd8 ||
    bytes[2] !== 0xff
  ) {
    throw new InventoryAuditEvidenceInputError(
      422,
      "invalid_jpeg",
      "JPEG 파일 내용이 올바르지 않습니다.",
    );
  }
  return { observationId, evidenceId, file, sizeBytes: file.size };
}

export function parseEvidenceDeleteInput(value: unknown): {
  observationId: string;
  evidenceId: string;
} {
  const body = exactObject(value, ["observationId", "evidenceId"]);
  return {
    observationId: requireUuid(
      body.observationId,
      "invalid_observation_id",
    ),
    evidenceId: requireUuid(body.evidenceId, "invalid_evidence_id"),
  };
}

export function parseEvidenceQueryObservationId(
  value: string | null,
): string | null {
  return value === null
    ? null
    : requireUuid(value, "invalid_observation_id");
}

export function parseEvidenceSessionId(value: unknown): string {
  return requireUuid(value, "invalid_session_id");
}

function errorCode(error: unknown): string {
  return isRecord(error) && typeof error.code === "string" ? error.code : "";
}

function errorMessage(error: unknown): string {
  return isRecord(error) && typeof error.message === "string"
    ? error.message
    : error instanceof Error
      ? error.message
      : "";
}

export function isEvidenceNotFoundError(error: unknown): boolean {
  return errorCode(error) === "P0002";
}

export function isEvidenceAbortConflict(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return (
    (errorCode(error) === "P0001" || errorCode(error) === "40001") &&
    (message.includes("abort") || message.includes("tombstone"))
  );
}

export function mapInventoryAuditEvidenceError(
  error: unknown,
): InventoryAuditEvidenceError {
  if (error instanceof InventoryAuditEvidenceInputError) {
    return {
      status: error.status,
      code: error.code,
      retryable: false,
      error: error.message,
    };
  }
  if (error instanceof InventoryAuditEvidencePendingError) {
    return {
      status: error.status,
      code: error.code,
      retryable: error.retryable,
      error: error.message,
    };
  }
  if (error instanceof InventoryAuditEvidenceUpstreamError) {
    return {
      status: error.status,
      code: error.code,
      retryable: error.retryable,
      error: error.message,
    };
  }
  if (error instanceof SyntaxError) {
    return {
      status: 422,
      code: "invalid_json",
      retryable: false,
      error: "JSON 요청이 올바르지 않습니다.",
    };
  }
  const record = isRecord(error) ? error : {};
  const code = errorCode(error);
  const message = errorMessage(error).toLowerCase();
  const name = typeof record.name === "string" ? record.name : "";
  const hasExplicitEmptyCode =
    Object.prototype.hasOwnProperty.call(record, "code") && code === "";
  if (
    record.status === 503 &&
    code === "inventory_audit_service_unavailable"
  ) {
    return {
      status: 503,
      code: "inventory_audit_service_unavailable",
      retryable: true,
      error: "재고 실사 서버 설정을 확인해 주세요.",
    };
  }
  if (code === "42501") {
    return {
      status: 403,
      code: "forbidden",
      retryable: false,
      error: "이 실사 사진에 접근할 권한이 없습니다.",
    };
  }
  if (code === "P0002") {
    return {
      status: 404,
      code: "not_found",
      retryable: false,
      error: "재고 실사 사진 항목을 찾을 수 없습니다.",
    };
  }
  if (code === "40001") {
    return {
      status: 409,
      code: "evidence_conflict",
      retryable: false,
      error: "사진 상태가 다른 요청과 충돌합니다.",
    };
  }
  if (
    code === "P0001" &&
    message.includes("uploaded evidence cannot be aborted")
  ) {
    return {
      status: 409,
      code: "uploaded_evidence_immutable",
      retryable: false,
      error: "업로드가 완료된 사진은 삭제할 수 없습니다.",
    };
  }
  if (code === "P0001" || code === "23505") {
    return {
      status: 409,
      code: "evidence_state_conflict",
      retryable: false,
      error: "현재 사진 상태와 요청이 충돌합니다.",
    };
  }
  if (code === "22023" || code === "22P02" || code === "23514") {
    return {
      status: 422,
      code: "invalid_request",
      retryable: false,
      error: "사진 요청 값이 올바르지 않습니다.",
    };
  }
  if (
    (record.status === 0 && code === "") ||
    hasExplicitEmptyCode ||
    name === "StorageUnknownError"
  ) {
    return {
      status: 502,
      code: "storage_upstream_error",
      retryable: true,
      error: "사진 저장소 응답을 확인하지 못했습니다.",
    };
  }
  if (
    code ||
    typeof record.statusCode === "string" ||
    typeof record.statusCode === "number"
  ) {
    return {
      status: 502,
      code: "storage_upstream_error",
      retryable: true,
      error: "사진 저장소 응답을 확인하지 못했습니다.",
    };
  }
  return {
    status: 500,
    code: "internal_error",
    retryable: false,
    error: "재고 실사 사진 처리 중 오류가 발생했습니다.",
  };
}

interface EvidenceRef {
  id: string;
  path: string;
  status: string;
  content_type?: string;
  size_bytes?: number;
  created_at?: string;
  uploaded_at?: string;
  aborted_at?: string;
}

function extractEvidenceRef(value: unknown): EvidenceRef | null {
  if (!isRecord(value)) return null;
  const candidate = isRecord(value.evidence) ? value.evidence : value;
  if (
    typeof candidate.id !== "string" ||
    typeof candidate.path !== "string" ||
    typeof candidate.status !== "string"
  ) {
    return null;
  }
  return candidate as unknown as EvidenceRef;
}

function verifyEvidencePath(value: unknown, expectedPath: string): EvidenceRef {
  const ref = extractEvidenceRef(value);
  if (!ref || ref.path !== expectedPath) {
    const error = new Error("inventory audit evidence RPC returned an invalid path") as Error & {
      code: string;
    };
    error.code = "invalid_upstream_evidence_path";
    throw error;
  }
  return ref;
}

export interface PersistInventoryAuditEvidenceInput {
  expectedPath: string;
  reserve(): Promise<unknown>;
  upload(path: string): Promise<unknown>;
  complete(): Promise<unknown>;
  remove(path: string): Promise<unknown>;
}

export type PersistInventoryAuditEvidenceResult =
  | { kind: "uploaded"; evidence: EvidenceRef; reused: boolean }
  | { kind: "discarded" };

/**
 * Coordinates the private object write with the database reservation.
 * Any Storage/complete failure deliberately retains the reservation so a
 * same-evidence-id retry can verify the exact existing object and converge.
 * Tombstoning is reserved for the explicit DELETE flow.
 */
export async function persistInventoryAuditEvidence(
  input: PersistInventoryAuditEvidenceInput,
): Promise<PersistInventoryAuditEvidenceResult> {
  const reservedValue = await input.reserve();
  const reserved = verifyEvidencePath(reservedValue, input.expectedPath);
  if (reserved.status === "uploaded") {
    return { kind: "uploaded", evidence: reserved, reused: true };
  }
  if (reserved.status !== "pending") {
    const error = new Error("inventory audit evidence reservation is not pending") as Error & {
      code: string;
    };
    error.code = "40001";
    throw error;
  }

  let uploadSucceeded = false;
  let uploadFailure: unknown = null;
  try {
    await input.upload(input.expectedPath);
    uploadSucceeded = true;
  } catch (error) {
    uploadFailure = error;
  }

  try {
    const completedValue = await input.complete();
    const completed = verifyEvidencePath(completedValue, input.expectedPath);
    if (completed.status !== "uploaded") {
      const error = new Error("inventory audit evidence completion is not uploaded") as Error & {
        code: string;
      };
      error.code = "invalid_upstream_evidence_status";
      throw error;
    }
    return { kind: "uploaded", evidence: completed, reused: uploadFailure !== null };
  } catch (completionError) {
    if (isEvidenceAbortConflict(completionError)) {
      await input.remove(input.expectedPath);
      return { kind: "discarded" };
    }
    if (uploadSucceeded) {
      if (isEvidenceNotFoundError(completionError)) {
        throw new InventoryAuditEvidencePendingError();
      }
      throw completionError;
    }
    // Even a proven missing object is retryable: the browser still owns the
    // exact Blob and UUID. Keep the pending reservation rather than making the
    // UUID unusable with a tombstone.
    throw uploadFailure ?? completionError;
  }
}

export function serializeOwnerEvidence(
  observationId: string,
  value: unknown,
  signedUrl: string,
) {
  const ref = extractEvidenceRef(value);
  if (!ref || ref.status !== "uploaded") return null;
  return {
    observationId,
    evidenceId: ref.id,
    contentType:
      typeof ref.content_type === "string" ? ref.content_type : "image/jpeg",
    sizeBytes:
      typeof ref.size_bytes === "number" && Number.isFinite(ref.size_bytes)
        ? ref.size_bytes
        : null,
    createdAt: typeof ref.created_at === "string" ? ref.created_at : null,
    uploadedAt: typeof ref.uploaded_at === "string" ? ref.uploaded_at : null,
    signedUrl,
    expiresInSeconds: 300,
  };
}

export function readEvidenceRefPath(value: unknown): string | null {
  return extractEvidenceRef(value)?.path ?? null;
}
