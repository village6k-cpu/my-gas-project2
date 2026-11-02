import { NextRequest, NextResponse } from 'next/server';
import { getAuthedUser } from '@/lib/server/authCache';
import { InvoiceRequestError, listInvoiceRequests, processInvoiceRequest, searchInvoiceTrades } from '@/lib/server/invoiceRequests';

export const dynamic = 'force-dynamic';
export const maxDuration = 180;
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
function failure(error: unknown) {
  return json({ ok: false, error: error instanceof Error ? error.message : '계산서 작업을 처리하지 못했습니다' }, error instanceof InvoiceRequestError ? error.status : 503);
}
export async function GET(req: NextRequest) {
  if (!(await getAuthedUser(req))) return json({ ok: false, error: '인증 필요' }, 401);
  try {
    const search = req.nextUrl.searchParams.get('search');
    return json(search !== null ? await searchInvoiceTrades(search) : await listInvoiceRequests(req.nextUrl.searchParams.get('count') === '1'));
  } catch (error) { return failure(error); }
}
export async function POST(req: NextRequest) {
  const user = await getAuthedUser(req);
  if (!user) return json({ ok: false, error: '인증 필요' }, 401);
  try {
    const body = await req.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new InvoiceRequestError('요청 형식 오류');
    return json(await processInvoiceRequest(body, `heybilli:${user.id}`));
  } catch (error) { return failure(error); }
}
