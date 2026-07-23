import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

const ENV_KEYS = ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"];
const originalEnv = Object.fromEntries(
  ENV_KEYS.map((key) => [key, process.env[key]]),
);

// Production uses extensionless TypeScript imports for Next.js. Node's direct
// TypeScript runner needs the extension supplied by this test-only resolver.
const moduleHooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return {
        format: "module",
        shortCircuit: true,
        url: "data:text/javascript,export {};",
      };
    }
    const result = nextResolve(specifier, context);
    return result.url.endsWith(".ts") || result.url.includes(".ts?")
      ? { ...result, format: "module-typescript" }
      : result;
  },
});

const db = await import("../lib/server/inventoryAuditDb.ts");

test.after(() => {
  moduleHooks.deregister();
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("service client is reused across calls while env stays the same", () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://reuse.example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-a";

  const first = db.getInventoryAuditServiceClient();
  const second = db.getInventoryAuditServiceClient();

  assert.equal(second, first);
});

test("service client is rebuilt when env values change", () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://reuse.example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-a";
  const first = db.getInventoryAuditServiceClient();

  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-b";
  const second = db.getInventoryAuditServiceClient();

  assert.notEqual(second, first);
  assert.equal(second.supabaseKey, "service-role-b");
  assert.equal(second.rest.schemaName, "village");
});

test("fail-closed env validation still runs on every call even with a cached client", () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://reuse.example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-c";
  db.getInventoryAuditServiceClient();

  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  assert.throws(
    () => db.getInventoryAuditServiceClient(),
    (error) => {
      assert.equal(error.status, 503);
      assert.match(error.message, /SUPABASE_SERVICE_ROLE_KEY/);
      return true;
    },
  );
});
