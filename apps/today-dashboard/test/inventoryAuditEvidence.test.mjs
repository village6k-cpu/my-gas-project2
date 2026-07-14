import assert from "node:assert/strict";
import test from "node:test";

import {
  InventoryAuditEvidenceInputError,
  InventoryAuditEvidenceUpstreamError,
  expectedInventoryAuditEvidencePath,
  mapInventoryAuditEvidenceError,
  parseEvidenceDeleteInput,
  parseEvidenceQueryObservationId,
  parseEvidenceSessionId,
  persistInventoryAuditEvidence,
  validateEvidenceUpload,
} from "../lib/inventory-audit/evidence.ts";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const OBSERVATION_ID = "22222222-2222-4222-8222-222222222222";
const EVIDENCE_ID = "33333333-3333-4333-8333-333333333333";

function fileLike(bytes, type = "image/jpeg") {
  const blob = new Blob([new Uint8Array(bytes)], { type });
  return {
    size: blob.size,
    type: blob.type,
    arrayBuffer: () => blob.arrayBuffer(),
  };
}

test("evidence IDs generate only the deterministic UUID jpg path", () => {
  assert.equal(
    expectedInventoryAuditEvidencePath(SESSION_ID, OBSERVATION_ID, EVIDENCE_ID),
    `${SESSION_ID}/${OBSERVATION_ID}/${EVIDENCE_ID}.jpg`,
  );
  assert.throws(
    () => expectedInventoryAuditEvidencePath("../session", OBSERVATION_ID, EVIDENCE_ID),
    InventoryAuditEvidenceInputError,
  );
});

test("upload validation requires JPEG MIME, size, and magic bytes", async () => {
  const valid = fileLike([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xff, 0xd9]);
  assert.deepEqual(
    await validateEvidenceUpload({
      observationId: OBSERVATION_ID,
      evidenceId: EVIDENCE_ID,
      file: valid,
    }),
    {
      observationId: OBSERVATION_ID,
      evidenceId: EVIDENCE_ID,
      file: valid,
      sizeBytes: valid.size,
    },
  );

  for (const [input, code, status] of [
    [{ observationId: "bad", evidenceId: EVIDENCE_ID, file: valid }, "invalid_observation_id", 422],
    [{ observationId: OBSERVATION_ID, evidenceId: "bad", file: valid }, "invalid_evidence_id", 422],
    [{ observationId: OBSERVATION_ID, evidenceId: EVIDENCE_ID, file: fileLike([0xff, 0xd8, 0xff], "image/png") }, "invalid_evidence_type", 422],
    [{ observationId: OBSERVATION_ID, evidenceId: EVIDENCE_ID, file: fileLike([1, 2, 3, 4]) }, "invalid_jpeg", 422],
    [{ observationId: OBSERVATION_ID, evidenceId: EVIDENCE_ID, file: { size: 3_500_001, type: "image/jpeg", arrayBuffer: async () => new ArrayBuffer(0) } }, "evidence_too_large", 413],
  ]) {
    await assert.rejects(validateEvidenceUpload(input), (error) => {
      assert.ok(error instanceof InventoryAuditEvidenceInputError);
      assert.equal(error.code, code);
      assert.equal(error.status, status);
      return true;
    });
  }
});

test("delete/query parsing accepts only UUIDs and exact fields", () => {
  assert.deepEqual(
    parseEvidenceDeleteInput({ observationId: OBSERVATION_ID, evidenceId: EVIDENCE_ID }),
    { observationId: OBSERVATION_ID, evidenceId: EVIDENCE_ID },
  );
  assert.equal(parseEvidenceQueryObservationId(null), null);
  assert.equal(parseEvidenceQueryObservationId(OBSERVATION_ID), OBSERVATION_ID);
  assert.equal(parseEvidenceSessionId(SESSION_ID), SESSION_ID);
  assert.throws(
    () => parseEvidenceDeleteInput({ observationId: OBSERVATION_ID, evidenceId: EVIDENCE_ID, path: "caller/path" }),
    InventoryAuditEvidenceInputError,
  );
  assert.throws(() => parseEvidenceQueryObservationId("bad"), InventoryAuditEvidenceInputError);
  assert.throws(() => parseEvidenceSessionId("bad"), InventoryAuditEvidenceInputError);
});

test("evidence errors map to stable status, code, and retryability without leaking upstream text", () => {
  const cases = [
    [{ code: "42501", message: "secret ownership detail" }, 403, "forbidden", false],
    [{ code: "P0002", message: "secret path" }, 404, "not_found", false],
    [{ code: "40001", message: "secret conflict" }, 409, "evidence_conflict", false],
    [{ code: "P0001", message: "uploaded evidence cannot be aborted" }, 409, "uploaded_evidence_immutable", false],
    [{ code: "22023", message: "secret value" }, 422, "invalid_request", false],
    [{ status: 503, code: "inventory_audit_service_unavailable", message: "env names" }, 503, "inventory_audit_service_unavailable", true],
  ];
  for (const [error, status, code, retryable] of cases) {
    const mapped = mapInventoryAuditEvidenceError(error);
    assert.equal(mapped.status, status);
    assert.equal(mapped.code, code);
    assert.equal(mapped.retryable, retryable);
    assert.doesNotMatch(mapped.error, /secret|env names/i);
  }
});

test("code-less Supabase transport failures remain retryable upstream errors", () => {
  const storageUnknown = new Error("fetch failed with private endpoint details");
  storageUnknown.name = "StorageUnknownError";
  for (const error of [
    { code: "", status: 0, message: "postgrest fetch failed privately" },
    {
      code: "",
      details: "private fetch stack",
      hint: "",
      message: "FetchError: request failed privately",
    },
    storageUnknown,
  ]) {
    const mapped = mapInventoryAuditEvidenceError(error);
    assert.equal(mapped.status, 502);
    assert.equal(mapped.code, "storage_upstream_error");
    assert.equal(mapped.retryable, true);
    assert.doesNotMatch(mapped.error, /fetch|private|endpoint|postgrest/i);
  }
});

test("malformed private Storage results use a sanitized retryable upstream error", () => {
  const mapped = mapInventoryAuditEvidenceError(
    new InventoryAuditEvidenceUpstreamError(),
  );
  assert.deepEqual(mapped, {
    status: 502,
    code: "storage_upstream_error",
    retryable: true,
    error: "사진 저장소 응답을 확인하지 못했습니다.",
  });
});

function persistenceHarness(overrides = {}) {
  const calls = [];
  const pendingRef = {
    id: EVIDENCE_ID,
    path: `${SESSION_ID}/${OBSERVATION_ID}/${EVIDENCE_ID}.jpg`,
    status: "pending",
    content_type: "image/jpeg",
    size_bytes: 8,
  };
  return {
    calls,
    input: {
      expectedPath: pendingRef.path,
      reserve: async () => {
        calls.push("reserve");
        return { evidence: pendingRef };
      },
      upload: async () => calls.push("upload"),
      complete: async () => {
        calls.push("complete");
        return { evidence: { ...pendingRef, status: "uploaded" } };
      },
      remove: async () => calls.push("remove"),
      ...overrides,
    },
  };
}

test("an upload success followed by a lost complete response keeps the pending reservation for same-ID retry", async () => {
  const transient = { code: "57014", message: "connection lost" };
  const harness = persistenceHarness({
    complete: async () => {
      harness.calls.push("complete");
      throw transient;
    },
  });

  await assert.rejects(persistInventoryAuditEvidence(harness.input), transient);
  assert.deepEqual(harness.calls, ["reserve", "upload", "complete"]);
});

test("completion not-found after upload is a retryable pending outcome, not a terminal 404", async () => {
  const harness = persistenceHarness({
    complete: async () => {
      harness.calls.push("complete");
      throw { code: "P0002", message: "object visibility delayed" };
    },
  });

  const error = await persistInventoryAuditEvidence(harness.input).then(
    () => null,
    (caught) => caught,
  );
  const mapped = mapInventoryAuditEvidenceError(error);
  assert.equal(mapped.status, 502);
  assert.equal(mapped.code, "evidence_completion_pending");
  assert.equal(mapped.retryable, true);
  assert.deepEqual(harness.calls, ["reserve", "upload", "complete"]);
});

test("an upsert-false duplicate converges by completing the existing exact object", async () => {
  const harness = persistenceHarness({
    upload: async () => {
      harness.calls.push("upload");
      throw { statusCode: "409", message: "Asset Already Exists" };
    },
  });

  const result = await persistInventoryAuditEvidence(harness.input);
  assert.equal(result.kind, "uploaded");
  assert.deepEqual(harness.calls, ["reserve", "upload", "complete"]);
});

test("a failed upload keeps the pending reservation and same-ID Blob even when completion proves no object", async () => {
  const uploadFailure = { statusCode: "502", message: "upload failed" };
  const harness = persistenceHarness({
    upload: async () => {
      harness.calls.push("upload");
      throw uploadFailure;
    },
    complete: async () => {
      harness.calls.push("complete");
      throw { code: "P0002", message: "object not found" };
    },
  });

  await assert.rejects(persistInventoryAuditEvidence(harness.input), uploadFailure);
  assert.deepEqual(harness.calls, ["reserve", "upload", "complete"]);
});

test("an ambiguous complete failure after a failed upload does not destroy a possibly committed object", async () => {
  const harness = persistenceHarness({
    upload: async () => {
      harness.calls.push("upload");
      throw { statusCode: "502", message: "response lost" };
    },
    complete: async () => {
      harness.calls.push("complete");
      throw { code: "57014", message: "completion response lost" };
    },
  });

  await assert.rejects(persistInventoryAuditEvidence(harness.input));
  assert.deepEqual(harness.calls, ["reserve", "upload", "complete"]);
});
