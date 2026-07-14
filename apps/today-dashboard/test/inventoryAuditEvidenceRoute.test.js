const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.join(__dirname, "..");
const ROUTE = "app/api/inventory-audits/[sessionId]/evidence/route.ts";

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

test("evidence methods authenticate before parsing bodies, params, or using service storage", () => {
  const source = read(ROUTE);
  assert.match(source, /params:\s*Promise<\{\s*sessionId:\s*string\s*\}>/);
  for (const method of ["POST", "DELETE", "GET"]) {
    const start = source.indexOf(`export async function ${method}`);
    assert.notEqual(start, -1, `${method} missing`);
    const next = ["POST", "DELETE", "GET"]
      .map((name) => source.indexOf(`export async function ${name}`, start + 1))
      .filter((index) => index > start)
      .sort((a, b) => a - b)[0] ?? source.length;
    const body = source.slice(start, next);
    const auth = method === "GET"
      ? body.indexOf("requireInventoryOwner")
      : body.indexOf("requireInventoryUser(req)");
    assert.notEqual(auth, -1, `${method} missing inventory auth`);
    for (const operation of ["context.params", "req.formData()", "req.json()", "getInventoryAuditServiceClient()", ".from(", ".rpc("]) {
      const index = body.indexOf(operation);
      if (index !== -1) assert.ok(auth < index, `${method} performs ${operation} before auth`);
    }
  }
});

test("POST reserves, uploads privately without upsert, and completes in that order", () => {
  const source = read(ROUTE);
  const reserve = source.indexOf("reserve_inventory_audit_evidence");
  const upload = source.indexOf(".upload(", reserve);
  const complete = source.indexOf("complete_inventory_audit_evidence", upload);
  assert.ok(reserve > 0 && upload > reserve && complete > upload);
  assert.match(source, /upsert:\s*false/);
  assert.match(source, /contentType:\s*["']image\/jpeg["']/);
  assert.match(source, /INVENTORY_AUDIT_EVIDENCE_BUCKET/);
  assert.doesNotMatch(source, /getPublicUrl|publicUrl/);
});

test("POST preserves retry state while only explicit DELETE uses the two-phase abort contract", () => {
  const source = read(ROUTE);
  const postStart = source.indexOf("export async function POST");
  const deleteStart = source.indexOf("export async function DELETE");
  const post = source.slice(postStart, deleteStart);
  const abort = source.indexOf("abort_inventory_audit_evidence", deleteStart);
  const remove = source.indexOf("removeExactObject(", abort);
  const finalize = source.indexOf("finalize_inventory_audit_evidence_abort", deleteStart);
  assert.doesNotMatch(post, /abort_inventory_audit_evidence|finalize_inventory_audit_evidence_abort/);
  assert.ok(abort > deleteStart && remove > abort && finalize > remove);
});

test("owner GET reads database evidence paths, signs for 300 seconds, and disables caching", () => {
  const source = read(ROUTE);
  assert.match(source, /requireInventoryOwner/);
  assert.match(source, /inventory_audit_sessions/);
  assert.match(source, /inventory_audit_observations/);
  assert.match(source, /evidence_refs/);
  assert.match(source, /createSignedUrl[s]?\([^)]*,\s*300\)/);
  assert.match(source, /InventoryAuditEvidenceUpstreamError/);
  assert.match(source, /no-store/i);
  assert.doesNotMatch(source, /searchParams\.get\(["']path["']\)/);
});

test("every evidence response includes stable code and retryable fields", () => {
  const source = read(ROUTE);
  assert.match(source, /retryable/);
  assert.match(source, /mapInventoryAuditEvidenceError/);
  assert.match(source, /inventoryAuditEvidenceResponse/);
});

test("audit compressor emits JPEG only with three bounded attempts and no original fallback", () => {
  const source = read("lib/inventory-audit/compressEvidence.ts");
  assert.match(source, /1_600[\s\S]*0\.82/);
  assert.match(source, /1_280[\s\S]*0\.78/);
  assert.match(source, /1_024[\s\S]*0\.72/);
  assert.match(source, /3_500_000/);
  assert.match(source, /image\/jpeg/);
  assert.match(source, /fillStyle\s*=\s*["']#fff(?:fff)?["']/i);
  assert.doesNotMatch(source, /return\s+file\s*;/);
});

test("offline observation and evidence transports always use authenticated fetch", () => {
  for (const relativePath of [
    "lib/inventory-audit/offline.ts",
    "lib/inventory-audit/evidenceQueue.ts",
  ]) {
    const source = read(relativePath);
    assert.match(source, /import\(["']@\/lib\/data\/authFetch["']\)/, relativePath);
    assert.match(source, /authFetch\(/, relativePath);
    assert.doesNotMatch(
      source,
      /(?:response\s*=|return)\s+await?\s*fetch\(/,
      `${relativePath} must not bypass bearer auth`,
    );
  }
});

test("visible-page wakeups resume auth-paused observation and evidence jobs", () => {
  assert.match(
    read("lib/inventory-audit/offline.ts"),
    /visibilitychange[\s\S]*resumeInventoryAuditAuth\(\)/,
  );
  assert.match(
    read("lib/inventory-audit/evidenceQueue.ts"),
    /visibilitychange[\s\S]*resumeInventoryAuditEvidenceAuth\(\)/,
  );
});

test("both queues preempt a later retry timer when a newly due job arrives", () => {
  const offline = read("lib/inventory-audit/offline.ts");
  const evidence = read("lib/inventory-audit/evidenceQueue.ts");
  assert.match(offline, /shouldPreemptInventoryAuditWake\(this\.wakeAt,\s*dueAt\)/);
  assert.match(evidence, /shouldPreemptInventoryAuditWake\(this\.wakeAt,\s*dueAt\)/);
});
