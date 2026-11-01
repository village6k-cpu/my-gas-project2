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

-- Replacement facts are versioned, scoped to one owner and physically confirmed after dispatch.
begin;
insert into village.trades(trade_id,customer_name,checkout_at,return_at,contract_status)
values('991231-996','장비교체 트랜잭션 검증',now(),now()+interval '1 day','예약');
insert into village.schedule_items(schedule_id,trade_id,name,qty,set_name,is_set_header,checkout_state)
values('991231-996-1','991231-996','어퓨쳐 스톰 300C',1,'어퓨쳐 스톰 300C',true,'pending'),
('991231-996-2','991231-996','다른 조명',1,'다른 조명',true,'pending');
do $$
declare p jsonb; n jsonb; caught boolean; dispatched timestamptz; actor uuid := '00000000-0000-0000-0000-000000000001';
begin
 p := '{"version":1,"schemaVersion":2,"phase":"draft","sources":[{"id":"991231-996-1","name":"어퓨쳐 스톰 300C","qty":1,"device":true},{"id":"991231-996-2","name":"다른 조명","qty":1,"device":true}],"entries":[{"id":"other","ownerId":"991231-996-2","device":"다른 조명","name":"다른 AC라인","partId":"other-ac","qty":1,"checked":true}],"counts":{},"note":"기존 인계 메모"}';
 perform village.save_packing_manifest('991231-996',0,p,actor,'start');
 update village.schedule_items set name='아마란 300C',set_name='아마란 300C' where schedule_id='991231-996-1';
 n := jsonb_set(p,'{sources,0,name}','"아마란 300C"') || jsonb_build_object('version',2,'entries',(p->'entries')||'[{"id":"new-ac","ownerId":"991231-996-1","device":"아마란 300C","name":"아마란 300C용 AC라인","partId":"amaran-ac","qty":1,"checked":false}]'::jsonb);
 perform village.save_packing_manifest('991231-996',1,n,actor,'reconcile');
 assert (select packing_manifest->'entries'->1->>'checked'='false' from village.trades where trade_id='991231-996'), 'new accessory must need preparation';
 p:=jsonb_set(n,'{entries,1,checked}','true')||'{"version":3,"phase":"sealed"}';
 perform village.save_packing_manifest('991231-996',2,p,actor,'seal');
 update village.trades set setup_done=true where trade_id='991231-996';
 select packing_dispatched_at into dispatched from village.trades where trade_id='991231-996';
 update village.schedule_items set name='아마란 F21C',set_name='아마란 F21C' where schedule_id='991231-996-1';
 caught:=false;
 begin update village.trades set return_done=true where trade_id='991231-996'; exception when others then caught:=sqlerrm like '%교체 장비%'; end;
 assert caught,'stale replacement must not close return against old baseline';
 n := jsonb_set(p,'{sources,0,name}','"아마란 F21C"') || jsonb_build_object('version',4,'entries',jsonb_set(jsonb_set(p->'entries','{1,qty}','0'),'{1,checked}','false')||'[{"id":"new-clamp","ownerId":"991231-996-1","device":"아마란 F21C","name":"아마란 F21C용 ㄱ자 클램프","partId":"clamp","qty":1,"checked":true}]'::jsonb);
 caught:=false;
 begin perform village.save_packing_manifest('991231-996',3,n,actor,'reconcile'); exception when others then caught:=true; end;
 assert caught,'dispatched replacement cannot be automated';
 caught:=false;
 begin perform village.save_packing_manifest('991231-996',3,jsonb_set(n,'{entries,0,checked}','false'),actor,'reconcileConfirmed'); exception when others then caught:=true; end;
 assert caught,'another owner must remain unchanged';
 caught:=false;
 begin perform village.save_packing_manifest('991231-996',3,jsonb_set(n,'{sources,0,name}','"오래된 장비명"'),actor,'reconcileConfirmed'); exception when serialization_failure then caught:=true; end;
 assert caught,'concurrent name change must be rejected';
 perform village.save_packing_manifest('991231-996',3,n,actor,'reconcileConfirmed');
 assert (select setup_done and packing_dispatched_at=dispatched and packing_manifest->>'note'='기존 인계 메모' from village.trades where trade_id='991231-996'),'original completion, dispatch time and memo must persist';
 assert (select action='reconcileConfirmed' from village.packing_audit where trade_id='991231-996' and version=4),'physical confirmation audit';
 assert (select count(*)=4 from village.packing_audit where trade_id='991231-996'),'old snapshots must survive';
end $$;
select 'replacement transaction checks passed; rolled back' as result;
rollback;
