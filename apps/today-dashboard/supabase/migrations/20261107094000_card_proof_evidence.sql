-- The ledger's non-bank category also contains barcode receipts. Use the
-- signed payment method to decide whether a trade qualifies for card proof.
create or replace function village.payment_card_proof_evidence(p_trade_ids text[])
returns table(trade_id text, revision bigint, proof_state text)
language sql stable security definer set search_path = '' as $$
  with receipts as (
    select a.trade_id, b.revision, r.id, r.source_id, r.approval_number, r.amount,
      r.occurred_at, r.merchant_id, r.review_reason
    from village.payment_allocations a
    join village.payment_accounts b on b.trade_id = a.trade_id
    join village.payment_receipts r on r.id = a.receipt_id
    where a.trade_id = any(p_trade_ids) and a.amount > 0
      and r.status = 'active' and r.source in ('front', 'toss')
  ), events as materialized (
    select p->>'id' as payment_id, p->>'approvedNo' as approval_number,
      p->>'amount' as amount, p->>'merchantId' as merchant_id,
      p->>'paymentMethod' as method, p->>'state' as state, w.event_type,
      case when pg_input_is_valid(p->>'approvedAt', 'timestamp with time zone')
        then (p->>'approvedAt')::timestamptz end as approved_at
    from finance.toss_webhook_inbox w
    cross join lateral (select w.payload#>'{data,payment}' as p) data
    where w.signature_ok and w.event_type in ('payment.payment.approved.v1', 'payment.payment.cancelled.v1')
      and nullif(p->>'id', '') is not null
  ), classified as (
    select r.trade_id, r.revision, case
      when r.review_reason is not null or count(distinct e.payment_id) <> 1
        or count(distinct e.method) <> 1
        or bool_or(e.event_type = 'payment.payment.cancelled.v1')
        or not bool_or(e.state = 'APPROVED' and e.event_type = 'payment.payment.approved.v1')
        then 'pending'
      when min(e.method) = 'CARD' then 'verified_card'
      else 'non_card'
    end as proof_state
    from receipts r
    left join events e on e.amount = r.amount::text
      and (r.merchant_id is null or e.merchant_id is null or e.merchant_id = r.merchant_id)
      and (e.payment_id = r.source_id or exists (
        select 1 from village.payment_receipt_aliases a
        where a.receipt_id = r.id and a.source = 'toss' and a.source_id = e.payment_id
      ) or (e.approval_number = nullif(r.approval_number, '')
        and abs(extract(epoch from e.approved_at - r.occurred_at)) <= 120))
    group by r.trade_id, r.revision, r.id, r.review_reason
  )
  select c.trade_id, c.revision, case
    when bool_or(c.proof_state = 'verified_card') then 'verified_card'
    when bool_or(c.proof_state = 'pending') then 'pending'
    else 'non_card'
  end
  from classified c
  group by c.trade_id, c.revision;
$$;
revoke all on function village.payment_card_proof_evidence(text[]) from public, anon, authenticated;
grant execute on function village.payment_card_proof_evidence(text[]) to service_role;
