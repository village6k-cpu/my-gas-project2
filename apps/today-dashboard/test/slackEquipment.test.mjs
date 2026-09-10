import test from 'node:test';
import assert from 'node:assert/strict';
const core = await import('../lib/server/slackEquipmentCore.mjs').catch(() => ({}));
const catalog = [
  {equipment_id:'CAM-001',name:'소니 FX3 바디(케이지)',aliases:['FX3'],state:'정상'},
  {equipment_id:'CAM-002',name:'소니 FX30 바디',aliases:[],state:'정상'},
];
const text = '이소연 감독님 fx3\n깨진건 아니고 lcd 메인보드가 나간거 같습니다';
test('equipment lookup uses employee text and model token boundaries, without a trade', () => {
  assert.equal(core.lookupEquipment(text,'fx3',catalog).selectedEquipmentId,'CAM-001');
  assert.equal(core.lookupEquipment('FX3 1대 고장','FX3',catalog).selectedEquipmentId,'CAM-001');
  assert.equal(core.lookupEquipment('FX3 LCD 고장','FX3',catalog).selectedEquipmentId,'CAM-001');
  assert.throws(()=>core.lookupEquipment(text,'FX6',catalog), /원문/);
  assert.equal(core.lookupEquipment('소니 파손','소니',catalog).selectedEquipmentId,null);
  assert.equal(core.lookupEquipment('FX3 파손','FX3',[...catalog,{...catalog[0],equipment_id:'CAM-003'}]).selectedEquipmentId,null);
});
test('source qualifiers cannot be removed by quoting a sentence prefix',()=>{
 for(const source of ['FX3 분실 아닙니다.','FX3 분실 의심만 됩니다.','FX3 분실\n아닙니다. 찾았어요.']) {
  assert.throws(()=>core.validateEquipmentReports(source,{messageTs:'1788742182.394589'},[{equipmentId:'CAM-001',query:'FX3',kind:'loss',quote:'FX3 분실'}],catalog),/원문/);
 }
});
test('sheet-only handwriting survives while known old report labels are replaced',()=>{
 const row={note:'원장 메모',open_issues:[{label:'현재 파손'}]};
 assert.equal(core.mergeEquipmentSheetNote('원장 메모 · 과거 파손 · 시트에만 있는 수기',row,['과거 파손']),'원장 메모 · 시트에만 있는 수기');
 assert.equal(core.mergeEquipmentSheetNote('원장 메모 · 현재 파손',row,[]),'원장 메모');
 assert.equal(core.mergeEquipmentSheetNote('메모 포함된 다른 수기',row,[]),'원장 메모 · 메모 포함된 다른 수기');
});
test('records preserve uncertain source wording, reject invented facts and mismatched equipment', () => {
  const event={messageTs:'1788742182.394589'};
  const reports=[{equipmentId:'CAM-001',query:'fx3',kind:'damage',quote:text}];
  const result=core.validateEquipmentReports(text,event,reports,catalog);
  assert.match(result[0].label,/나간거 같습니다/);
  assert.equal(result[0].equipmentId,'CAM-001');
  assert.throws(()=>core.validateEquipmentReports(text,event,[{...reports[0],quote:'FX3 1대 분실 확정'}],catalog),/원문/);
  assert.throws(()=>core.validateEquipmentReports(text,event,[{...reports[0],equipmentId:'CAM-002'}],catalog),/장비/);
  assert.throws(()=>core.validateEquipmentReports(text,event,[...reports,...reports],catalog),/중복/);
  assert.throws(()=>core.validateEquipmentReports(text,event,[{...reports[0],kind:'loss'}],catalog),/분실/);
});
test('report quote must include the selected equipment clue',()=>{
 assert.throws(()=>core.validateEquipmentReports('FX3 확인.\nFX30 파손',{messageTs:'1788742182.394589',sourceMessages:['FX3 확인.','FX30 파손']},[{equipmentId:'CAM-001',query:'FX3',kind:'damage',quote:'FX30 파손'}],catalog),/장비/);
});
