import { createHmac } from "node:crypto";

const DERIVATION_LABEL = "village-gas-internal-v1";

export function deriveVillageGasInternalKey(serviceRoleSecret) {
  const secret = String(serviceRoleSecret || "").trim();
  if (secret.length < 16) throw new Error("Supabase service role secret is unavailable");
  return createHmac("sha256", secret)
    .update(DERIVATION_LABEL, "utf8")
    .digest("base64url");
}

export function getVillageGasInternalKey(environment = process.env) {
  const explicit = String(environment.VILLAGE_GAS_INTERNAL_KEY || "").trim();
  if (explicit) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(explicit)) {
      throw new Error("Explicit internal GAS key is invalid");
    }
    return explicit;
  }
  return deriveVillageGasInternalKey(environment.SUPABASE_SERVICE_ROLE_KEY);
}
