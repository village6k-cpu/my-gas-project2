import { createClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';
import { gasPost } from './gasPublic';
import { invoiceWorkReferences, invoiceRequestRow, invoiceRequestSummary } from '../followups/invoice-model.mjs';

type Row = Record<string, any>;
const FIELDS = 'id,version,work_type,title,summary,payload,priority,state,room_key,first_opened_at,resolution_evidence';
export class InvoiceRequestError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
export function invoiceDb() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new InvoiceRequestError('계산서 작업대 연결 설정이 없습니다', 503);
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}
function checked(result: { data: any; error: { message: string } | null }) {
  if (result.error) throw new Error('계산서 요청을 읽지 못했습니다');
  return result.data;
}
async function workspace(tids: string[], options: Row = {}): Promise<Row> {
  const result = await gasPost({ action: 'taxInvoiceWorkspace', tids, options }) as Row;
  if (result?.success !== true || !Array.isArray(result.items) || !Array.isArray(result.buyers)) throw new Error(result?.error || '계산서 원본 정보를 확인하지 못했습니다');
  if (tids.some(id => !result.items.some((item: Row) => item.tradeId === id))) throw new Error('계산서 원본 조회 결과가 누락되었습니다');
  return result;
}
export async function listInvoiceRequests(countOnly = false) {
  const db = invoiceDb();
  if (countOnly) {
    const result = await db.from('work_items_v2').select('id', { count: 'exact', head: true }).eq('work_type', 'tax_invoice').in('state', ['open', 'in_progress', 'snoozed']);
    if (result.error || result.count === null) throw new Error('계산서 요청 건수를 확인하지 못했습니다');
    return { ok: true, count: result.count };
  }
  const work: Row[] = [];
  for (let offset = 0; offset < 5000; offset += 1000) {
    const rows = checked(await db.from('work_items_v2').select(FIELDS).eq('work_type', 'tax_invoice')
      .in('state', ['open', 'in_progress', 'snoozed', 'resolved']).order('id').range(offset, offset + 999)) as Row[];
    work.push(...rows);
    if (rows.length < 1000) break;
    if (offset === 4000) throw new Error('계산서 요청이 조회 범위를 초과했습니다');
  }
  const targets = work.flatMap(w => { const r = invoiceWorkReferences(w); return r.ids.length === 1
    ? [{ key: w.id, tradeId: r.ids[0], ...(r.buyer ? { buyer: r.buyer } : {}), ...(r.expectedAmount != null ? { expectedAmount: r.expectedAmount } : {}) }] : []; });
  const items: Row[] = []; let buyers: Row[] = []; let observedAt = new Date().toISOString();
  // 빈 요청 목록에서도 발행처 선택지를 읽을 수 있지만, 원본 장애를 빈 목록으로 숨기지는 않는다.
  for (let offset = 0; offset < Math.max(1, targets.length); offset += 200) {
    const batch = targets.slice(offset, offset + 200);
    const snapshot = await workspace([...new Set(batch.map(t => t.tradeId))] as string[], { targets: batch });
    items.push(...snapshot.items); buyers = snapshot.buyers; observedAt = snapshot.observedAt;
  }
  const rows = work.map(w => invoiceRequestRow(w, items.find(i => i.workspaceKey === w.id) || null))
    .sort((a, b) => (a.priority === 'p0' ? -1 : b.priority === 'p0' ? 1 : 0) || a.requestedAt.localeCompare(b.requestedAt));
  return { ok: true, rows, summary: invoiceRequestSummary(rows), buyers, observedAt };
}
export async function searchInvoiceTrades(search: string) {
  const value = search.trim();
  if (value.length < 2 || value.length > 80 || /[,()%_*]/.test(value)) throw new InvoiceRequestError('고객명 또는 거래번호를 2자 이상 입력해주세요');
  const db = invoiceDb();
  return { ok: true, trades: checked(await db.schema('village').from('trades')
    .select('trade_id,customer_name,checkout_at,amount,billing_company,issue_status')
    .or(`customer_name.ilike.%${value}%,trade_id.ilike.%${value}%`).neq('contract_status', '취소').order('checkout_at', { ascending: false }).limit(30)) };
}
async function currentWork(body: Row, db: ReturnType<typeof invoiceDb>) {
  if (!/^[a-f0-9-]{36}$/i.test(body.id || '') || !Number.isSafeInteger(body.expectedVersion)) throw new InvoiceRequestError('계산서 요청 식별자 오류');
  const work = checked(await db.from('work_items_v2').select(FIELDS).eq('id', body.id).eq('work_type', 'tax_invoice').maybeSingle()) as Row | null;
  if (!work || work.version !== body.expectedVersion || ['resolved', 'dismissed'].includes(work.state)) throw new InvoiceRequestError('다른 곳에서 변경된 요청입니다. 새로고침해주세요', 409);
  return work;
}
export async function processInvoiceRequest(body: Row, actor: string) {
  if (!['prepare', 'issue'].includes(body.action) || !/^\d{6}-\d{3}$/.test(body.tradeId || '')) throw new InvoiceRequestError('발행할 거래를 선택해주세요');
  const db = invoiceDb(), work = await currentWork(body, db);
  const references = invoiceWorkReferences(work);
  if (body.action === 'issue' && references.complexReason) throw new InvoiceRequestError(references.complexReason);
  const options = { ...(body.buyerId ? { buyerId: body.buyerId } : {}), ...(body.buyer ? { buyer: body.buyer } : {}) };
  if (body.action === 'prepare') {
    const snapshot = await workspace([body.tradeId], options);
    const draft = { tradeId: body.tradeId, buyer: snapshot.items[0].buyer, fingerprint: snapshot.items[0].fingerprint };
    const evidence = { ...(work.resolution_evidence || {}), invoiceDraft: draft };
    if (body.dryRun === true) return { ok: true, dryRun: true, row: invoiceRequestRow(work, snapshot.items[0]), buyers: snapshot.buyers };
    const saved = checked(await db.from('work_items_v2').update({ resolution_evidence: evidence, version: work.version + 1, updated_at: new Date().toISOString() })
      .eq('id', work.id).eq('version', work.version).select(FIELDS).maybeSingle()) as Row | null;
    if (!saved) throw new InvoiceRequestError('다른 곳에서 변경된 요청입니다. 새로고침해주세요', 409);
    return { ok: true, row: invoiceRequestRow(saved, snapshot.items[0]), buyers: snapshot.buyers };
  }
  if (!/^[a-f0-9]{64}$/.test(body.fingerprint || '')) throw new InvoiceRequestError('발행 정보를 다시 확인해주세요');
  const request = { action: 'issueTaxInvoiceWorkspace', tradeId: body.tradeId, fingerprint: body.fingerprint, buyer: body.buyer };
  const preview = await gasPost({ ...request, dryRun: true }) as Row;
  if (preview?.success !== true || !preview.item || !preview.alreadyIssued && preview.item.canIssue !== true) throw new InvoiceRequestError(preview?.error || '발행 정보를 다시 확인해주세요', 409);
  if (body.dryRun === true) return { ok: true, dryRun: true, row: invoiceRequestRow(work, preview.item) };
  await currentWork(body, db); // 원본 조회 중 다른 직원이 종료·수정한 요청은 발행하지 않는다.
  const operationId = createHash('sha256').update(`${body.tradeId}:${body.fingerprint}`).digest('hex');
  let result: Row;
  try {
    result = preview.alreadyIssued ? preview : await gasPost({ ...request, dryRun: false, mutationId: operationId,
      operationId, capability: 'invoice.workspace_issue' }) as Row;
  } catch {
    throw new InvoiceRequestError('발행 결과를 확인하지 못했습니다. 다시 발행하지 말고 새로고침 후 원장을 확인해주세요.', 503);
  }
  if (result?.success !== true || result.item?.status !== 'issued' || !result.item.mgtKey) throw new InvoiceRequestError(result?.error || '발행 결과 확인이 필요합니다. 다시 발행하지 마세요', 503);
  let warning: string | null = null;
  let finalWork = work;
  try {
    const completion = checked(await db.rpc('complete_heybilli_work_item_v2', {
      p_id: work.id, p_expected_version: work.version, p_completed_by: actor,
    }));
    if (completion?.applied !== true || completion.row?.state !== 'resolved') throw new Error('completion conflict');
    finalWork = { ...work, state: 'resolved', version: completion.row.version };
    const evidence = { ...(completion.row.resolution_evidence || {}), taxInvoice: {
      tradeId: body.tradeId, amount: result.item.amount, buyer: result.item.buyer, mgtKey: result.item.mgtKey, verifiedAt: new Date().toISOString(),
    } };
    const stored = await db.from('work_items_v2').update({ resolution_evidence: evidence }).eq('id', work.id).eq('version', completion.row.version);
    if (stored.error) warning = '계산서는 발행됐습니다. 업무 기록의 증빙 연결을 확인해주세요.';
  } catch { warning = '계산서는 발행됐습니다. 후속조치 완료 상태만 다시 확인해주세요.'; }
  return { ok: true, issued: true, row: invoiceRequestRow(finalWork, result.item), warning };
}
