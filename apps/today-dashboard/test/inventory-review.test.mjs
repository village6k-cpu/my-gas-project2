import test from 'node:test';import assert from 'node:assert/strict';
const core=await import('../lib/server/inventoryReviewCore.mjs').catch(()=>({}));
const catalog={equipment:[{id:'M1',name:'LVM-170A',category:'17인치 모니터',aliases:[]}],sets:[]};
const source={name:'TVLogic 17인치',kinds:['unknown_equipment'],bookings:[{scheduleId:'s1',tradeId:'t1',name:'TVLogic 17인치',quantity:1}],setNames:['시네마 세트']};
function context(){return {sources:core.prepareInventoryInvestigations([source]),catalog,catalogHash:core.reviewCatalogHash(catalog),ledger:[{equipment_id:'M1',name:'LVM-170A',updated_at:'2026-09-01T00:00:00Z'}]};}
test('AI can link semantically identical equipment even with zero text-search candidates',()=>{
 assert.equal(typeof core.validateInventoryReview,'function');const c=context(),s=c.sources[0];const p={sourceId:s.id,sourceHash:s.sourceHash,catalogHash:c.catalogHash,action:'link_existing',equipmentId:'M1',equipmentName:'LVM-170A',reason:'Brand and 17-inch model identity agree; the request uses the product description.'};
 const result=core.validateInventoryReview(p,c);assert.equal(result.equipmentId,'M1');assert.equal(result.sourceName,source.name);
 for(const changed of [{...p,sourceHash:'old'},{...p,equipmentName:'other'},{...p,stockTotal:99}])assert.throws(()=>core.validateInventoryReview(changed,c));
});
test('generic choices cannot become global aliases and missing components can get concrete owner questions',()=>{
 assert.equal(typeof core.validateInventoryReview,'function');const c=context(),s=c.sources[0];
 const plan={sourceId:s.id,sourceHash:s.sourceHash,catalogHash:c.catalogHash,action:'ask_owner',question:'이 17인치 모니터의 정확한 모델명을 알려주세요.',reason:'The source remains ambiguous after comparing the complete catalog.'};
 assert.equal(core.validateInventoryReview(plan,c).action,'ask_owner');
 c.sources[0].kinds=['model_selection'];const alias={...plan,action:'link_existing',equipmentId:'M1',equipmentName:'LVM-170A'};delete alias.question;assert.throws(()=>core.validateInventoryReview(alias,c),/모델 선택/);
});