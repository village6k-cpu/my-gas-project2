-- Canonical KRW receipts and allocation ledger. Every mutation shares one transaction lock;
-- the lock is intentionally global because combined receipts can span arbitrary trades.
create table if not exists village.payment_accounts (
  trade_id text primary key,
  billed_amount bigint check (billed_amount >= 0),
  opening_paid bigint not null default 0 check (opening_paid >= 0),
  baseline_at timestamptz not null,
  initialized_at timestamptz not null default clock_timestamp(),
  observed_at timestamptz not null,
  deposit_status text,
  review_required boolean not null default false,
  customer_name text,
  payer_name text,
  contract_status text,
  checkout_at timestamptz,
  revision bigint not null default 1 check (revision > 0),
  projected_revision bigint not null default 0 check (projected_revision >= 0),
  projection_error text,
  updated_at timestamptz not null default clock_timestamp()
);
create table if not exists village.payment_receipts (
  id uuid primary key default gen_random_uuid(),
  source text not null check (source in ('bank','toss','front')),
  source_id text not null check (btrim(source_id) <> ''),
  amount bigint not null check (amount > 0),
  occurred_at timestamptz not null,
  payer_name text,
  approval_number text,
  merchant_id text,
  status text not null default 'active' check (status in ('active','cancelled')),
  revision bigint not null default 1,
  review_reason text,
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (source, source_id)
);
create index if not exists payment_receipts_approval_idx
  on village.payment_receipts(approval_number,amount,occurred_at)
  where approval_number is not null;
create table if not exists village.payment_receipt_aliases (
  source text not null check (source in ('bank','toss','front')),
  source_id text not null,
  receipt_id uuid not null references village.payment_receipts(id),
  financial_identity jsonb not null,
  trade_id text,
  created_at timestamptz not null default clock_timestamp(),
  primary key (source,source_id)
);
-- This migration may be reapplied to a prepared ledger before rollout.
alter table village.payment_receipt_aliases add column if not exists trade_id text;
create table if not exists village.payment_allocations (
  receipt_id uuid not null references village.payment_receipts(id),
  trade_id text not null references village.payment_accounts(trade_id),
  amount bigint not null check (amount >= 0),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (receipt_id,trade_id)
);
create index if not exists payment_allocations_trade_idx on village.payment_allocations(trade_id);
create table if not exists village.payment_events (
  id bigint generated always as identity primary key,
  request_id text unique,
  event_type text not null,
  actor text not null,
  receipt_id uuid references village.payment_receipts(id),
  trade_id text references village.payment_accounts(trade_id),
  request_payload jsonb,
  before_state jsonb,
  after_state jsonb,
  result jsonb,
  note text,
  created_at timestamptz not null default clock_timestamp()
);

create or replace view village.payment_account_balances with (security_invoker=true) as
with totals as (
  select a.trade_id, coalesce(sum(a.amount) filter (where r.status='active'),0)::bigint allocated_amount,
    string_agg(distinct case when r.source='bank' then '계좌이체' else '카드' end, '+')
      filter (where r.status='active' and a.amount>0) payment_method
  from village.payment_allocations a join village.payment_receipts r on r.id=a.receipt_id
  group by a.trade_id
), paid as (
  select a.*,coalesce(t.allocated_amount,0)::bigint allocated_amount,
    (a.opening_paid+coalesce(t.allocated_amount,0))::bigint paid_amount,t.payment_method
  from village.payment_accounts a left join totals t using (trade_id)
)
select p.*,case when billed_amount is null then null else greatest(billed_amount-paid_amount,0) end::bigint balance,
  case when billed_amount is null then null else greatest(paid_amount-billed_amount,0) end::bigint credit,
  case when review_required then '확인필요' when billed_amount is null then '금액확인필요'
    when contract_status='취소' then '취소' when paid_amount>=billed_amount then '입금완료'
    when paid_amount>0 then '부분입금' else '미입금' end status,
  projected_revision<revision needs_projection
from paid p;
create or replace view village.payment_receipt_balances with (security_invoker=true) as
select r.*,coalesce(a.allocated_amount,0)::bigint allocated_amount,
  (r.amount-coalesce(a.allocated_amount,0))::bigint remaining_amount,
  coalesce(a.allocations,'[]'::jsonb) allocations,
  (select min(pa.trade_id) from village.payment_receipt_aliases pa
    where pa.receipt_id=r.id and pa.source='front') explicit_trade_id
from village.payment_receipts r left join lateral (
  select sum(amount)::bigint allocated_amount,
    jsonb_agg(jsonb_build_object('trade_id',trade_id,'amount',amount) order by trade_id) allocations
  from village.payment_allocations where receipt_id=r.id
) a on true;

create or replace function village.payment_refresh_accounts(p_accounts jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare x jsonb; a village.payment_accounts%rowtype; v_amount bigint; v_time timestamptz;
  v_checkout timestamptz; v_status text; v_review boolean; v_changed boolean; v_count integer:=0;
begin
  if jsonb_typeof(p_accounts) is distinct from 'array' then raise exception 'accounts must be an array'; end if;
  perform pg_advisory_xact_lock(20261020,90000);
  for x in select value from jsonb_array_elements(p_accounts) loop
    if coalesce(btrim(x->>'trade_id'),'')='' then raise exception 'trade_id is required'; end if;
    if x->>'billed_amount' is not null and (x->>'billed_amount') !~ '^[0-9]+$' then
      raise exception 'billed_amount must be a nonnegative integer or null'; end if;
    v_amount:=(x->>'billed_amount')::bigint;
    v_time:=(x->>'observed_at')::timestamptz;
    if v_time is null or not isfinite(v_time) then raise exception 'observed_at is required'; end if;
    v_checkout:=nullif(x->>'checkout_at','')::timestamptz;
    v_status:=coalesce(btrim(x->>'deposit_status'),'');
    select * into a from village.payment_accounts where trade_id=x->>'trade_id' for update;
    if not found then
      v_review:=v_status not in ('','미입금','입금완료','결제완료')
        or (v_status in ('입금완료','결제완료') and v_amount is null);
      insert into village.payment_accounts(trade_id,billed_amount,opening_paid,baseline_at,observed_at,
        deposit_status,review_required,customer_name,payer_name,contract_status,checkout_at,projected_revision)
      values(x->>'trade_id',v_amount,case when v_status in ('입금완료','결제완료') then coalesce(v_amount,0) else 0 end,
        v_time,v_time,v_status,v_review,x->>'customer_name',x->>'payer_name',btrim(x->>'contract_status'),v_checkout,1)
      returning * into a;
      insert into village.payment_events(event_type,actor,trade_id,after_state)
        values('account_initialized','ledger_snapshot',a.trade_id,to_jsonb(a));
      v_count:=v_count+1;
    elsif v_time>a.observed_at then
      v_changed:=row(a.billed_amount,a.deposit_status,a.customer_name,a.payer_name,a.contract_status,a.checkout_at)
        is distinct from row(v_amount,v_status,x->>'customer_name',x->>'payer_name',btrim(x->>'contract_status'),v_checkout);
      update village.payment_accounts set billed_amount=v_amount,deposit_status=v_status,
        customer_name=x->>'customer_name',payer_name=x->>'payer_name',contract_status=btrim(x->>'contract_status'),
        checkout_at=v_checkout,observed_at=v_time,
        revision=revision+case when v_changed then 1 else 0 end,
        updated_at=case when v_changed then clock_timestamp() else updated_at end
      where trade_id=a.trade_id;
      if v_changed then
        insert into village.payment_events(event_type,actor,trade_id,before_state,after_state)
          select 'account_refreshed','ledger_snapshot',a.trade_id,to_jsonb(a),to_jsonb(n)
          from village.payment_accounts n where n.trade_id=a.trade_id;
        v_count:=v_count+1;
      end if;
    end if;
  end loop;
  return jsonb_build_object('success',true,'changed',v_count);
end $$;

create or replace function village.payment_ingest_receipt(p_receipt jsonb,p_request_id text,p_actor text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r village.payment_receipts%rowtype; v_old jsonb; v_identity jsonb; v_saved_identity jsonb;
  v_payload jsonb; v_event village.payment_events%rowtype; v_result jsonb; v_amount bigint;
  v_time timestamptz; v_status text; v_source text; v_source_id text; v_approval text; v_merchant text;
  v_ids uuid[]; v_id uuid; v_duplicate boolean:=false; v_reason text; v_trade_id text; v_saved_trade_id text;
begin
  if coalesce(btrim(p_request_id),'')='' or coalesce(btrim(p_actor),'')='' then raise exception 'request_id and actor required'; end if;
  if jsonb_typeof(p_receipt) is distinct from 'object' then raise exception 'receipt must be an object'; end if;
  v_payload:=jsonb_build_object('operation','ingest','receipt',p_receipt,'actor',p_actor);
  perform pg_advisory_xact_lock(20261020,90000);
  select * into v_event from village.payment_events where request_id=p_request_id;
  if found then
    if v_event.request_payload is distinct from v_payload then raise exception 'request_id payload mismatch'; end if;
    return v_event.result;
  end if;
  v_source:=p_receipt->>'source';v_source_id:=btrim(p_receipt->>'source_id');
  if v_source is null or v_source not in ('bank','toss','front') or coalesce(v_source_id,'')='' then raise exception 'invalid receipt source'; end if;
  if coalesce(p_receipt->>'amount','') !~ '^[0-9]+$' then raise exception 'amount must be a positive integer'; end if;
  v_amount:=(p_receipt->>'amount')::bigint;
  if v_amount<=0 then raise exception 'amount must be positive'; end if;
  v_time:=(p_receipt->>'occurred_at')::timestamptz;
  if v_time is null or not isfinite(v_time) then raise exception 'occurred_at is required'; end if;
  v_status:=coalesce(p_receipt->>'status','active');
  if v_status not in ('active','cancelled') then raise exception 'invalid receipt status'; end if;
  v_approval:=nullif(btrim(p_receipt->>'approval_number'),'');v_merchant:=nullif(btrim(p_receipt->>'merchant_id'),'');
  v_trade_id:=case when v_source='front' then nullif(btrim(p_receipt#>>'{raw,tradeId}'),'') else null end;
  v_identity:=jsonb_build_object('amount',v_amount,'occurred_at',v_time,'approval_number',v_approval,'merchant_id',v_merchant);
  select receipt_id,financial_identity,trade_id into v_id,v_saved_identity,v_saved_trade_id from village.payment_receipt_aliases
    where source=v_source and source_id=v_source_id;
  if found then
    if v_saved_identity is distinct from v_identity then raise exception 'immutable receipt identity mismatch'; end if;
    if v_trade_id is not null and v_saved_trade_id is not null and v_trade_id<>v_saved_trade_id then
      raise exception 'immutable receipt trade binding mismatch'; end if;
    v_duplicate:=true;
  elsif v_source in ('front','toss') and v_approval is not null then
    select array_agg(id) into v_ids from village.payment_receipts c
      where c.source in ('front','toss') and c.source<>v_source and c.approval_number=v_approval and c.amount=v_amount
        and (v_merchant is null or c.merchant_id is null or c.merchant_id=v_merchant)
        and abs(extract(epoch from c.occurred_at-v_time))<=120;
    if coalesce(array_length(v_ids,1),0)=1 and not exists (
      select 1 from village.payment_receipt_aliases where receipt_id=v_ids[1] and source=v_source
    ) then v_id:=v_ids[1];v_duplicate:=true;
    elsif coalesce(array_length(v_ids,1),0)>0 then
      v_reason:='ambiguous_approval_identity';
      update village.payment_receipts set review_reason=v_reason,revision=revision+1,updated_at=clock_timestamp() where id=any(v_ids);
    end if;
  end if;
  if v_id is null then
    insert into village.payment_receipts(source,source_id,amount,occurred_at,payer_name,approval_number,merchant_id,status,raw,review_reason)
      values(v_source,v_source_id,v_amount,v_time,p_receipt->>'payer_name',v_approval,v_merchant,v_status,
        coalesce(p_receipt->'raw','{}'::jsonb),coalesce(v_reason,nullif(p_receipt->>'review_reason','')))
      returning * into r;
    v_id:=r.id;
  else
    select * into r from village.payment_receipts where id=v_id for update;
    v_old:=to_jsonb(r);
    -- A late approval must never resurrect an already cancelled receipt.
    if v_status='cancelled' and r.status<>'cancelled' then
      update village.payment_receipts set status='cancelled',revision=revision+1,updated_at=clock_timestamp()
        where id=v_id returning * into r;
      update village.payment_accounts set revision=revision+1,updated_at=clock_timestamp()
        where trade_id in (select trade_id from village.payment_allocations where receipt_id=v_id and amount>0);
    end if;
  end if;
  if v_trade_id is not null and exists (
    select 1 from village.payment_receipt_aliases where receipt_id=v_id and trade_id is not null and trade_id<>v_trade_id
  ) then raise exception 'conflicting receipt trade binding'; end if;
  insert into village.payment_receipt_aliases(source,source_id,receipt_id,financial_identity,trade_id)
    values(v_source,v_source_id,v_id,v_identity,v_trade_id) on conflict(source,source_id) do update
      set trade_id=coalesce(village.payment_receipt_aliases.trade_id,excluded.trade_id);
  v_result:=jsonb_build_object('success',true,'receiptId',v_id,'duplicate',v_duplicate,'status',r.status,'revision',r.revision,'reviewReason',r.review_reason);
  insert into village.payment_events(request_id,event_type,actor,receipt_id,request_payload,before_state,after_state,result)
    values(p_request_id,'receipt_ingested',p_actor,v_id,v_payload,v_old,to_jsonb(r),v_result);
  return v_result;
end $$;

create or replace function village.payment_set_allocations(p_receipt_id uuid,p_allocations jsonb,p_expected_revision bigint,
  p_request_id text,p_actor text,p_note text,p_allow_overpay boolean default false)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r village.payment_receipts%rowtype; a village.payment_accounts%rowtype; x jsonb;
  v_event village.payment_events%rowtype; v_payload jsonb; v_result jsonb; v_before jsonb;
  v_total numeric:=0; v_amount bigint; v_other numeric; v_affected text[]; v_tid text;
begin
  if coalesce(btrim(p_request_id),'')='' or coalesce(btrim(p_actor),'')='' then raise exception 'request_id and actor required'; end if;
  if jsonb_typeof(p_allocations) is distinct from 'array' then raise exception 'allocations must be an array'; end if;
  v_payload:=jsonb_build_object('operation','allocate','receipt_id',p_receipt_id,'allocations',p_allocations,
    'expected_revision',p_expected_revision,'actor',p_actor,'note',p_note,'allow_overpay',coalesce(p_allow_overpay,false));
  perform pg_advisory_xact_lock(20261020,90000);
  select * into v_event from village.payment_events where request_id=p_request_id;
  if found then
    if v_event.request_payload is distinct from v_payload then raise exception 'request_id payload mismatch'; end if;
    return v_event.result;
  end if;
  select * into r from village.payment_receipts where id=p_receipt_id for update;
  if not found then raise exception 'receipt not found'; end if;
  if p_expected_revision is null or r.revision<>p_expected_revision then raise exception 'receipt revision conflict'; end if;
  if r.status<>'active' then raise exception 'cancelled receipt cannot be allocated'; end if;
  if r.review_reason is not null then raise exception 'receipt requires review'; end if;
  if exists(select 1 from jsonb_array_elements(p_allocations) z group by z->>'trade_id' having count(*)>1) then
    raise exception 'duplicate allocation trade_id'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('trade_id',trade_id,'amount',amount) order by trade_id),'[]'::jsonb)
    into v_before from village.payment_allocations where receipt_id=p_receipt_id;
  select array_agg(distinct tid order by tid) into v_affected from (
    select trade_id tid from village.payment_allocations where receipt_id=p_receipt_id
    union select value->>'trade_id' from jsonb_array_elements(p_allocations)
  ) q;
  perform 1 from village.payment_accounts where trade_id=any(v_affected) order by trade_id for update;
  for x in select value from jsonb_array_elements(p_allocations) loop
    v_tid:=x->>'trade_id';
    if coalesce(btrim(v_tid),'')='' or coalesce(x->>'amount','') !~ '^[0-9]+$' then raise exception 'invalid allocation'; end if;
    v_amount:=(x->>'amount')::bigint;v_total:=v_total+v_amount;
    select * into a from village.payment_accounts where trade_id=v_tid;
    if not found then raise exception 'unknown account %',v_tid; end if;
    if coalesce(a.contract_status,'') in ('','취소','계약누락') or a.review_required or a.billed_amount is null then raise exception 'account not eligible %',v_tid; end if;
    if v_amount>0 and a.opening_paid>0 and r.occurred_at<=a.baseline_at then
      raise exception 'historical receipt already represented by opening balance %',v_tid; end if;
    select coalesce(sum(pa.amount),0) into v_other from village.payment_allocations pa
      join village.payment_receipts pr on pr.id=pa.receipt_id
      where pa.trade_id=v_tid and pa.receipt_id<>p_receipt_id and pr.status='active';
    if not coalesce(p_allow_overpay,false) and v_amount>0 and a.opening_paid+v_other+v_amount>a.billed_amount then
      raise exception 'allocation exceeds account balance %',v_tid; end if;
  end loop;
  if v_total>r.amount then raise exception 'allocations exceed receipt amount'; end if;
  delete from village.payment_allocations where receipt_id=p_receipt_id;
  insert into village.payment_allocations(receipt_id,trade_id,amount)
    select p_receipt_id,value->>'trade_id',(value->>'amount')::bigint from jsonb_array_elements(p_allocations)
    where (value->>'amount')::bigint>0;
  update village.payment_receipts set revision=revision+1,updated_at=clock_timestamp() where id=p_receipt_id returning * into r;
  update village.payment_accounts set revision=revision+1,updated_at=clock_timestamp() where trade_id=any(v_affected);
  v_result:=jsonb_build_object('success',true,'receiptId',r.id,'revision',r.revision,'allocatedAmount',v_total,
    'remainingAmount',r.amount-v_total,'tradeIds',coalesce(to_jsonb(v_affected),'[]'::jsonb));
  insert into village.payment_events(request_id,event_type,actor,receipt_id,request_payload,before_state,after_state,result,note)
    values(p_request_id,'allocations_replaced',p_actor,r.id,v_payload,v_before,p_allocations,v_result,p_note);
  return v_result;
end $$;

-- Staff-only, explicit reconciliation of a pre-ledger balance. Never inferred from
-- an unmatched receipt, and never folded into subsequent account refresh snapshots.
create or replace function village.payment_set_opening_balance(p_trade_id text,p_opening_paid bigint,
  p_expected_revision bigint,p_request_id text,p_actor text,p_note text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare a village.payment_accounts%rowtype; v_event village.payment_events%rowtype;
  v_payload jsonb; v_result jsonb; v_before jsonb;
begin
  if coalesce(btrim(p_request_id),'')='' or coalesce(btrim(p_actor),'')='' then raise exception 'request_id and actor required'; end if;
  if length(coalesce(btrim(p_note),''))<5 then raise exception 'opening balance reconciliation requires a note of at least 5 characters'; end if;
  if p_opening_paid is null or p_opening_paid<0 then raise exception 'opening_paid must be nonnegative'; end if;
  v_payload:=jsonb_build_object('operation','opening_balance','trade_id',p_trade_id,'opening_paid',p_opening_paid,
    'expected_revision',p_expected_revision,'actor',p_actor,'note',p_note);
  perform pg_advisory_xact_lock(20261020,90000);
  select * into v_event from village.payment_events where request_id=p_request_id;
  if found then
    if v_event.request_payload is distinct from v_payload then raise exception 'request_id payload mismatch'; end if;
    return v_event.result;
  end if;
  select * into a from village.payment_accounts where trade_id=p_trade_id for update;
  if not found then raise exception 'account not found'; end if;
  if p_expected_revision is null or a.revision<>p_expected_revision then raise exception 'account revision conflict'; end if;
  v_before:=to_jsonb(a);
  update village.payment_accounts set opening_paid=p_opening_paid,review_required=false,
    revision=revision+1,updated_at=clock_timestamp() where trade_id=p_trade_id returning * into a;
  v_result:=jsonb_build_object('success',true,'tradeId',a.trade_id,'revision',a.revision,'openingPaid',a.opening_paid);
  insert into village.payment_events(request_id,event_type,actor,trade_id,request_payload,before_state,after_state,result,note)
    values(p_request_id,'opening_balance_reconciled',p_actor,p_trade_id,v_payload,v_before,to_jsonb(a),v_result,p_note);
  return v_result;
end $$;

-- A historical refund may concern money represented only by opening_paid.
-- Preserve that amount until staff reconcile the evidence, but stop auto matching
-- and terminal charging immediately and leave an immutable audit trail.
create or replace function village.payment_require_review(p_trade_id text,p_request_id text,p_note text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare a village.payment_accounts%rowtype; v_event village.payment_events%rowtype;
  v_payload jsonb; v_result jsonb; v_before jsonb;
begin
  if coalesce(btrim(p_request_id),'')='' then raise exception 'request_id required'; end if;
  if length(coalesce(btrim(p_note),''))<5 then raise exception 'review requires a note of at least 5 characters'; end if;
  v_payload:=jsonb_build_object('operation','require_review','trade_id',p_trade_id,'note',p_note);
  perform pg_advisory_xact_lock(20261020,90000);
  select * into v_event from village.payment_events where request_id=p_request_id;
  if found then
    if v_event.request_payload is distinct from v_payload then raise exception 'request_id payload mismatch'; end if;
    return v_event.result;
  end if;
  select * into a from village.payment_accounts where trade_id=p_trade_id for update;
  if not found then raise exception 'account not found'; end if;
  v_before:=to_jsonb(a);
  update village.payment_accounts set review_required=true,revision=revision+1,updated_at=clock_timestamp()
    where trade_id=p_trade_id returning * into a;
  v_result:=jsonb_build_object('success',true,'tradeId',a.trade_id,'revision',a.revision,'reviewRequired',true);
  insert into village.payment_events(request_id,event_type,actor,trade_id,request_payload,before_state,after_state,result,note)
    values(p_request_id,'account_review_required','payment_reconciliation',p_trade_id,v_payload,v_before,to_jsonb(a),v_result,p_note);
  return v_result;
end $$;

alter table village.payment_accounts enable row level security;
alter table village.payment_receipts enable row level security;
alter table village.payment_receipt_aliases enable row level security;
alter table village.payment_allocations enable row level security;
alter table village.payment_events enable row level security;
revoke all on village.payment_accounts,village.payment_receipts,village.payment_receipt_aliases,
  village.payment_allocations,village.payment_events,village.payment_account_balances,village.payment_receipt_balances
  from public,anon,authenticated,service_role;
grant select on village.payment_accounts,village.payment_receipts,village.payment_receipt_aliases,
  village.payment_allocations,village.payment_events,village.payment_account_balances,village.payment_receipt_balances to service_role;
grant update(projected_revision,projection_error) on village.payment_accounts to service_role;
revoke execute on function village.payment_refresh_accounts(jsonb),
  village.payment_ingest_receipt(jsonb,text,text),
  village.payment_set_allocations(uuid,jsonb,bigint,text,text,text,boolean),
  village.payment_set_opening_balance(text,bigint,bigint,text,text,text),
  village.payment_require_review(text,text,text) from public,anon,authenticated;
grant execute on function village.payment_refresh_accounts(jsonb),
  village.payment_ingest_receipt(jsonb,text,text),
  village.payment_set_allocations(uuid,jsonb,bigint,text,text,text,boolean),
  village.payment_set_opening_balance(text,bigint,bigint,text,text,text),
  village.payment_require_review(text,text,text) to service_role;
