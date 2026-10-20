-- Older terminal bundles omit approval time. A verified provider alias can
-- complete that evidence and the terminal's explicit reservation binding.
create or replace function village.payment_reconcile_front_approval(p_receipt_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  r village.payment_receipts%rowtype;
  v_evidence jsonb; v_tid text; v_count integer; v_old jsonb; v_result jsonb;
begin
  perform pg_advisory_xact_lock(20261020,90000);
  select * into r from village.payment_receipts where id=p_receipt_id for update;
  if not found then raise exception 'receipt not found'; end if;
  -- A staff allocation/unlink, cancellation, or unrelated review is never undone.
  if r.status<>'active' or r.revision<>1 or r.source<>'front'
    or r.review_reason is distinct from '승인 시각 확인 필요'
    or r.raw->>'approvalTimeEstimated' is distinct from 'true'
    or exists(select 1 from village.payment_allocations where receipt_id=r.id)
  then return jsonb_build_object('reconciled',false); end if;
  select count(*),min(trade_id) into v_count,v_tid
    from village.payment_receipt_aliases where receipt_id=r.id and source='front' and trade_id is not null;
  if v_count<>1 then return jsonb_build_object('reconciled',false); end if;
  select count(*) into v_count from village.payment_receipt_aliases where receipt_id=r.id and source='toss';
  if v_count<>1 then return jsonb_build_object('reconciled',false); end if;
  select financial_identity into v_evidence from village.payment_receipt_aliases where receipt_id=r.id and source='toss';
  if (v_evidence->>'amount')::bigint is distinct from r.amount
    or nullif(v_evidence->>'approval_number','') is null
    or v_evidence->>'approval_number' is distinct from r.approval_number
    or nullif(v_evidence->>'occurred_at','') is null
    or abs(extract(epoch from (v_evidence->>'occurred_at')::timestamptz-r.occurred_at))>120
  then raise exception 'provider approval evidence mismatch'; end if;
  v_old:=to_jsonb(r);
  update village.payment_receipts set
    occurred_at=(v_evidence->>'occurred_at')::timestamptz,
    merchant_id=coalesce(v_evidence->>'merchant_id',merchant_id),
    review_reason=null,revision=revision+1,
    raw=raw||jsonb_build_object('approvalTimeEstimated',false,'providerApprovalTimeRecovered',true),
    updated_at=clock_timestamp()
    where id=r.id returning * into r;
  insert into village.payment_events(request_id,event_type,actor,receipt_id,before_state,after_state,note)
    values('provider-evidence:'||r.id,'approval_evidence_recovered','provider_bridge',r.id,
      v_old,to_jsonb(r),'토스 승인 원본과 단말의 명시적 예약 연결 확인');
  -- Same transaction: failed allocation must leave the review intact for retry.
  v_result:=village.payment_set_allocations(r.id,
    jsonb_build_array(jsonb_build_object('trade_id',v_tid,'amount',r.amount)),
    r.revision,'provider-front-allocation:'||r.id,'provider_bridge',
    '단말에서 선택한 예약과 토스 승인 원본을 대조하여 수납 반영',true);
  return jsonb_build_object('reconciled',true,'tradeId',v_tid,'allocation',v_result);
end $$;
revoke all on function village.payment_reconcile_front_approval(uuid) from public,anon,authenticated;
grant execute on function village.payment_reconcile_front_approval(uuid) to service_role;
