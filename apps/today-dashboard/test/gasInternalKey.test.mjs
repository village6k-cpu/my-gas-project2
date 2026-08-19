import test from "node:test";
import assert from "node:assert/strict";

import {
  deriveVillageGasInternalKey,
  getVillageGasInternalKey,
} from "../lib/server/gasInternalKey.mjs";

const SYNTHETIC_SERVICE_SECRET = "service-role-test-secret-123";
const EXPECTED_DERIVED_KEY = "-PKxkeZbEpJ49suEszVienz5K7yh2Vgq-f4ddpigOgM";
const EXPLICIT_INTERNAL_KEY = "A".repeat(43);

test("internal GAS key is a stable HMAC derivative and never the Supabase service secret", () => {
  const derived = deriveVillageGasInternalKey(SYNTHETIC_SERVICE_SECRET);
  assert.equal(derived, EXPECTED_DERIVED_KEY);
  assert.notEqual(derived, SYNTHETIC_SERVICE_SECRET);
  assert.equal(derived.length, 43);
  assert.equal(
    getVillageGasInternalKey({ SUPABASE_SERVICE_ROLE_KEY: SYNTHETIC_SERVICE_SECRET }),
    EXPECTED_DERIVED_KEY,
  );
});

test("internal GAS key derivation fails closed without a valid server-side secret", () => {
  assert.throws(() => deriveVillageGasInternalKey(""), /service role/i);
  assert.throws(() => deriveVillageGasInternalKey("too-short"), /service role/i);
  assert.throws(() => getVillageGasInternalKey({}), /service role/i);
});

test("one explicit internal GAS key is authoritative across server runtimes", () => {
  assert.equal(
    getVillageGasInternalKey({
      VILLAGE_GAS_INTERNAL_KEY: EXPLICIT_INTERNAL_KEY,
      SUPABASE_SERVICE_ROLE_KEY: SYNTHETIC_SERVICE_SECRET,
    }),
    EXPLICIT_INTERNAL_KEY,
  );
  assert.throws(
    () => getVillageGasInternalKey({
      VILLAGE_GAS_INTERNAL_KEY: "invalid",
      SUPABASE_SERVICE_ROLE_KEY: SYNTHETIC_SERVICE_SECRET,
    }),
    /internal GAS key/i,
    "an invalid explicit key must fail closed instead of silently deriving a different caller key",
  );
});
