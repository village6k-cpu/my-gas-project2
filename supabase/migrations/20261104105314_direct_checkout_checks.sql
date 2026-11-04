-- Staff item checks use the canonical row token, not the capacity-limited GAS cache.
-- No business/quantity fields are rewritten and stale retries never acquire a fresh token.
create or replace function village.apply_checkout_item_checks(p_trade_id text, p_items jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  t village.trades;
  i village.schedule_items;
  entry jsonb;
  sid text;
  expected_at timestamptz;
  target_state text;
  applied boolean;
  matched boolean;
  results jsonb := '[]';
begin
  if p_trade_id !~ '^\d{6}-\d{3}$' or jsonb_typeof(p_items) is distinct from 'array'
    or jsonb_array_length(p_items) not between 1 and 100 then raise exception 'invalid checkout items'; end if;
  -- Validate the whole request before accepting any item.
  for entry in select value from jsonb_array_elements(p_items) loop
    if entry->>'scheduleId' is null or entry->>'scheduleId' not like p_trade_id || '-%'
      or jsonb_typeof(entry->'done') is distinct from 'boolean'
      or entry->>'expectedUpdatedAt' is null then raise exception 'invalid checkout item'; end if;
    expected_at := (entry->>'expectedUpdatedAt')::timestamptz;
  end loop;
  if (select count(*) <> count(distinct value->>'scheduleId') from jsonb_array_elements(p_items)) then
    raise exception 'duplicate checkout item';
  end if;
  -- Same lock ordering as completion authority: trade, then item.
  select * into t from village.trades where trade_id=p_trade_id for update;
  if not found then raise exception 'trade not found'; end if;
  if t.packing_completion_until > now() then
    return jsonb_build_object('error','반출·반납 완료를 저장 중입니다','code','BUSY','retryable',true);
  end if;
  if t.return_done or t.contract_status in ('취소','반납완료') then
    return jsonb_build_object('error','마감·취소 거래입니다','code','TRADE_CLOSED','retryable',false);
  end if;
  for entry in select value from jsonb_array_elements(p_items) loop
    sid := entry->>'scheduleId';
    expected_at := (entry->>'expectedUpdatedAt')::timestamptz;
    target_state := case when (entry->>'done')::boolean then 'taken' else 'pending' end;
    applied := false;
    select * into i from village.schedule_items where trade_id=p_trade_id and schedule_id=sid for update;
    if not found or i.removed_at is not null or i.checkout_state='excluded' then
      results := results || jsonb_build_array(jsonb_build_object('scheduleId',sid,'ok',false,'applied',false,
        'outcomeUnknown',false,'code','CHECKOUT_ITEM_UNAVAILABLE','error','품목이 삭제 또는 제외되었습니다. 새로고침해주세요.'));
      continue;
    end if;
    if i.updated_at=expected_at then
      update village.schedule_items set checkout_state=target_state where trade_id=p_trade_id and schedule_id=sid returning * into i;
      applied := true;
    end if;
    matched := i.checkout_state=target_state;
    results := results || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
      'scheduleId',sid,'ok',matched,'applied',applied,'checked',case when matched then target_state='taken' end,
      'updatedAt',to_jsonb(i)->>'updated_at','canonicalState',i.checkout_state,'outcomeUnknown',false,
      'deduped',matched and not applied,'code',case when not matched then 'CHECKOUT_CONFLICT' end,
      'error',case when not matched then '다른 변경이 먼저 저장되었습니다. 현재 상태를 확인 후 다시 선택해주세요.' end)));
  end loop;
  return jsonb_build_object('success',not exists(select 1 from jsonb_array_elements(results) r where r->>'ok'<>'true'),
    'tradeId',p_trade_id,'results',results);
end;
$$;
revoke all on function village.apply_checkout_item_checks(text,jsonb) from public,anon,authenticated;
grant execute on function village.apply_checkout_item_checks(text,jsonb) to service_role;
