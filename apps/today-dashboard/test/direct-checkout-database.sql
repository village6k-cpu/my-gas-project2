begin;
insert into village.trades(trade_id,customer_name,checkout_at,return_at,contract_status)
values('991230-997','체크 저장 트랜잭션 검증',now(),now()+interval '1 day','예약');
insert into village.schedule_items(schedule_id,trade_id,name,qty,checkout_state,updated_at)
values('991230-997-01','991230-997','픽시스 바디',1,'pending','2026-10-01T00:00:00.123456Z'),
      ('991230-997-02','991230-997','독립 품목',1,'pending','2026-10-01T00:00:00.123457Z');
do $$
declare a jsonb; b jsonb; v text; caught boolean;
begin
  a := village.apply_checkout_item_checks('991230-997','[{"scheduleId":"991230-997-01","done":true,"expectedUpdatedAt":"2026-10-01T00:00:00.123456Z"}]');
  assert a->>'success'='true' and a->'results'->0->>'applied'='true','direct CAS applies';
  v := a->'results'->0->>'updatedAt';
  assert v ~ '\.\d{6}[+]', 'opaque token retains PostgreSQL microseconds';
  a := village.apply_checkout_item_checks('991230-997','[{"scheduleId":"991230-997-01","done":true,"expectedUpdatedAt":"2026-10-01T00:00:00.123456Z"}]');
  assert a->'results'->0->>'ok'='true' and a->'results'->0->>'applied'='false','same-token retry only reads convergence';
  a := village.apply_checkout_item_checks('991230-997',jsonb_build_array(jsonb_build_object('scheduleId','991230-997-01','done',false,'expectedUpdatedAt',v)));
  assert a->'results'->0->>'checked'='false','new deliberate uncheck works';
  b := village.apply_checkout_item_checks('991230-997','[{"scheduleId":"991230-997-01","done":true,"expectedUpdatedAt":"2026-10-01T00:00:00.123456Z"},{"scheduleId":"991230-997-02","done":true,"expectedUpdatedAt":"2026-10-01T00:00:00.123457Z"}]');
  assert b->'results'->0->>'code'='CHECKOUT_CONFLICT' and b->'results'->1->>'applied'='true','stale retry cannot override later uncheck; sibling applies';
  assert (select checkout_state='pending' and qty=1 and name='픽시스 바디' from village.schedule_items where schedule_id='991230-997-01'),'quantity/name preserved';
  update village.schedule_items set removed_at=now() where schedule_id='991230-997-02';
  b := village.apply_checkout_item_checks('991230-997','[{"scheduleId":"991230-997-02","done":true,"expectedUpdatedAt":"2026-10-01T00:00:00.123457Z"}]');
  assert b->'results'->0->>'code'='CHECKOUT_ITEM_UNAVAILABLE','removed item is not resurrected';
  update village.trades set packing_completion_until=now()+interval '1 minute' where trade_id='991230-997';
  a := village.apply_checkout_item_checks('991230-997','[{"scheduleId":"991230-997-01","done":true,"expectedUpdatedAt":"2026-10-01T00:00:00.123456Z"}]');
  assert a->>'code'='BUSY' and a->>'retryable'='true','completion lease respected';
  update village.trades set packing_completion_until=null,contract_status='취소' where trade_id='991230-997';
  a := village.apply_checkout_item_checks('991230-997','[{"scheduleId":"991230-997-01","done":true,"expectedUpdatedAt":"2026-10-01T00:00:00.123456Z"}]');
  assert a->>'code'='TRADE_CLOSED','cancelled trade rejected';
  assert not has_function_privilege('authenticated','village.apply_checkout_item_checks(text,jsonb)','execute'),'no browser RPC grant';
  assert not has_function_privilege('anon','village.apply_checkout_item_checks(text,jsonb)','execute'),'no anonymous RPC grant';
  assert has_function_privilege('service_role','village.apply_checkout_item_checks(text,jsonb)','execute'),'server only';
end $$;
select 'direct item-check CAS checks passed; rolled back' as result;
rollback;
