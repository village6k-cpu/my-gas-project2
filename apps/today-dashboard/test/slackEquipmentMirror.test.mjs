import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../lib/server/inventoryAuditMirrorCore.mjs';
const headers=['구분','장비ID','카테고리','장비명','총보유수량','가용수량','대여중수량','정비중수량','상태','비고'];
const ledger=[{equipment_id:'CAM-001',note:'기존 수기 기록',open_issues:[{label:'FX3 고장 의심'}],updated_at:'2026-09-10T00:00:00Z'}];
function fixture(fail=false) {
 const rows=[['','CAM-001','','FX3',99,98,1,3,'정비중','기존 수기 기록']];
 const writes=[];
 const fetchImpl=async(url,options)=>{
  const b=JSON.parse(options.body);
  if(b.action==='equipmentMasterSync') { writes.push(b); if(!fail) rows[0][9]=b.rows[0].note; return Response.json({success:true,updated:1,appended:0,skipped:[],notePreconditionsChecked:true}); }
  return Response.json({success:true,headers,data:rows,rowCount:1});
 };
 return {rows,writes,fetchImpl};
}
test('notes mirror only writes J; stock/state and manual notes survive; rerun is read only',async()=>{
 const f=fixture(), params={ledger,gasUrl:'https://gas.example/exec',gasKey:'private',fetchImpl:f.fetchImpl};
 const dry=await core.syncEquipmentMasterNotes({...params,dryRun:true});
 assert.equal(dry.updateCount,1); assert.equal(f.writes.length,0);
 await core.syncEquipmentMasterNotes(params);
 assert.deepEqual(Object.keys(f.writes[0].rows[0]).sort(),['expectedNote','id','note']);
 assert.deepEqual(f.writes[0].append,[]);
 assert.deepEqual(f.rows[0].slice(4,9),[99,98,1,3,'정비중']);
 assert.equal(f.rows[0][9],'기존 수기 기록 · FX3 고장 의심');
 await core.syncEquipmentMasterNotes(params); assert.equal(f.writes.length,1);
});
test('success response without matching sheet readback is a failed mirror',async()=>{
 const f=fixture(true);
 await assert.rejects(core.syncEquipmentMasterNotes({ledger,gasUrl:'https://gas.example/exec',gasKey:'private',fetchImpl:f.fetchImpl}),/검증/);
});
