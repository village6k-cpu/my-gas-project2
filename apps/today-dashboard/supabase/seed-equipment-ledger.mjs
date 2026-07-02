// 재고관리대장 시드 — 장비마스터 CSV → village.equipment_ledger (REST upsert)
//
// 사용: node supabase/seed-equipment-ledger.mjs [--dry-run]
// 전제: equipment-ledger.sql 이 Supabase SQL Editor에서 실행된 상태.
// 정책: 마스터 값은 전부 '미검증'으로 들여온다 (2~3달 전 기준, 사장 확인).
//       분실/도난/파손/수리/수량이상 신호가 있으면 'attention'.
//       이미 verified 된 행은 덮어쓰지 않는다 (현장 확인이 마스터보다 우선).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CSV_PATH = join(HERE, "seed", "장비마스터-20260702.csv");
const ENV_PATH = join(HERE, "..", ".env.local");

function loadEnv(path) {
  const env = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}

export function parseCsv(text) {
  const rows = [];
  let row = [], cell = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') inQ = false;
      else cell += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.length > 1);
}

const ATTN = /분실|도난|파손|고장|수리|확인 (필요|파악)|판매됨|불가/;
const num = (v) => (v === "" || v == null ? null : Number(v));

/** CSV 행 → 원장 행. 순수 함수(테스트 대상). */
export function toLedgerRow(r) {
  const [major, id, category, name, total, avail, out, maint, state, note] = r;
  if (!id && !name) return null;
  const stockTotal = num(total);
  const stockMaint = num(maint) ?? 0;
  const audit = num(r[10]);
  const auditMismatch =
    audit != null && stockTotal != null && Number.isFinite(audit) && audit > stockTotal;
  const bad =
    [num(avail), num(out), stockMaint].some((v) => v != null && (v < 0 || v > 500)) ||
    (stockMaint || 0) > 0 ||
    (state && state !== "정상") ||
    ATTN.test(note || "") ||
    auditMismatch;
  const openIssues = [];
  if (ATTN.test(note || "")) openIssues.push({ label: note, at: "master-20260702" });
  if ((stockMaint || 0) > 0) openIssues.push({ label: `정비중 ${stockMaint}대`, at: "master-20260702" });
  if (auditMismatch) openIssues.push({ label: `실사 ${audit} > 보유 ${stockTotal} — 수량 재확인`, at: "master-20260702" });
  return {
    equipment_id: id || `NOID-${name}`,
    major: major || null,
    category: category || null,
    name,
    stock_total: Number.isFinite(stockTotal) ? stockTotal : null,
    stock_maint: Number.isFinite(stockMaint) ? Math.max(0, stockMaint) : 0,
    price: num(r[11]),
    state: state || "정상",
    note: note || null,
    verify_status: bad ? "attention" : "unverified",
    open_issues: openIssues,
    source: "master-20260702",
  };
}

async function main() {
  const dry = process.argv.includes("--dry-run");
  const env = loadEnv(ENV_PATH);
  const BASE = env.NEXT_PUBLIC_SUPABASE_URL;
  const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!BASE || !KEY) throw new Error("SUPABASE env 누락");

  const [, ...rows] = parseCsv(readFileSync(CSV_PATH, "utf8"));
  const ledger = rows.map(toLedgerRow).filter(Boolean);
  const attention = ledger.filter((l) => l.verify_status === "attention").length;
  console.log(`시드 대상 ${ledger.length}개 품목 (주의 ${attention} / 미검증 ${ledger.length - attention})`);
  if (dry) return console.log("[dry-run] 쓰기 생략. 샘플:", JSON.stringify(ledger[0], null, 2));

  // 이미 현장 확인(verified)된 행은 보존: 기존 verified id 목록을 먼저 읽는다.
  const headers = {
    apikey: KEY,
    Authorization: `Bearer ${KEY}`,
    "Content-Type": "application/json",
    "Content-Profile": "village",
    "Accept-Profile": "village",
  };
  const existing = await fetch(
    `${BASE}/rest/v1/equipment_ledger?select=equipment_id&verify_status=eq.verified`,
    { headers }
  );
  if (!existing.ok) throw new Error(`원장 조회 실패 (${existing.status}) — SQL 마이그레이션을 먼저 실행했나요?\n${await existing.text()}`);
  const keep = new Set((await existing.json()).map((r) => r.equipment_id));
  const upserts = ledger.filter((l) => !keep.has(l.equipment_id));
  if (keep.size) console.log(`현장 확인 완료 ${keep.size}건은 건드리지 않습니다.`);

  const res = await fetch(`${BASE}/rest/v1/equipment_ledger?on_conflict=equipment_id`, {
    method: "POST",
    headers: { ...headers, Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(upserts),
  });
  if (!res.ok) throw new Error(`시드 실패 (${res.status}): ${await res.text()}`);
  console.log(`완료: ${upserts.length}개 품목 upsert.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e.message || e);
    process.exit(1);
  });
}
