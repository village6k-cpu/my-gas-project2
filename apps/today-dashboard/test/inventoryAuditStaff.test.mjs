import assert from "node:assert/strict";
import test from "node:test";

import {
  InventoryAuditInputError,
  assertEmptyBody,
  buildDeleteObservationRpcInput,
  buildSaveObservationRpcInput,
  buildStaffWorkspace,
  buildSubmitRpcInput,
  evaluateStartDraft,
  mapInventoryAuditError,
  parseDeleteObservationInput,
  parseObservationInput,
  parseStartInput,
  parseSubmitInput,
  serializeStaffObservation,
  statusForStartResult,
} from "../lib/inventory-audit/staff.ts";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const OBSERVATION_ID = "22222222-2222-4222-8222-222222222222";
const ACTOR = {
  id: "33333333-3333-4333-8333-333333333333",
  email: "staff@example.com",
};
const CLIENT_TIME = "2026-07-14T10:00:00.000Z";

function observationBody(overrides = {}) {
  return {
    id: OBSERVATION_ID,
    equipmentId: "CAM-001",
    temporaryCode: null,
    temporaryLabel: null,
    location: "A 선반",
    countNormal: 0,
    countMaintenance: 0,
    countDamaged: 0,
    countConditionUnknown: 0,
    missingComponents: [],
    note: "",
    identificationStatus: "confirmed",
    clientUpdatedAt: CLIENT_TIME,
    expectedClientUpdatedAt: null,
    ...overrides,
  };
}

function expectInputError(fn, code) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof InventoryAuditInputError);
    assert.equal(error.status, 422);
    assert.equal(error.code, code);
    return true;
  });
}

function assertNoHiddenSnapshotFields(value) {
  const forbidden = new Set([
    "ledger_stock_total",
    "ledgerStockTotal",
    "ledger_stock_maint",
    "ledgerStockMaint",
    "ledgerStockMaintenance",
    "ledger_state",
    "ledgerState",
    "ledger_open_issues",
    "ledgerOpenIssues",
    "ledger_updated_at",
    "ledgerUpdatedAt",
    "active_rental_qty",
    "activeRentalQty",
    "active_rental_refs",
    "activeRentalRefs",
    "rental_match_status",
    "rentalMatchStatus",
  ]);

  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    for (const [key, child] of Object.entries(node)) {
      assert.equal(forbidden.has(key), false, `leaked hidden field: ${key}`);
      visit(child);
    }
  };
  visit(value);
}

test("start accepts only an explicit movement freeze acknowledgement", () => {
  assert.deepEqual(parseStartInput({ movementFrozen: true }), {
    movementFrozen: true,
  });
  expectInputError(
    () => parseStartInput({ movementFrozen: false }),
    "movement_freeze_required",
  );
  expectInputError(
    () => parseStartInput({ movementFrozen: true, actorEmail: "spoof@example.com" }),
    "invalid_request_fields",
  );
});

test("start preflight reuses the shared shop draft across employee handoffs", () => {
  assert.deepEqual(evaluateStartDraft(null, ACTOR.id), { kind: "start" });
  assert.deepEqual(
    evaluateStartDraft({ id: SESSION_ID, started_by: ACTOR.id }, ACTOR.id),
    { kind: "reuse", sessionId: SESSION_ID },
  );
  assert.deepEqual(
    evaluateStartDraft(
      { id: SESSION_ID, started_by: "44444444-4444-4444-8444-444444444444" },
      ACTOR.id,
    ),
    { kind: "reuse", sessionId: SESSION_ID },
  );
  assert.equal(statusForStartResult({ reused: false }), 201);
  assert.equal(statusForStartResult({ reused: true }), 200);
});

test("explicit all-zero observation is preserved in the exact create RPC input", () => {
  const parsed = parseObservationInput(observationBody());

  assert.deepEqual(buildSaveObservationRpcInput(SESSION_ID, ACTOR, parsed), {
    p_session_id: SESSION_ID,
    p_observation_id: OBSERVATION_ID,
    p_actor_id: ACTOR.id,
    p_actor_email: ACTOR.email,
    p_equipment_id: "CAM-001",
    p_temporary_code: null,
    p_temporary_label: null,
    p_location: "A 선반",
    p_count_normal: 0,
    p_count_maintenance: 0,
    p_count_damaged: 0,
    p_count_condition_unknown: 0,
    p_missing_components: [],
    p_note: "",
    p_identification_status: "confirmed",
    p_client_updated_at: CLIENT_TIME,
    p_expected_client_updated_at: null,
  });
});

test("observation parsing enforces exclusive identity, integer bounds, labels, and strict timestamps", () => {
  assert.equal(
    parseObservationInput(
      observationBody({
        equipmentId: null,
        temporaryCode: "TMP-001",
        temporaryLabel: "비슷한 배터리",
        identificationStatus: "uncertain",
      }),
    ).temporaryCode,
    "TMP-001",
  );
  assert.equal(
    parseObservationInput(
      observationBody({
        equipmentId: null,
        temporaryCode: "NEW-001",
        temporaryLabel: "목록 외 장비",
        identificationStatus: "unlisted",
      }),
    ).identificationStatus,
    "unlisted",
  );

  expectInputError(
    () =>
      parseObservationInput(
        observationBody({ temporaryCode: "TMP", identificationStatus: "confirmed" }),
      ),
    "invalid_observation_identity",
  );
  expectInputError(
    () => parseObservationInput(observationBody({ countNormal: -1 })),
    "invalid_observation_count",
  );
  expectInputError(
    () => parseObservationInput(observationBody({ countNormal: 1.5 })),
    "invalid_observation_count",
  );
  expectInputError(
    () => parseObservationInput(observationBody({ countNormal: 2_147_483_648 })),
    "invalid_observation_count",
  );
  expectInputError(
    () => parseObservationInput(observationBody({ location: "   " })),
    "invalid_observation_location",
  );
  expectInputError(
    () => parseObservationInput(observationBody({ note: "x".repeat(4001) })),
    "invalid_observation_note",
  );
  expectInputError(
    () => parseObservationInput(observationBody({ missingComponents: ["x".repeat(201)] })),
    "invalid_missing_components",
  );
  expectInputError(
    () => parseObservationInput(observationBody({ clientUpdatedAt: "2026-07-14" })),
    "invalid_client_timestamp",
  );
  expectInputError(
    () =>
      parseObservationInput(
        observationBody({ clientUpdatedAt: "2026-02-30T10:00:00.000Z" }),
      ),
    "invalid_client_timestamp",
  );
  expectInputError(
    () => parseObservationInput({ ...observationBody(), evidenceRefs: [] }),
    "invalid_request_fields",
  );
});

test("edit retries preserve both client timestamps exactly", () => {
  const expected = "2026-07-14T09:59:00.000Z";
  const parsed = parseObservationInput(
    observationBody({
      clientUpdatedAt: CLIENT_TIME,
      expectedClientUpdatedAt: expected,
      countNormal: 3,
    }),
  );
  const rpcInput = buildSaveObservationRpcInput(SESSION_ID, ACTOR, parsed);

  assert.equal(rpcInput.p_client_updated_at, CLIENT_TIME);
  assert.equal(rpcInput.p_expected_client_updated_at, expected);
  assert.equal(rpcInput.p_count_normal, 3);
});

test("delete uses observation id plus the exact expected timestamp CAS input", () => {
  const parsed = parseDeleteObservationInput({
    observationId: OBSERVATION_ID,
    expectedClientUpdatedAt: CLIENT_TIME,
  });

  assert.deepEqual(buildDeleteObservationRpcInput(SESSION_ID, ACTOR, parsed), {
    p_session_id: SESSION_ID,
    p_observation_id: OBSERVATION_ID,
    p_actor_id: ACTOR.id,
    p_expected_client_updated_at: CLIENT_TIME,
  });
  expectInputError(
    () =>
      parseDeleteObservationInput({
        observationId: OBSERVATION_ID,
        expectedClientUpdatedAt: null,
      }),
    "invalid_client_timestamp",
  );
});

test("submit requires both pending counters to be explicitly present and exactly zero", () => {
  const parsed = parseSubmitInput({
    pendingObservationWrites: 0,
    pendingEvidenceUploads: 0,
  });

  assert.deepEqual(buildSubmitRpcInput(SESSION_ID, ACTOR, parsed), {
    p_session_id: SESSION_ID,
    p_actor_id: ACTOR.id,
    p_pending_observation_writes: 0,
    p_pending_evidence_uploads: 0,
  });
  expectInputError(
    () => parseSubmitInput({ pendingObservationWrites: 0 }),
    "pending_counts_required",
  );
  expectInputError(
    () =>
      parseSubmitInput({
        pendingObservationWrites: 1,
        pendingEvidenceUploads: 0,
      }),
    "pending_work_exists",
  );
});

test("cancel accepts no request body at all", () => {
  assert.doesNotThrow(() => assertEmptyBody(""));
  expectInputError(() => assertEmptyBody(" "), "body_not_allowed");
  expectInputError(() => assertEmptyBody("{}"), "body_not_allowed");
});

test("staff serializers strip every hidden snapshot field and unsafe evidence path", () => {
  const observation = serializeStaffObservation({
    id: OBSERVATION_ID,
    session_id: SESSION_ID,
    equipment_id: "CAM-001",
    temporary_code: null,
    temporary_label: null,
    location: "A 선반",
    count_normal: 1,
    count_maintenance: 0,
    count_damaged: 0,
    count_condition_unknown: 0,
    missing_components: [],
    note: "",
    identification_status: "confirmed",
    evidence_refs: [
      {
        id: "55555555-5555-4555-8555-555555555555",
        path: `${SESSION_ID}/${OBSERVATION_ID}/secret.jpg`,
        status: "uploaded",
        content_type: "image/jpeg",
        size_bytes: 1234,
        uploaded_at: CLIENT_TIME,
        publicUrl: "https://should-never-leak.example/photo.jpg",
      },
    ],
    observed_by: ACTOR.id,
    observed_by_email: ACTOR.email,
    client_updated_at: CLIENT_TIME,
    created_at: CLIENT_TIME,
    updated_at: CLIENT_TIME,
    ledger_stock_total: 99,
    active_rental_qty: 88,
    rental_match_status: "matched",
  });

  assert.deepEqual(observation.evidenceRefs, [
    {
      id: "55555555-5555-4555-8555-555555555555",
      status: "uploaded",
      contentType: "image/jpeg",
      sizeBytes: 1234,
      createdAt: null,
      uploadedAt: CLIENT_TIME,
      abortedAt: null,
    },
  ]);
  assert.equal(JSON.stringify(observation).includes("secret.jpg"), false);
  assert.equal(JSON.stringify(observation).includes("should-never-leak"), false);
  assertNoHiddenSnapshotFields(observation);
});

test("workspace keeps latest caller status after submit and derives blind progress from observations only", () => {
  const sessionBase = {
    id: "66666666-6666-4666-8666-666666666666",
    mode: "full_shop",
    status: "draft",
    cutoff_at: "2026-07-14T08:00:00.000Z",
    started_at: "2026-07-14T08:00:00.000Z",
    submitted_at: null,
    movement_frozen: true,
    parent_session_id: null,
    created_at: "2026-07-14T08:00:00.000Z",
    updated_at: "2026-07-14T08:00:00.000Z",
    started_by: ACTOR.id,
  };
  const submitted = {
    ...sessionBase,
    id: SESSION_ID,
    status: "submitted",
    movement_frozen: false,
    submitted_at: "2026-07-14T11:00:00.000Z",
    created_at: "2026-07-14T09:00:00.000Z",
    updated_at: "2026-07-14T11:00:00.000Z",
    ledger_stock_total: 100,
    active_rental_qty: 50,
  };
  const workspace = buildStaffWorkspace({
    userId: ACTOR.id,
    isOwner: false,
    globalDraft: null,
    callerSessions: [submitted],
    catalogRows: [
      {
        equipment_id: "CAM-001",
        name: "Sony A7 IV",
        aliases: ["A7IV"],
        major: "카메라",
        category: "미러리스",
        ledger_stock_total: 10,
        ledger_stock_maint: 2,
        ledger_state: "정상",
        ledger_open_issues: ["hidden"],
        ledger_updated_at: CLIENT_TIME,
        active_rental_qty: 3,
        active_rental_refs: [{ trade_id: "hidden" }],
        rental_match_status: "matched",
      },
      {
        equipment_id: "CAM-002",
        name: "Canon R5",
        aliases: [],
        major: "카메라",
        category: "미러리스",
      },
    ],
    observationRows: [
      {
        id: OBSERVATION_ID,
        equipment_id: "CAM-001",
        location: "A 선반",
        count_normal: 0,
        count_maintenance: 0,
        count_damaged: 0,
        count_condition_unknown: 0,
        missing_components: [],
        note: "",
        identification_status: "confirmed",
        evidence_refs: [],
        client_updated_at: CLIENT_TIME,
        created_at: CLIENT_TIME,
        updated_at: CLIENT_TIME,
      },
      {
        id: "77777777-7777-4777-8777-777777777777",
        equipment_id: null,
        temporary_code: "TMP-1",
        temporary_label: "미확인",
        location: "B 선반",
        count_normal: 1,
        count_maintenance: 0,
        count_damaged: 0,
        count_condition_unknown: 0,
        missing_components: [],
        note: "",
        identification_status: "uncertain",
        evidence_refs: [],
        client_updated_at: CLIENT_TIME,
        created_at: CLIENT_TIME,
        updated_at: CLIENT_TIME,
      },
    ],
    ownerQueueRows: [],
  });

  assert.equal(workspace.activeDraft, null);
  assert.equal(workspace.latestCallerSession.id, SESSION_ID);
  assert.equal(workspace.latestCallerSession.status, "submitted");
  assert.equal(workspace.catalog[0].progress, "counted");
  assert.equal(workspace.catalog[0].observationCount, 1);
  assert.equal(workspace.catalog[1].progress, "uncounted");
  assert.equal(workspace.catalog[1].observationCount, 0);
  assertNoHiddenSnapshotFields(workspace);
});

test("workspace marks condition buckets and missing components as issues", () => {
  const workspace = buildStaffWorkspace({
    userId: ACTOR.id,
    isOwner: true,
    globalDraft: { id: SESSION_ID, started_by: ACTOR.id },
    callerSessions: [
      {
        id: SESSION_ID,
        mode: "full_shop",
        status: "draft",
        cutoff_at: CLIENT_TIME,
        started_at: CLIENT_TIME,
        submitted_at: null,
        movement_frozen: true,
        parent_session_id: null,
        created_at: CLIENT_TIME,
        updated_at: CLIENT_TIME,
        started_by: ACTOR.id,
      },
    ],
    catalogRows: [
      {
        equipment_id: "CAM-001",
        name: "Sony A7 IV",
        aliases: [],
        major: "카메라",
        category: "미러리스",
      },
    ],
    observationRows: [
      {
        id: OBSERVATION_ID,
        equipment_id: "CAM-001",
        location: "A 선반",
        count_normal: 0,
        count_maintenance: 1,
        count_damaged: 0,
        count_condition_unknown: 0,
        missing_components: ["바디캡"],
        note: "",
        identification_status: "confirmed",
        evidence_refs: [],
        client_updated_at: CLIENT_TIME,
        created_at: CLIENT_TIME,
        updated_at: CLIENT_TIME,
      },
    ],
    ownerQueueRows: [],
  });

  assert.deepEqual(workspace.globalDraft, { active: true, ownedByCaller: true });
  assert.equal(workspace.activeDraft.id, SESSION_ID);
  assert.equal(workspace.catalog[0].progress, "issue");
});

test("workspace marks owner-approved equipment as locked for the next employee", () => {
  const workspace = buildStaffWorkspace({
    userId: ACTOR.id,
    isOwner: false,
    globalDraft: { id: SESSION_ID, started_by: ACTOR.id },
    callerSessions: [
      {
        id: SESSION_ID,
        mode: "full_shop",
        status: "draft",
        cutoff_at: CLIENT_TIME,
        started_at: CLIENT_TIME,
        submitted_at: null,
        movement_frozen: true,
        parent_session_id: null,
        created_at: CLIENT_TIME,
        updated_at: CLIENT_TIME,
        started_by: ACTOR.id,
      },
    ],
    catalogRows: [
      {
        equipment_id: "CAM-001",
        name: "Sony A7 IV",
        aliases: [],
        major: "카메라",
        category: "미러리스",
      },
    ],
    observationRows: [
      {
        id: OBSERVATION_ID,
        equipment_id: "CAM-001",
        location: "A 선반",
        count_normal: 1,
        count_maintenance: 0,
        count_damaged: 0,
        count_condition_unknown: 0,
        missing_components: [],
        note: "",
        identification_status: "confirmed",
        evidence_refs: [],
        client_updated_at: CLIENT_TIME,
        created_at: CLIENT_TIME,
        updated_at: CLIENT_TIME,
      },
    ],
    approvalRows: [{ equipment_id: "CAM-001" }],
    ownerQueueRows: [],
  });

  assert.equal(workspace.catalog[0].progress, "approved");
  assert.equal(workspace.catalog[0].lockedByOwner, true);
});

test("an active shop draft is continuable by a different authenticated employee", () => {
  const starterId = "44444444-4444-4444-8444-444444444444";
  const sharedDraft = {
    id: SESSION_ID,
    mode: "full_shop",
    status: "draft",
    cutoff_at: CLIENT_TIME,
    started_at: CLIENT_TIME,
    submitted_at: null,
    movement_frozen: true,
    parent_session_id: null,
    created_at: CLIENT_TIME,
    updated_at: CLIENT_TIME,
    started_by: starterId,
  };
  const workspace = buildStaffWorkspace({
    userId: ACTOR.id,
    isOwner: false,
    globalDraft: sharedDraft,
    callerSessions: [sharedDraft],
    catalogRows: [],
    observationRows: [],
    ownerQueueRows: [],
  });

  assert.deepEqual(workspace.globalDraft, { active: true, ownedByCaller: true });
  assert.equal(workspace.activeDraft.id, SESSION_ID);
});

test("database and configuration errors map to stable HTTP distinctions without raw messages", () => {
  const cases = [
    [{ code: "42501", message: "secret ownership detail" }, 403, "forbidden"],
    [{ code: "P0002", message: "secret row detail" }, 404, "not_found"],
    [{ code: "40001", message: "stale client base" }, 409, "stale_write"],
    [{ code: "P0001", message: "full_shop inventory audit draft already active" }, 409, "active_draft_conflict"],
    [{ code: "23505", message: "duplicate secret" }, 409, "conflict"],
    [{ code: "22023", message: "invalid secret" }, 422, "invalid_request"],
    [{ status: 503, code: "inventory_audit_service_unavailable", message: "missing secret name" }, 503, "inventory_audit_service_unavailable"],
    [{ code: "XX000", message: "database internals" }, 500, "internal_error"],
  ];

  for (const [error, status, code] of cases) {
    const mapped = mapInventoryAuditError(error);
    assert.equal(mapped.status, status);
    assert.equal(mapped.code, code);
    assert.equal(mapped.message.includes(error.message), false);
  }
});
