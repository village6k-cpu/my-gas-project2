'use strict';

const fs = require('node:fs');

function parseConfig(source) {
  const allowed = new Set(['SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'VILLAGE2_API_URL', 'VILLAGE2_API_KEY']);
  const config = {};
  for (const line of String(source).split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match || !allowed.has(match[1])) continue;
    const value = match[2];
    config[match[1]] = /^(".*"|'.*')$/.test(value) ? value.slice(1, -1) : value;
  }
  return config;
}

function validateSelector({ tradeId, customer, checkoutDate }) {
  if (Boolean(tradeId) === Boolean(customer)) throw new Error('Specify exactly one of --trade-id or --customer');
  if (tradeId && !/^\d{6}-\d{3}$/.test(tradeId)) throw new Error('Invalid trade ID');
  if (customer && (customer.length > 80 || /[\x00-\x1f]/.test(customer))) throw new Error('Invalid customer name');
  if (checkoutDate && (!/^\d{4}-\d{2}-\d{2}$/.test(checkoutDate) ||
      !Number.isFinite(Date.parse(checkoutDate)) || new Date(checkoutDate).toISOString().slice(0, 10) !== checkoutDate)) {
    throw new Error('Invalid checkout date');
  }
}

function kst(value) {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time + 9 * 3600000).toISOString().replace('Z', '+09:00') : null;
}

function cancellationCapability(receipt, sources, events) {
  const vans = [...new Set(events.filter(e => e.receipt_id === receipt.id)
    .flatMap(e => [e.providerVan, e.providerCardVan]).filter(Boolean))];
  const front = sources.filter(a => a.source === 'front');
  const van = vans.length === 1 ? vans[0] : null;
  const status = receipt.status === 'cancelled' ? 'already_cancelled'
    : van && van !== 'NICE' ? 'unsupported_van'
    : van === 'NICE' ? 'terminal_verification_required' : 'van_unverified';
  return { van, status, cardlessReady: false, remoteExecutionAvailable: false,
    paymentKey: front.length === 1 ? front[0].source_id : null,
    reason: status === 'already_cancelled' ? '이미 취소된 승인입니다.'
      : status === 'unsupported_van' ? `${van}는 토스 프론트 무카드 취소 지원 대상이 아닙니다. 원결제 카드 재인식 취소가 필요합니다.`
      : '원결제 단말에서 NICE·CARD와 실제 vanTransactionKey를 확인해야 합니다. 서버 조회만으로 무카드 취소 가능 판정을 내리지 않습니다.',
    execution: '원결제 프론트 직원 설정 > 최근 결제 취소에서 승인번호·금액·시각을 대조한 뒤 한 건만 선택합니다.' };
}

function summarize(account, current, allocations, receipts, aliases, events) {
  const associated = new Set([
    ...allocations.filter(a => a.trade_id === account.trade_id).map(a => a.receipt_id),
    ...aliases.filter(a => a.trade_id === account.trade_id).map(a => a.receipt_id)
  ]);
  const linked = receipts.filter(r => associated.has(r.id));
  const cards = linked.filter(r => r.source === 'front' || r.source === 'toss').map(r => {
    const sources = aliases.filter(a => a.receipt_id === r.id);
    const matchingToss = sources.filter(a => a.source === 'toss' &&
      a.financial_identity?.amount === r.amount &&
      a.financial_identity?.approval_number === r.approval_number &&
      Number.isFinite(Date.parse(r.occurred_at)) &&
      Date.parse(a.financial_identity?.occurred_at) === Date.parse(r.occurred_at));
    return {
      receiptId: r.id, amount: r.amount, approvalNumber: r.approval_number,
      approvedAtKst: kst(r.occurred_at), status: r.status,
      allocatedToTrade: allocations.filter(a => a.receipt_id === r.id && a.trade_id === account.trade_id).reduce((n, a) => n + a.amount, 0),
      providerVerified: matchingToss.length === 1,
      providerReferences: matchingToss.map(a => a.source_id),
      reviewReason: r.review_reason,
      cancellation: cancellationCapability(r, sources, events),
      updatedAt: r.updated_at,
      eventTypes: [...new Set(events.filter(e => e.receipt_id === r.id).map(e => e.event_type))]
    };
  });
  const paid = account.opening_paid + allocations.filter(a => a.trade_id === account.trade_id &&
    linked.some(r => r.id === a.receipt_id && r.status === 'active')).reduce((n, a) => n + a.amount, 0);
  const active = cards.filter(r => r.status === 'active');
  const warnings = [];
  if (paid !== account.paid_amount) warnings.push('Ledger changed during read; rerun before concluding');
  if (associated.size !== linked.length) warnings.push('A linked receipt is missing');
  if (cards.some(r => !r.providerVerified)) warnings.push('Some card receipts lack one matching Toss approval identity');
  if (current.billed_amount !== account.billed_amount) warnings.push('Current billed amount differs from cached account');
  return {
    tradeId: account.trade_id, customer: current.customer_name, checkoutAt: current.checkout_at,
    billedAmount: current.billed_amount, billingObservedAt: current.observed_at,
    billingChanged: current.billed_amount !== account.billed_amount,
    openingPaid: account.opening_paid, paidAmount: paid,
    credit: current.billed_amount == null ? null : Math.max(paid - current.billed_amount, 0),
    reviewRequired: account.review_required || current.billed_amount == null,
    activeCardApprovalCount: active.length,
    activeCardAllocated: active.reduce((n, r) => n + r.allocatedToTrade, 0),
    activeCardReceiptTotal: active.reduce((n, r) => n + r.amount, 0),
    approvals: cards, warnings
  };
}

async function audit({ config, tradeId, customer, checkoutDate, fetchImpl = globalThis.fetch }) {
  validateSelector({ tradeId, customer, checkoutDate });
  const origin = new URL(config.SUPABASE_URL || config.NEXT_PUBLIC_SUPABASE_URL || 'https://invalid');
  const gas = new URL(config.VILLAGE2_API_URL || 'https://invalid');
  if (origin.protocol !== 'https:' || !origin.hostname.endsWith('.supabase.co') || origin.username || origin.password ||
      gas.protocol !== 'https:' || gas.hostname !== 'script.google.com' ||
      !config.SUPABASE_SERVICE_ROLE_KEY || !config.VILLAGE2_API_KEY) throw new Error('Finance configuration is incomplete or endpoint is invalid');
  async function read(table, params) {
    const url = new URL('/rest/v1/' + table, origin);
    url.search = new URLSearchParams({ ...params, limit: '500' });
    let response;
    try {
      response = await fetchImpl(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(20000),
        headers: { apikey: config.SUPABASE_SERVICE_ROLE_KEY, Authorization: 'Bearer ' + config.SUPABASE_SERVICE_ROLE_KEY, 'Accept-Profile': 'village' } });
    } catch { throw new Error(`Payment ledger unavailable: ${table}`); }
    if (!response.ok) throw new Error(`Payment ledger ${table}: HTTP ${response.status}`);
    const rows = await response.json();
    if (!Array.isArray(rows) || rows.length >= 500) throw new Error(`Incomplete payment ledger result: ${table}`);
    return rows;
  }
  const params = tradeId ? { trade_id: 'eq.' + tradeId } : { customer_name: 'eq.' + customer };
  let accounts = await read('payment_account_balances', params);
  if (checkoutDate) accounts = accounts.filter(a => String(a.checkout_at || '').slice(0, 10) === checkoutDate);
  if (accounts.length > 20) throw new Error('Too many trades; specify a checkout date or trade ID');
  if (!accounts.length) return { ok: true, readOnly: true, retrievedAt: new Date().toISOString(), trades: [], warning: 'No matched account; resolve trade in the reservation system. This does not prove no payment.' };
  const tids = accounts.map(a => a.trade_id);
  const filter = 'in.(' + tids.join(',') + ')';
  const [allocations, directAliases, billing] = await Promise.all([
    read('payment_allocations', { trade_id: filter }),
    read('payment_receipt_aliases', { trade_id: filter }),
    (async () => {
      let res;
      try {
        res = await fetchImpl(gas, { method: 'POST', redirect: 'follow', signal: AbortSignal.timeout(40000),
          headers: { 'content-type': 'text/plain;charset=utf-8' },
          body: JSON.stringify({ action: 'paymentLedgerSnapshot', tids, key: config.VILLAGE2_API_KEY }) });
      } catch { throw new Error('Current billing snapshot unavailable'); }
      if (!res.ok) throw new Error(`Current billing snapshot: HTTP ${res.status}`);
      const data = await res.json();
      if (data.success !== true || !Array.isArray(data.accounts)) throw new Error('Current billing snapshot rejected');
      return data.accounts;
    })()
  ]);
  const ids = [...new Set([...allocations, ...directAliases].map(a => a.receipt_id))];
  const receiptFilter = 'in.(' + ids.join(',') + ')';
  const [receipts, aliases, events] = ids.length ? await Promise.all([
    read('payment_receipts', { id: receiptFilter, select: 'id,source,amount,occurred_at,approval_number,status,review_reason,updated_at' }),
    read('payment_receipt_aliases', { receipt_id: receiptFilter }),
    read('payment_events', { receipt_id: receiptFilter, select: 'id,event_type,receipt_id,created_at,providerVan:request_payload->receipt->raw->payment->>van,providerCardVan:request_payload->receipt->raw->payment->cardDetails->>van', order: 'id.asc' })
  ]) : [[], [], []];
  return {
    ok: true, readOnly: true, retrievedAt: new Date().toISOString(),
    source: 'Current GAS billing and canonical village payment ledger; stored processor approvals/cancellations',
    trades: accounts.map(account => {
      const matches = billing.filter(row => row.trade_id === account.trade_id);
      if (matches.length !== 1) throw new Error('Current billing does not uniquely identify the trade');
      return summarize(account, matches[0], allocations, receipts, aliases, events);
    })
  };
}

async function main(args) {
  const options = {};
  const flags = { '--trade-id': 'tradeId', '--customer': 'customer', '--checkout-date': 'checkoutDate', '--env-file': 'envFile' };
  for (let i = 0; i < args.length; i += 2) {
    if (!flags[args[i]] || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Invalid or incomplete option');
    options[flags[args[i]]] = args[i + 1].trim();
  }
  const envFile = options.envFile || process.env.VILLAGE_FINANCE_ENV;
  if (!envFile) throw new Error('Set VILLAGE_FINANCE_ENV or --env-file to the existing finance configuration');
  let source;
  try { source = fs.readFileSync(envFile, 'utf8'); } catch { throw new Error('Finance configuration file unavailable'); }
  return audit({ ...options, config: parseConfig(source) });
}

if (require.main === module) main(process.argv.slice(2)).then(result => console.log(JSON.stringify(result, null, 2))).catch(error => {
  console.error(JSON.stringify({ ok: false, readOnly: true, error: error.message }));
  process.exitCode = 1;
});
module.exports = { audit, summarize, parseConfig, validateSelector, cancellationCapability };
