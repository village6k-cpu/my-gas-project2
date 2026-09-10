import test from 'node:test';
import assert from 'node:assert/strict';
import './helpers/tsResolve.mjs';
const {lookupSlackEquipment,recordSlackEquipment,syncSlackEquipmentNotes}=await import('../lib/server/slackEquipment.ts');
process.env.NEXT_PUBLIC_SUPABASE_URL='https://slack-equipment.test';
process.env.SUPABASE_SERVICE_ROLE_KEY='test-only';
process.env.GAS_SYNC_URL='https://gas.test/exec';process.env.VILLAGE_GAS_INTERNAL_KEY='private';
const event={channelId:'C0BMNA501R9',messageTs:'1788742182.394589',sourceHash:'a'.repeat(64)};
const quote='FX3 lcd 메인보드가 나간거 같습니다';
const reports=[{equipmentId:'CAM-001',query:'FX3',kind:'damage',quote}];
const originalFetch=globalThis.fetch;
const headers=['구분','장비ID','카테고리','장비명','총보유수량','가용수량','대여중수량','정비중수량','상태','비고'];
let calls,receipts,issue,gasFails,sheetNote,dbVersion,changeVersion,ledgerNote,extra;
test.beforeEach(()=>{
 calls=[];receipts=[];issue=[];gasFails=false;sheetNote='기존 비고';ledgerNote='기존 비고';extra=false;dbVersion='2026-09-10T00:00:00Z';changeVersion=false;
 globalThis.fetch=async(input,options={})=>{
  const url=new URL(typeof input==='string'?input:input.url||input.href),method=options.method||input.method||'GET';
  const body=options.body?JSON.parse(options.body):null;
  calls.push({url,method,body});
  if(url.hostname==='gas.test') {
    if(gasFails) throw new Error('GAS offline');
    if(body.action==='equipmentMasterSync') {sheetNote=body.rows[0].note; if(changeVersion)dbVersion='2026-09-11T00:00:00Z'; return Response.json({success:true,updated:1,appended:0,skipped:[],notePreconditionsChecked:true});}
    const data=[['','CAM-001','','FX3',6,6,0,0,'정상',sheetNote]];
    if(extra)data.push(['','CAM-002','','FX30',3,3,0,0,'정상','출처 불명 수기']);
    return Response.json({success:true,headers,data,rowCount:data.length});
  }
  const table=url.pathname.split('/').at(-1);let data;
  assert.ok(!['trades','schedule_items'].includes(table),'equipment projection must never replay a trade mutation');
  if(table==='slack_ops_events') {
    assert.equal(url.searchParams.get('channel_id'),'eq.C0BMNA501R9');
    data={source_hash:event.sourceHash,raw_context:{root:{text:quote},replies:[]}};
  } else if(table==='equipment_ledger') {
    data=[{equipment_id:'CAM-001',name:'소니 FX3',aliases:[],note:ledgerNote,open_issues:issue,updated_at:dbVersion}];
    if(extra)data.push({equipment_id:'CAM-002',name:'FX30',note:'원장 메모',open_issues:[],updated_at:dbVersion});
    const filter=url.searchParams.get('equipment_id');if(filter)data=data.filter(row=>filter.includes(row.equipment_id));
  }
  else if(table==='record_slack_equipment_reports') {
    assert.equal(body.p_channel_id,event.channelId);
    issue=body.p_reports.map(r=>({label:r.label}));
    receipts=[{channel_id:event.channelId,message_ts:event.messageTs,equipment_id:'CAM-001',updated_at:dbVersion,synced_at:null}];
    data={ok:true,changedCount:1};
  } else if(table==='slack_equipment_reports') {
    if(method==='PATCH') {assert.equal(url.searchParams.get('updated_at'),'eq.2026-09-10T00:00:00Z');Object.assign(receipts.find(r=>url.searchParams.get('equipment_id')==='eq.'+r.equipment_id),body);data=null;}
    else data=receipts;
  } else throw new Error('unexpected '+table);
  return Response.json(data);
 };
});
test.afterEach(()=>globalThis.fetch=originalFetch);
test('no-trade equipment lookup and dry-run have no writes',async()=>{
 assert.equal((await lookupSlackEquipment(event,'FX3')).selectedEquipmentId,'CAM-001');
 assert.equal((await recordSlackEquipment(event,reports,false,true)).dryRun,true);
 assert.ok(calls.every(c=>c.method==='GET'));
 await assert.rejects(recordSlackEquipment({...event,sourceHash:'b'.repeat(64)},reports,true,true),/바뀌/);
 await assert.rejects(lookupSlackEquipment({...event,channelId:'C_OTHER'},'FX3'),/허용/);
});
test('sheet failure keeps a durable report; next quiet cron repairs only notes',async()=>{
 gasFails=true;
 const result=await recordSlackEquipment(event,reports,true,true);
 assert.equal(result.durable,true); assert.equal(result.mirror.pending,true);
 assert.equal(receipts[0].synced_at,null);
 gasFails=false; calls=[];
 await syncSlackEquipmentNotes();
 assert.match(sheetNote,/기존 비고.*나간거 같습니다/);assert.ok(receipts[0].synced_at);
 assert.ok(calls.every(c=>c.url.pathname.split('/').at(-1)!=='record_slack_equipment_reports'));
 // A later old full-ledger mirror is repaired even after the receipt was acknowledged.
 sheetNote='기존 비고';await syncSlackEquipmentNotes();assert.match(sheetNote,/나간거 같습니다/);
});
test('concurrent ledger change is never marked delivered',async()=>{
 changeVersion=true;
 const result=await recordSlackEquipment(event,reports,true,false);
 assert.equal(result.mirror.pending,true);assert.equal(receipts[0].synced_at,null);
 assert.equal(calls.find(c=>c.url.pathname.endsWith('record_slack_equipment_reports')).body.p_finish,false);
});
test('managed note history prevents a late older full mirror from reviving resolved text',async()=>{
 await recordSlackEquipment(event,reports,true,true);
 ledgerNote='수리 완료';await syncSlackEquipmentNotes();
 assert.ok(!sheetNote.includes('기존 비고'));
 sheetNote='기존 비고 · '+issue[0].label;
 await syncSlackEquipmentNotes();assert.equal(ledgerNote,'수리 완료');assert.ok(!sheetNote.includes('기존 비고'));
});
test('a first-time ambiguous sheet note only defers its own equipment',async()=>{
 await recordSlackEquipment(event,reports,true,true);
 sheetNote='기존 비고';extra=true;
 receipts.push({...receipts[0],equipment_id:'CAM-002',mirrored_segments:null,synced_at:null});
 const result=await syncSlackEquipmentNotes();
 assert.equal(result.ok,false);assert.deepEqual(result.pending.map(p=>p.equipmentId),['CAM-002']);
 assert.match(sheetNote,/나간거 같습니다/);assert.ok(receipts[0].synced_at);assert.equal(receipts[1].synced_at,null);assert.match(receipts[1].last_error,/최초/);
});
