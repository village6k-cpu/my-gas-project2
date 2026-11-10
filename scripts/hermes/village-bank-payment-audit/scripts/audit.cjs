'use strict';

const fs = require('node:fs');
const { parseConfig } = require('../../village-card-payment-audit/scripts/audit.cjs');

function payerForms(value) {
  const display = String(value ?? '').normalize('NFKC').trim();
  const normalize = text => text.replace(/[\s().\-_]/g, '').toLowerCase();
  return [normalize(display), normalize(display.replace(/\s*\([^()]+\)\s*$/, ''))];
}

async function auditBank({ config, payer, date, amount, fetchImpl = globalThis.fetch }) {
  const name = payerForms(payer)[0];
  if (name.length < 2 || name.length > 80) throw new Error('정확한 입금자명을 입력하세요.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '') || !Number.isFinite(Date.parse(date)) ||
      new Date(date).toISOString().slice(0, 10) !== date) throw new Error('입금일을 YYYY-MM-DD로 입력하세요.');
  if (amount !== undefined && (!Number.isSafeInteger(amount) || amount <= 0)) throw new Error('입금액은 양의 정수여야 합니다.');
  const from = new Date(date + 'T00:00:00+09:00');
  const until = new Date(from.getTime() + 86400000);
  const base = new URL(config.SUPABASE_URL || config.NEXT_PUBLIC_SUPABASE_URL);
  const key = config.SUPABASE_SERVICE_ROLE_KEY;
  if (base.protocol !== 'https:' || !base.hostname.endsWith('.supabase.co') || !key) throw new Error('수납 원장 연결 설정을 확인하세요.');
  const receipts = [];
  let latestBankReceiptAt = null;
  for (let offset = 0; offset < 2000; offset += 200) {
    const url = new URL('/rest/v1/payment_receipt_balances', base);
    url.search = new URLSearchParams({
      source: 'eq.bank', status: 'eq.active',
      and: '(occurred_at.gte.' + from.toISOString() + ',occurred_at.lt.' + until.toISOString() + ')',
      select: 'id,amount,occurred_at,created_at,payer_name,raw,revision,remaining_amount,allocations',
      order: 'occurred_at.desc,id.asc', limit: '200', offset: String(offset),
    });
    const response = await fetchImpl(url, {
      headers: { apikey: key, Authorization: 'Bearer ' + key, 'Accept-Profile': 'village' },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error('은행 원본 조회 실패 (HTTP ' + response.status + ')');
    const rows = await response.json();
    if (!Array.isArray(rows)) throw new Error('은행 원본 응답 형식 오류');
    if (!offset) latestBankReceiptAt = rows[0]?.occurred_at ?? null;
    for (const row of rows) {
      const sender = String(row.raw?.remark1 ?? '').trim() || row.payer_name;
      if (!payerForms(sender).includes(name) || (amount !== undefined && row.amount !== amount)) continue;
      receipts.push({
        receiptId: row.id, payer: sender, amount: row.amount, occurredAt: row.occurred_at,
        storedAt: row.created_at, revision: row.revision, remainingAmount: row.remaining_amount,
        allocations: row.allocations ?? [],
      });
    }
    if (rows.length < 200) return {
      source: 'bank_receipt_ledger', dateKst: date, checkedAt: new Date().toISOString(),
      latestBankReceiptAt, matchCount: receipts.length, receipts,
    };
  }
  throw new Error('조회 한도를 넘었습니다. 해당 날짜의 입금 원본을 수납 화면에서 확인하세요.');
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const flags = {};
  try {
    for (let i = 0; i < args.length; i += 2) {
      const flag = args[i];
      if (!['--payer', '--date', '--amount'].includes(flag) || !args[i + 1] || flag in flags) throw new Error('입금자명과 입금일을 지정하세요.');
      flags[flag] = args[i + 1];
    }
    const config = parseConfig(fs.readFileSync(process.env.VILLAGE_FINANCE_ENV, 'utf8'));
    auditBank({ config, payer: flags['--payer'], date: flags['--date'], amount: flags['--amount'] === undefined ? undefined : Number(flags['--amount']) })
      .then(result => console.log(JSON.stringify(result, null, 2)))
      .catch(error => { console.error(error.message); process.exitCode = 1; });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { auditBank };
