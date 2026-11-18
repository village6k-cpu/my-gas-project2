-- Transactional test for the same service RPC called by the staff checkout page.
begin;
insert into village.trades(trade_id,customer_name,checkout_at,return_at,contract_status)
values('991231-985','부분 반출 구성품 검증',now(),now()+interval '1 day','예약');
insert into village.schedule_items(schedule_id,trade_id,name,qty,checkout_state)
values('991231-985-01','991231-985','장비 A',1,'pending'),
      ('991231-985-02','991231-985','장비 B',2,'pending');
do $test$
declare
  tid text := '991231-985'; actor uuid := '00000000-0000-0000-0000-000000000001';
  p jsonb := '{"version":1,"schemaVersion":2,"phase":"draft","sources":[{"id":"991231-985-01","name":"장비 A","qty":1,"device":true},{"id":"991231-985-02","name":"장비 B","qty":2,"device":true}],"entries":[{"id":"a","ownerId":"991231-985-01","name":"선 A","partId":"a","qty":1,"checked":false},{"id":"b","ownerId":"991231-985-02","name":"선 B","partId":"b","qty":2,"checked":false}],"counts":{},"note":""}';
  next jsonb; rejected boolean;
begin
  perform village.save_packing_manifest(tid,0,p,actor,'start');
  update village.schedule_items set taken_qty=1,checkout_state='taken' where schedule_id=tid||'-01';
  p := jsonb_set(jsonb_set(p,'{entries,1,checked}','true'),'{version}','2');
  perform village.save_packing_manifest(tid,1,p,actor,'save');
  rejected:=false;
  begin
    next:=jsonb_set(jsonb_set(p,'{entries,0,qty}','0'),'{version}','3');
    perform village.save_packing_manifest(tid,2,next,actor,'save');
  exception when others then rejected:=sqlerrm like '%검수한 구성품%'; end;
  assert rejected, 'cannot overwrite a picked part';
  rejected:=false;
  begin
    next:=jsonb_set(jsonb_set(p,'{counts}','{"a":{"good":1,"lost":0,"damaged":0}}'),'{version}','3');
    perform village.save_packing_manifest(tid,2,next,actor,'save');
  exception when others then rejected:=sqlerrm like '%검수 수량%'; end;
  assert rejected, 'draft save cannot write return quantities';
  p:=jsonb_set(jsonb_set(p,'{entries,0,checked}','true'),'{version}','3');
  perform village.save_packing_manifest(tid,2,p,actor,'save');
  p:=p||'{"version":4,"phase":"sealed"}';
  perform village.save_packing_manifest(tid,3,p,actor,'seal');
  assert (select taken_qty=1 from village.schedule_items where schedule_id=tid||'-01'), 'physical count survives';
  rejected:=false;
  begin
    perform village.save_packing_manifest(tid,4,p||'{"version":5,"phase":"draft"}',actor,'revise');
  exception when others then rejected:=sqlerrm like '%이미 반출%'; end;
  assert rejected, 'sealed partial pickup stays immutable';
end $test$;
rollback;
