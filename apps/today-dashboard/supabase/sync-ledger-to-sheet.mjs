// 재고 원장(village.equipment_ledger) → 장비마스터 시트 미러링
//
// 사용:
//   node supabase/sync-ledger-to-sheet.mjs --dry-run [--session-id UUID]
//
// 앱 원장이 진실이며 시트는 거울이다. 현재 전체 원장을 페이지 단위로 읽고,
// 차이만 계산한다. 실제 쓰기는 lease가 적용되는 사장님 승인 API만 수행한다.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  InventoryAuditMirrorError,
  createSupabaseRestLedgerPageLoader,
  diffLedgerAgainstSheet,
  getInventoryAuditMirrorConfig,
  mirrorNote,
  runInventoryAuditMirror,
  sanitizeInventoryAuditMirrorError,
} from "../lib/server/inventoryAuditMirrorCore.mjs";

export { diffLedgerAgainstSheet, mirrorNote, runInventoryAuditMirror };

const HERE = dirname(fileURLToPath(import.meta.url));

function loadEnv(path = join(HERE, "..", ".env.local")) {
  if (!existsSync(path)) return {};
  const env = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (match) env[match[1]] = match[2].trim();
  }
  return env;
}

function argumentValue(name, argv = process.argv.slice(2)) {
  const index = argv.indexOf(name);
  if (index === -1) return null;
  return argv[index + 1] || null;
}

export async function main(argv = process.argv.slice(2)) {
  const dryRun = argv.includes("--dry-run");
  if (!dryRun) {
    throw new InventoryAuditMirrorError("mirror_write_requires_api");
  }
  const fileEnv = loadEnv();
  const env = { ...fileEnv, ...process.env };
  const sessionId = argumentValue("--session-id", argv) ||
    "manual-dry-run";
  const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!supabaseUrl || !serviceRoleKey) {
    throw new InventoryAuditMirrorError("mirror_service_unavailable");
  }
  const gas = getInventoryAuditMirrorConfig(env);
  const result = await runInventoryAuditMirror({
    sessionId,
    dryRun,
    loadLedgerPage: createSupabaseRestLedgerPageLoader({
      supabaseUrl,
      serviceRoleKey,
    }),
    ...gas,
  });
  console.log(JSON.stringify(result, null, 2));
  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const safe = sanitizeInventoryAuditMirrorError(error);
    console.error(`[${safe.code}] ${safe.message}`);
    process.exitCode = 1;
  });
}
