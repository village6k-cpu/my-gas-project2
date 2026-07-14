import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

const ENV_KEYS = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "INVENTORY_OWNER_EMAILS",
];
const originalEnv = Object.fromEntries(
  ENV_KEYS.map((key) => [key, process.env[key]]),
);

function clearInventoryAuthEnv() {
  for (const key of ENV_KEYS) delete process.env[key];
}

function restoreInventoryAuthEnv() {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

clearInventoryAuthEnv();

// Production uses extensionless TypeScript imports for Next.js. Node's direct
// TypeScript runner needs the extension supplied by this test-only resolver.
const moduleHooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "./authCache") {
      const result = nextResolve("./authCache.ts", context);
      return { ...result, format: "module-typescript" };
    }
    const result = nextResolve(specifier, context);
    return result.url.endsWith(".ts") || result.url.includes(".ts?")
      ? { ...result, format: "module-typescript" }
      : result;
  },
});

const auth = await import("../lib/server/inventoryAuditAuth.ts");
const db = await import("../lib/server/inventoryAuditDb.ts");

test.after(() => {
  moduleHooks.deregister();
  restoreInventoryAuthEnv();
});

test("owner email parser trims, lowercases, and accepts comma-separated owners", () => {
  assert.deepEqual(
    [...auth.parseInventoryOwnerEmails("  Owner@Example.com, second@EXAMPLE.COM , ,\tTHIRD@example.com\n")],
    ["owner@example.com", "second@example.com", "third@example.com"],
  );
});

test("owner email parser and matching fail closed when configuration is missing", () => {
  assert.deepEqual([...auth.parseInventoryOwnerEmails(undefined)], []);
  assert.equal(
    auth.isInventoryOwner({ email: "owner@example.com" }, undefined),
    false,
  );
});

test("owner matching uses only the normalized verified user email", () => {
  const configured = "first@example.com, OWNER@example.com";

  assert.equal(
    auth.isInventoryOwner({ email: " Owner@Example.COM " }, configured),
    true,
  );
  assert.equal(
    auth.isInventoryOwner({ email: "request-claimed@example.com" }, configured),
    false,
  );
  assert.equal(auth.isInventoryOwner({ email: undefined }, configured), false);
  assert.equal(auth.isInventoryOwner(null, configured), false);
});

test("inventory guards fail closed while legacy boolean auth remains fail-open without Supabase config", async () => {
  const req = {
    headers: new Headers({
      authorization: "Bearer unverified-token",
      "x-user-email": "owner@example.com",
    }),
  };
  const authCache = await import("../lib/server/authCache.ts");

  assert.equal(await authCache.getAuthedUser(req), null);
  assert.equal(await authCache.isAuthedRequest(req), true);
  assert.equal(await auth.requireInventoryUser(req), null);
  assert.equal(await auth.requireInventoryOwner(req), null);
});

test("verified user lookup returns and caches the Supabase user while boolean auth delegates", async (t) => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";

  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount += 1;
    return new Response(
      JSON.stringify({
        id: "00000000-0000-4000-8000-000000000001",
        aud: "authenticated",
        role: "authenticated",
        email: "Owner@Example.com",
        created_at: "2026-07-14T00:00:00.000Z",
        app_metadata: {},
        user_metadata: {},
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  });

  const configuredAuth = await import(
    `../lib/server/authCache.ts?configured=${Date.now()}`
  );
  const req = {
    headers: new Headers({ authorization: "Bearer verified-token" }),
  };

  const first = await configuredAuth.getAuthedUser(req);
  const second = await configuredAuth.getAuthedUser(req);

  assert.equal(first?.email, "Owner@Example.com");
  assert.equal(second?.id, first?.id);
  assert.equal(await configuredAuth.isAuthedRequest(req), true);
  assert.equal(fetchCount, 1);
});

test("inventory audit database refuses anon fallback and reports missing server secrets as 503", () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;

  assert.throws(
    () => db.getInventoryAuditServiceClient(),
    (error) => {
      assert.equal(error.status, 503);
      assert.match(error.message, /SUPABASE_SERVICE_ROLE_KEY/);
      return true;
    },
  );

  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
});

test("inventory audit database uses the service role in village schema without sessions", () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "must-not-be-used";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";

  const client = db.getInventoryAuditServiceClient();

  assert.equal(client.supabaseKey, "test-service-role-key");
  assert.equal(client.rest.schemaName, "village");
  assert.equal(client.auth.persistSession, false);
  assert.equal(client.auth.autoRefreshToken, false);
  assert.equal(client.auth.detectSessionInUrl, false);

  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
});
