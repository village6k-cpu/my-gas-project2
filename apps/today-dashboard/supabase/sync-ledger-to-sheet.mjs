// 재고 원장(village.equipment_ledger) → 장비마스터 시트 미러링
//
// 사용: node supabase/sync-ledger-to-sheet.mjs [--dry-run]
// 방향: 앱(원장)이 진실, 시트는 거울. 시트의 D(장비명)/E(총보유)/H(정비중)/I(상태)/J(비고)만
//       원장 값으로 맞추고, F(가용)/G(대여중)/K(최근실사)는 절대 건드리지 않는다.
// 신규 장비(앱에서 등록)는 시트 맨 아래에 append, 보관 처리는 I열 '보관종료'로 표시만 한다.
// GAS 배포: @522 equipmentMasterSync (운영 @521과 분리된 전용 배포).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const GAS_SYNC_URL =
  process.env.GAS_SYNC_URL ||
  "https://script.google.com/macros/s/AKfycbwuxYTo2PNyNSLgVTLv9_U3S5tQhwSnZlCXJ3cP1XXDaEU8fGgxlwzmHCLD_COeAs0h/exec";
const GAS_KEY = process.env.GAS_API_KEY || "village2026";

function loadEnv(path = join(HERE, "..", ".env.local")) {
  const env = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}

/** 원장 행 → 시트 비고(J) 문자열: note + 문제 라벨들 (중복 제거). 순수 함수(테스트 대상). */
export function mirrorNote(row) {
  const labels = (row.open_issues || []).map((i) => i?.label).filter(Boolean);
  return [...new Set([row.note, ...labels].filter(Boolean))].join(" · ");
}

/** 원장 vs 시트 → 갱신/추가 목록. 순수 함수(테스트 대상). */
export function diffLedgerAgainstSheet(ledger, sheetHeaders, sheetData) {
  const col = (name) => sheetHeaders.indexOf(name);
  const cID = col("장비ID"), cName = col("장비명"), cTotal = col("총보유수량"),
    cMaint = col("정비중수량"), cState = col("상태"), cNote = col("비고");
  if ([cID, cName, cTotal, cMaint, cState, cNote].some((c) => c < 0)) {
    throw new Error(`장비마스터 헤더가 예상과 다릅니다: ${sheetHeaders.join(",")}`);
  }
  const sheetById = new Map();
  for (const r of sheetData) {
    const id = String(r[cID] || "").trim();
    if (id && !sheetById.has(id)) sheetById.set(id, r);
  }
  const rows = [], append = [];
  for (const l of ledger) {
    const archived = l.state === "보관종료";
    const want = {
      id: l.equipment_id,
      name: l.name,
      // 보관종료 = 더 이상 보유하지 않음 → 가용 계산이 시트 총보유를 읽어도 안전하게 0
      total: archived ? 0 : l.stock_total,
      maint: archived ? 0 : l.stock_maint ?? 0,
      state: l.state || "정상",
      note: mirrorNote(l),
    };
    const s = sheetById.get(l.equipment_id);
    if (!s) {
      append.push({ ...want, major: l.major || "", category: l.category || "", price: l.price });
      continue;
    }
    const cur = {
      name: String(s[cName] ?? ""),
      total: s[cTotal] === "" || s[cTotal] == null ? null : Number(s[cTotal]),
      maint: s[cMaint] === "" || s[cMaint] == null ? 0 : Number(s[cMaint]),
      state: String(s[cState] ?? "") || "정상",
      note: String(s[cNote] ?? ""),
    };
    if (
      cur.name !== want.name ||
      cur.total !== (want.total ?? null) ||
      cur.maint !== want.maint ||
      cur.state !== want.state ||
      cur.note !== want.note
    ) {
      rows.push(want);
    }
  }
  return { rows, append };
}

async function gas(action, body) {
  const res = await fetch(GAS_SYNC_URL + (body ? "" : `?key=${GAS_KEY}&${action}`), {
    method: body ? "POST" : "GET",
    redirect: "follow",
    headers: body ? { "content-type": "text/plain;charset=utf-8" } : undefined,
    body: body ? JSON.stringify({ key: GAS_KEY, action, ...body }) : undefined,
  });
  if (!res.ok) throw new Error(`GAS ${action} 실패 (${res.status})`);
  return res.json();
}

async function main() {
  const dry = process.argv.includes("--dry-run");
  const env = loadEnv();
  const KEY = env.SUPABASE_SERVICE_ROLE_KEY;

  const ledger = await (
    await fetch(
      `${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/equipment_ledger?select=equipment_id,major,category,name,stock_total,stock_maint,price,state,note,open_issues&limit=1000`,
      { headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, "Accept-Profile": "village" } }
    )
  ).json();
  if (!Array.isArray(ledger)) throw new Error(`원장 조회 실패: ${JSON.stringify(ledger).slice(0, 200)}`);

  const sheet = await gas("action=read&sheet=" + encodeURIComponent("장비마스터"));
  if (!sheet?.headers) throw new Error(`시트 조회 실패: ${JSON.stringify(sheet).slice(0, 200)}`);

  const { rows, append } = diffLedgerAgainstSheet(ledger, sheet.headers, sheet.data || []);
  console.log(`원장 ${ledger.length}행 · 시트 ${sheet.rowCount}행 → 갱신 ${rows.length}건 / 추가 ${append.length}건`);
  for (const r of rows.slice(0, 20)) console.log(`  ~ ${r.id} ${r.name}`);
  for (const a of append.slice(0, 20)) console.log(`  + ${a.id} ${a.name}`);
  if (dry) return console.log("[dry-run] 시트 쓰기 생략.");
  if (!rows.length && !append.length) return console.log("변경 없음 — 시트가 이미 최신입니다.");

  const result = await gas("equipmentMasterSync", { rows, append });
  console.log(`완료: 갱신 ${result.updated} / 추가 ${result.appended}` +
    (result.skipped?.length ? ` / 건너뜀 ${result.skipped.join(",")}` : ""));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e.message || e);
    process.exit(1);
  });
}
