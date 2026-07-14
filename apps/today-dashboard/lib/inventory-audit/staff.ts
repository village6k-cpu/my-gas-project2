const POSTGRES_INTEGER_MAX = 2_147_483_647;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;

const OBSERVATION_KEYS = [
  "id",
  "equipmentId",
  "temporaryCode",
  "temporaryLabel",
  "location",
  "countNormal",
  "countMaintenance",
  "countDamaged",
  "countConditionUnknown",
  "missingComponents",
  "note",
  "identificationStatus",
  "clientUpdatedAt",
  "expectedClientUpdatedAt",
] as const;

export type IdentificationStatus = "confirmed" | "uncertain" | "unlisted";

export interface InventoryActor {
  id: string;
  email: string;
}

export class InventoryAuditInputError extends Error {
  readonly status = 422 as const;
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "InventoryAuditInputError";
    this.code = code;
  }
}

function inputError(code: string, message: string): never {
  throw new InventoryAuditInputError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function requireExactKeys(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (!isRecord(value)) inputError("invalid_json_body", "JSON 객체가 필요합니다.");
  const actualKeys = Object.keys(value).sort();
  const expectedKeys = [...keys].sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    inputError("invalid_request_fields", "요청 필드가 올바르지 않습니다.");
  }
  return value;
}

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

export function isStrictIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_TIMESTAMP_PATTERN.test(value)) {
    return false;
  }
  const parts = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/,
  );
  if (!parts) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] =
    parts;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const calendarDate = new Date(Date.UTC(year, month - 1, day));
  return (
    Number.isFinite(Date.parse(value)) &&
    calendarDate.getUTCFullYear() === year &&
    calendarDate.getUTCMonth() === month - 1 &&
    calendarDate.getUTCDate() === day &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59
  );
}

function requireUuid(value: unknown, code = "invalid_uuid"): string {
  if (!isUuid(value)) inputError(code, "UUID가 올바르지 않습니다.");
  return value;
}

function requireTimestamp(value: unknown): string {
  if (!isStrictIsoTimestamp(value)) {
    inputError("invalid_client_timestamp", "수정 시각이 올바르지 않습니다.");
  }
  return value;
}

function nullableTimestamp(value: unknown): string | null {
  if (value === null) return null;
  return requireTimestamp(value);
}

function requireBoundedText(
  value: unknown,
  options: { code: string; label: string; max: number; blank?: boolean },
): string {
  if (typeof value !== "string" || value.length > options.max) {
    inputError(options.code, `${options.label} 값이 올바르지 않습니다.`);
  }
  const trimmed = value.trim();
  if (!options.blank && !trimmed) {
    inputError(options.code, `${options.label} 값이 필요합니다.`);
  }
  return options.blank ? value : trimmed;
}

function nullableBoundedText(
  value: unknown,
  options: { code: string; label: string; max: number },
): string | null {
  if (value === null) return null;
  const result = requireBoundedText(value, { ...options, blank: true });
  return result.trim() || null;
}

function requireCount(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > POSTGRES_INTEGER_MAX
  ) {
    inputError("invalid_observation_count", "수량은 0 이상의 정수여야 합니다.");
  }
  return value;
}

function requireMissingComponents(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 50) {
    inputError("invalid_missing_components", "누락 구성품 목록이 올바르지 않습니다.");
  }
  return value.map((component) => {
    if (typeof component !== "string" || !component.trim() || component.length > 200) {
      inputError("invalid_missing_components", "누락 구성품 값이 올바르지 않습니다.");
    }
    return component.trim();
  });
}

function requireActor(actor: InventoryActor): InventoryActor {
  const id = requireUuid(actor?.id, "invalid_actor");
  const email =
    typeof actor?.email === "string" ? actor.email.trim().toLowerCase() : "";
  if (!email || email.length > 320) {
    inputError("invalid_actor", "검증된 사용자 이메일이 필요합니다.");
  }
  return { id, email };
}

export function parseStartInput(value: unknown): { movementFrozen: true } {
  const body = requireExactKeys(value, ["movementFrozen"]);
  if (body.movementFrozen !== true) {
    inputError(
      "movement_freeze_required",
      "전체 매장 장비 이동 중지 확인이 필요합니다.",
    );
  }
  return { movementFrozen: true };
}

export interface ObservationInput {
  id: string;
  equipmentId: string | null;
  temporaryCode: string | null;
  temporaryLabel: string | null;
  location: string;
  countNormal: number;
  countMaintenance: number;
  countDamaged: number;
  countConditionUnknown: number;
  missingComponents: string[];
  note: string;
  identificationStatus: IdentificationStatus;
  clientUpdatedAt: string;
  expectedClientUpdatedAt: string | null;
}

export function parseObservationInput(value: unknown): ObservationInput {
  const body = requireExactKeys(value, OBSERVATION_KEYS);
  const id = requireUuid(body.id, "invalid_observation_id");
  const equipmentId = nullableBoundedText(body.equipmentId, {
    code: "invalid_observation_identity",
    label: "장비 ID",
    max: 200,
  });
  const temporaryCode = nullableBoundedText(body.temporaryCode, {
    code: "invalid_observation_identity",
    label: "임시 코드",
    max: 120,
  });
  const temporaryLabel = nullableBoundedText(body.temporaryLabel, {
    code: "invalid_observation_label",
    label: "임시 장비명",
    max: 200,
  });
  const identificationStatus = body.identificationStatus;
  if (
    identificationStatus !== "confirmed" &&
    identificationStatus !== "uncertain" &&
    identificationStatus !== "unlisted"
  ) {
    inputError("invalid_observation_identity", "식별 상태가 올바르지 않습니다.");
  }
  const confirmedIdentity =
    identificationStatus === "confirmed" &&
    equipmentId !== null &&
    temporaryCode === null &&
    temporaryLabel === null;
  const temporaryIdentity =
    (identificationStatus === "uncertain" || identificationStatus === "unlisted") &&
    equipmentId === null &&
    temporaryCode !== null;
  if (!confirmedIdentity && !temporaryIdentity) {
    inputError("invalid_observation_identity", "관측 식별 정보가 올바르지 않습니다.");
  }

  return {
    id,
    equipmentId,
    temporaryCode,
    temporaryLabel,
    location: requireBoundedText(body.location, {
      code: "invalid_observation_location",
      label: "위치",
      max: 200,
    }),
    countNormal: requireCount(body.countNormal),
    countMaintenance: requireCount(body.countMaintenance),
    countDamaged: requireCount(body.countDamaged),
    countConditionUnknown: requireCount(body.countConditionUnknown),
    missingComponents: requireMissingComponents(body.missingComponents),
    note: requireBoundedText(body.note, {
      code: "invalid_observation_note",
      label: "메모",
      max: 4000,
      blank: true,
    }),
    identificationStatus,
    clientUpdatedAt: requireTimestamp(body.clientUpdatedAt),
    expectedClientUpdatedAt: nullableTimestamp(body.expectedClientUpdatedAt),
  };
}

export function buildSaveObservationRpcInput(
  sessionId: string,
  actorValue: InventoryActor,
  input: ObservationInput,
) {
  const actor = requireActor(actorValue);
  return {
    p_session_id: requireUuid(sessionId, "invalid_session_id"),
    p_observation_id: input.id,
    p_actor_id: actor.id,
    p_actor_email: actor.email,
    p_equipment_id: input.equipmentId,
    p_temporary_code: input.temporaryCode,
    p_temporary_label: input.temporaryLabel,
    p_location: input.location,
    p_count_normal: input.countNormal,
    p_count_maintenance: input.countMaintenance,
    p_count_damaged: input.countDamaged,
    p_count_condition_unknown: input.countConditionUnknown,
    p_missing_components: input.missingComponents,
    p_note: input.note,
    p_identification_status: input.identificationStatus,
    p_client_updated_at: input.clientUpdatedAt,
    p_expected_client_updated_at: input.expectedClientUpdatedAt,
  };
}

export interface DeleteObservationInput {
  observationId: string;
  expectedClientUpdatedAt: string;
}

export function parseDeleteObservationInput(value: unknown): DeleteObservationInput {
  const body = requireExactKeys(value, [
    "observationId",
    "expectedClientUpdatedAt",
  ]);
  return {
    observationId: requireUuid(body.observationId, "invalid_observation_id"),
    expectedClientUpdatedAt: requireTimestamp(body.expectedClientUpdatedAt),
  };
}

export function buildDeleteObservationRpcInput(
  sessionId: string,
  actorValue: InventoryActor,
  input: DeleteObservationInput,
) {
  const actor = requireActor(actorValue);
  return {
    p_session_id: requireUuid(sessionId, "invalid_session_id"),
    p_observation_id: input.observationId,
    p_actor_id: actor.id,
    p_expected_client_updated_at: input.expectedClientUpdatedAt,
  };
}

export interface SubmitInput {
  pendingObservationWrites: 0;
  pendingEvidenceUploads: 0;
}

export function parseSubmitInput(value: unknown): SubmitInput {
  if (!isRecord(value)) inputError("invalid_json_body", "JSON 객체가 필요합니다.");
  if (!("pendingObservationWrites" in value) || !("pendingEvidenceUploads" in value)) {
    inputError("pending_counts_required", "미전송 건수를 모두 확인해야 합니다.");
  }
  const body = requireExactKeys(value, [
    "pendingObservationWrites",
    "pendingEvidenceUploads",
  ]);
  if (
    body.pendingObservationWrites !== 0 ||
    body.pendingEvidenceUploads !== 0
  ) {
    inputError("pending_work_exists", "미전송 관측 또는 사진이 남아 있습니다.");
  }
  return { pendingObservationWrites: 0, pendingEvidenceUploads: 0 };
}

export function buildSubmitRpcInput(
  sessionId: string,
  actorValue: InventoryActor,
  input: SubmitInput,
) {
  const actor = requireActor(actorValue);
  return {
    p_session_id: requireUuid(sessionId, "invalid_session_id"),
    p_actor_id: actor.id,
    p_pending_observation_writes: input.pendingObservationWrites,
    p_pending_evidence_uploads: input.pendingEvidenceUploads,
  };
}

export function buildCancelRpcInput(
  sessionId: string,
  actorValue: InventoryActor,
) {
  const actor = requireActor(actorValue);
  return {
    p_session_id: requireUuid(sessionId, "invalid_session_id"),
    p_actor_id: actor.id,
  };
}

export function assertEmptyBody(value: string): void {
  if (value.length > 0) inputError("body_not_allowed", "요청 본문을 보낼 수 없습니다.");
}

export type StartDraftDecision =
  | { kind: "start" }
  | { kind: "reuse"; sessionId: string }
  | { kind: "conflict" };

export function evaluateStartDraft(
  globalDraft: { id?: unknown; started_by?: unknown } | null,
  userId: string,
): StartDraftDecision {
  if (!globalDraft) return { kind: "start" };
  if (globalDraft.started_by === userId && isUuid(globalDraft.id)) {
    return { kind: "reuse", sessionId: globalDraft.id };
  }
  return { kind: "conflict" };
}

export function statusForStartResult(result: { reused?: unknown }): 200 | 201 {
  return result.reused === true ? 200 : 201;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function serializeEvidenceRef(value: unknown) {
  if (!isRecord(value)) return null;
  const id = stringOrNull(value.id);
  const status = stringOrNull(value.status);
  if (!id || !status) return null;
  return {
    id,
    status,
    contentType: stringOrNull(value.content_type),
    sizeBytes:
      typeof value.size_bytes === "number" && Number.isFinite(value.size_bytes)
        ? value.size_bytes
        : null,
    createdAt: stringOrNull(value.created_at),
    uploadedAt: stringOrNull(value.uploaded_at),
    abortedAt: stringOrNull(value.aborted_at),
  };
}

export function serializeStaffObservation(row: Record<string, unknown>) {
  const evidenceRefs = Array.isArray(row.evidence_refs)
    ? row.evidence_refs
        .map(serializeEvidenceRef)
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    : [];
  return {
    id: stringOrNull(row.id),
    equipmentId: stringOrNull(row.equipment_id),
    temporaryCode: stringOrNull(row.temporary_code),
    temporaryLabel: stringOrNull(row.temporary_label),
    location: stringOrNull(row.location) ?? "",
    countNormal: numberOrZero(row.count_normal),
    countMaintenance: numberOrZero(row.count_maintenance),
    countDamaged: numberOrZero(row.count_damaged),
    countConditionUnknown: numberOrZero(row.count_condition_unknown),
    missingComponents: stringArray(row.missing_components),
    note: stringOrNull(row.note) ?? "",
    identificationStatus: stringOrNull(row.identification_status),
    evidenceRefs,
    clientUpdatedAt: stringOrNull(row.client_updated_at),
    createdAt: stringOrNull(row.created_at),
    updatedAt: stringOrNull(row.updated_at),
  };
}

export function serializeStaffSession(row: Record<string, unknown>) {
  return {
    id: stringOrNull(row.id),
    mode: stringOrNull(row.mode),
    status: stringOrNull(row.status),
    cutoffAt: stringOrNull(row.cutoff_at),
    movementFrozen: row.movement_frozen === true,
    startedAt: stringOrNull(row.started_at),
    submittedAt: stringOrNull(row.submitted_at),
    parentSessionId: stringOrNull(row.parent_session_id),
    createdAt: stringOrNull(row.created_at),
    updatedAt: stringOrNull(row.updated_at),
  };
}

function sessionCreatedAt(row: Record<string, unknown>): string {
  return stringOrNull(row.created_at) ?? "";
}

function progressForObservations(rows: ReturnType<typeof serializeStaffObservation>[]) {
  if (rows.length === 0) return "uncounted" as const;
  if (
    rows.some(
      (row) =>
        row.countMaintenance > 0 ||
        row.countDamaged > 0 ||
        row.countConditionUnknown > 0 ||
        row.missingComponents.length > 0,
    )
  ) {
    return "issue" as const;
  }
  return "counted" as const;
}

export interface BuildStaffWorkspaceInput {
  userId: string;
  isOwner: boolean;
  globalDraft: Record<string, unknown> | null;
  callerSessions: Record<string, unknown>[];
  catalogRows: Record<string, unknown>[];
  observationRows: Record<string, unknown>[];
  ownerQueueRows: Record<string, unknown>[];
}

export function buildStaffWorkspace(input: BuildStaffWorkspaceInput) {
  const callerSessions = [...input.callerSessions]
    .filter((row) =>
      new Set(["draft", "submitted", "in_review", "recount_requested"]).has(
        String(row.status ?? ""),
      ),
    )
    .sort((left, right) => {
      const byCreated = sessionCreatedAt(right).localeCompare(sessionCreatedAt(left));
      return byCreated || String(right.id ?? "").localeCompare(String(left.id ?? ""));
    });
  const serializedSessions = new Map(
    callerSessions.map((row) => [String(row.id), serializeStaffSession(row)]),
  );
  const latestRow = callerSessions[0] ?? null;
  const draftRow = callerSessions.find((row) => row.status === "draft") ?? null;
  const latestCallerSession = latestRow
    ? serializedSessions.get(String(latestRow.id)) ?? null
    : null;
  const activeDraft = draftRow
    ? serializedSessions.get(String(draftRow.id)) ?? null
    : null;
  const observations = input.observationRows.map(serializeStaffObservation);
  const confirmedByEquipment = new Map<
    string,
    ReturnType<typeof serializeStaffObservation>[]
  >();
  for (const row of observations) {
    if (row.identificationStatus !== "confirmed" || !row.equipmentId) continue;
    const existing = confirmedByEquipment.get(row.equipmentId) ?? [];
    existing.push(row);
    confirmedByEquipment.set(row.equipmentId, existing);
  }
  const catalog = input.catalogRows.map((row) => {
    const equipmentId = stringOrNull(row.equipment_id) ?? "";
    const itemObservations = confirmedByEquipment.get(equipmentId) ?? [];
    return {
      equipmentId,
      name: stringOrNull(row.name) ?? "",
      aliases: stringArray(row.aliases),
      major: stringOrNull(row.major),
      category: stringOrNull(row.category),
      progress: progressForObservations(itemObservations),
      observationCount: itemObservations.length,
    };
  });

  return {
    isOwner: input.isOwner,
    globalDraft: {
      active: input.globalDraft !== null,
      ownedByCaller: input.globalDraft?.started_by === input.userId,
    },
    activeDraft,
    latestCallerSession,
    catalog,
    observations,
    ownerQueue: input.isOwner
      ? input.ownerQueueRows.map((row) => ({
          ...serializeStaffSession(row),
          startedByEmail: stringOrNull(row.started_by_email),
        }))
      : [],
  };
}

export interface InventoryAuditHttpError {
  status: number;
  code: string;
  message: string;
}

export function mapInventoryAuditError(error: unknown): InventoryAuditHttpError {
  if (error instanceof InventoryAuditInputError) {
    return { status: error.status, code: error.code, message: error.message };
  }
  if (error instanceof SyntaxError) {
    return { status: 422, code: "invalid_json", message: "JSON 요청이 올바르지 않습니다." };
  }
  const record = isRecord(error) ? error : {};
  if (
    record.status === 503 &&
    record.code === "inventory_audit_service_unavailable"
  ) {
    return {
      status: 503,
      code: "inventory_audit_service_unavailable",
      message: "재고 실사 서버 설정을 확인해 주세요.",
    };
  }
  const code = typeof record.code === "string" ? record.code : "";
  const rawMessage = typeof record.message === "string" ? record.message : "";
  if (code === "42501") {
    return { status: 403, code: "forbidden", message: "이 실사에 접근할 권한이 없습니다." };
  }
  if (code === "P0002") {
    return { status: 404, code: "not_found", message: "재고 실사 항목을 찾을 수 없습니다." };
  }
  if (code === "40001") {
    return { status: 409, code: "stale_write", message: "다른 저장 내용이 있어 다시 확인해 주세요." };
  }
  if (
    code === "P0001" &&
    rawMessage.includes("full_shop inventory audit draft already active")
  ) {
    return { status: 409, code: "active_draft_conflict", message: "다른 직원이 전체 재고 실사를 진행 중입니다." };
  }
  if (code === "P0001" || code === "23505") {
    return {
      status: 409,
      code: code === "23505" ? "conflict" : "state_conflict",
      message: "현재 실사 상태와 요청이 충돌합니다.",
    };
  }
  if (code === "22023" || code === "22P02" || code === "23514") {
    return { status: 422, code: "invalid_request", message: "요청 값이 올바르지 않습니다." };
  }
  return { status: 500, code: "internal_error", message: "재고 실사 처리 중 오류가 발생했습니다." };
}
