-- Run against the target schema in a transaction; no fixture or audit rows survive.
begin;
insert into village.trades(trade_id,customer_name,checkout_at,return_at,contract_status)
values('991231-997','구성품 트랜잭션 검증',now(),now()+interval '1 day','예약');
insert into village.schedule_items(schedule_id,trade_id,name,qty,set_name,is_component,checkout_state)
values('991231-997-1','991231-997','스몰HD용 SDI 연선',1,'스몰HD',true,'pending');
do $$
declare p jsonb; caught boolean; actual jsonb; actor uuid := '00000000-0000-0000-0000-000000000001';
begin
 p := '{"version":1,"phase":"draft","sources":[{"id":"991231-997-1","name":"스몰HD용 SDI 연선","qty":1}],"entries":[{"id":"a","device":"스몰HD","name":"SDI 연선","partId":"CBL-003","qty":1,"checked":true},{"id":"b","device":"테라덱","name":"SDI 연선","partId":"CBL-003","qty":2,"checked":true}],"counts":{},"note":""}';
 perform village.save_packing_manifest('991231-997',0,p,actor,'start');
 caught:=false;
 begin perform village.save_packing_manifest('991231-997',0,p,actor,'save'); exception when serialization_failure then caught:=true; end;
 assert caught, 'stale version must fail';
 caught:=false;
 begin update village.trades set setup_done=true where trade_id='991231-997'; exception when others then caught:=true; end;
 assert caught, 'draft must block checkout';
 p := p || '{"version":2,"phase":"sealed","sealedAt":"2026-10-28T12:00:00Z"}';
 perform village.save_packing_manifest('991231-997',1,p,actor,'seal');
 perform village.lock_packing_completion('991231-997','setup',true,'same-request');
 perform village.lock_packing_completion('991231-997','setup',true,'same-request');
 caught:=false;
 begin perform village.lock_packing_completion('991231-997','setup',true,'different-request'); exception when lock_not_available then caught:=true; end;
 assert caught, 'different completion must get retryable lock error';
 update village.trades set setup_done=true,packing_completion_token=null,packing_completion_until=null where trade_id='991231-997';
 assert (select packing_dispatched_at is not null from village.trades where trade_id='991231-997'), 'dispatch history must persist';
 update village.trades set setup_done=false where trade_id='991231-997';
 caught:=false;
 begin perform village.save_packing_manifest('991231-997',2,p||'{"version":3,"phase":"draft"}',actor,'revise'); exception when others then caught:=true; end;
 assert caught, 'undo checkout must not unlock snapshot';
 p:=p||'{"version":3,"counts":{"CBL-003":{"good":2,"damaged":0,"lost":0}}}';
 perform village.save_packing_manifest('991231-997',2,p,actor,'receive');
 select packing_manifest into actual from village.trades where trade_id='991231-997';
 assert actual->'counts'->'CBL-003'->>'good'='2', 'partial return readback';
 assert not village.packing_return_complete(actual), '2 of 3 must remain incomplete';
 caught:=false;
 begin perform village.lock_packing_completion('991231-997','return',true,'return-request'); exception when others then caught:=true; end;
 assert caught, 'incomplete return cannot reach GAS';
 caught:=false;
 begin update village.trades set return_done=true,contract_status='반납완료' where trade_id='991231-997'; exception when others then caught:=true; end;
 assert caught, 'direct completion must also fail';
 p:=p||'{"version":4,"counts":{"CBL-003":{"good":3,"damaged":0,"lost":0}}}';
 perform village.save_packing_manifest('991231-997',3,p,actor,'receive');
 perform village.lock_packing_completion('991231-997','return',true,'return-request');
 update village.trades set return_done=true,contract_status='반납완료' where trade_id='991231-997';
 assert (select count(*)=4 from village.packing_audit where trade_id='991231-997'), 'audit versions';
 assert (select qty=1 and name='스몰HD용 SDI 연선' from village.schedule_items where schedule_id='991231-997-1'), 'source must remain unchanged';
 assert not has_function_privilege('authenticated','village.save_packing_manifest(text,integer,jsonb,uuid,text)','execute'), 'RPC must be service-only';
end $$;
select 'packing transaction checks passed; rolled back' as result;
rollback;
