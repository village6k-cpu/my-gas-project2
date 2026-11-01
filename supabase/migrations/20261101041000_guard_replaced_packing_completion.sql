-- Reject stale device composition before the GAS completion mutation begins.
CREATE OR REPLACE FUNCTION village.lock_packing_completion(p_trade_id text, p_kind text, p_done boolean, p_token text)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare t village.trades;
begin
  select * into strict t from village.trades where trade_id=p_trade_id for update;
  if t.packing_manifest is null then return false; end if;
  if t.packing_completion_until>now() and t.packing_completion_token is distinct from p_token then
    raise exception '다른 완료 처리가 진행 중입니다' using errcode='55P03';
  end if;
  if p_done and t.packing_manifest->>'phase' <> 'sealed' then raise exception '구성품 준비를 먼저 확정해주세요'; end if;
  if p_done and p_kind='return' and exists (
    select 1 from jsonb_array_elements(t.packing_manifest->'sources') s
    join village.schedule_items i on i.trade_id=p_trade_id and i.schedule_id=s->>'id'
    where s->>'device'='true' and i.removed_at is null and i.checkout_state<>'excluded'
      and (s->>'name'<>coalesce(nullif(i.actual_name,''),i.name) or (s->>'qty')::integer<>i.qty)
  ) then raise exception '교체 장비의 구성품 반출 확인을 먼저 완료해주세요'; end if;
  if p_done and p_kind='return' and not village.packing_return_complete(t.packing_manifest) then
    raise exception '구성품 미반납 수량이 남아 있습니다';
  end if;
  update village.trades set packing_completion_token=p_token, packing_completion_until=now()+interval '120 seconds' where trade_id=p_trade_id;
  return true;
end $function$
;
