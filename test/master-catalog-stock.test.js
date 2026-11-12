const test=require('node:test'),assert=require('node:assert/strict');
const modulePromise=import('../tools/master-correction/catalog-stock.mjs');
function fixture(){
 const calls=[],source={ownerId:'UOWNER',teamId:'TTEAM',channel:'C123',ts:'1790000001.123456',threadTs:'1790000000.123456',quote:'5,000원',contextQuestion:{ts:'1790000000.123456',text:'verified plan'}};
 const request={kind:'create',correctionId:'mc-12345678901234567890123456789012',target:'New',price:5000,unit:'KRW/day',components:[{name:'New',qty:1}],newEquipment:[{name:'New',major:'기타',category:'기타',stockTotal:2,stockMaintenance:0}],source};
 const dependencies={verify:async r=>{calls.push('verify');return r},preview:async()=>{calls.push('preview');return {success:true,status:'preview',inventory:[{name:'New',matches:[]}]}},confirmation:async()=>null,confirm:async(key,item,evidence)=>{calls.push({key,item,evidence});return {ok:true,equipmentId:'ETC-001'}},mirror:async id=>{calls.push('mirror');return {verified:true,equipmentId:id}}};
 return {request,calls,dependencies};
}
test('new inventory uses verified owner source then preview, existing stock RPC and authoritative mirror',async()=>{
 const {registerCatalogInventory}=await modulePromise,h=fixture();const r=await registerCatalogInventory(h.request,h.dependencies);assert.equal(r.status,'inventory_verified');assert.deepEqual(h.calls.slice(0,2),['verify','preview']);assert.equal(h.calls[2].item.stock_total,2);assert.equal(h.calls[2].item.price,5000);assert.equal(h.calls[3],'mirror');
 const first=h.calls[2];await registerCatalogInventory(h.request,h.dependencies);assert.equal(h.calls[6].key,first.key);assert.deepEqual(h.calls[6].evidence,first.evidence);
});
test('failed source verification prevents all stock and sheet mutations',async()=>{const h=fixture();h.dependencies.verify=async()=>{throw Error('untrusted')};await assert.rejects((await modulePromise).registerCatalogInventory(h.request,h.dependencies),/untrusted/);assert.equal(h.calls.length,0);});
test('catalog collision blocks new stock before the RPC',async()=>{const h=fixture();h.dependencies.preview=async()=>{throw Error('target exists')};await assert.rejects((await modulePromise).registerCatalogInventory(h.request,h.dependencies),/target exists/);assert.deepEqual(h.calls,['verify']);});
test('a failed authoritative mirror is explicit and retains the same durable operation',async()=>{const h=fixture();h.dependencies.mirror=async()=>{throw Error('offline')};const r=await (await modulePromise).registerCatalogInventory(h.request,h.dependencies);assert.equal(r.status,'inventory_saved_catalog_pending');assert.equal(r.retrySameSource,true);assert.equal(r.success,false);assert.equal(r.correctionId,h.request.correctionId);});
test('new component stock does not inherit the whole kit price',async()=>{const h=fixture();h.request.target='Kit';await (await modulePromise).registerCatalogInventory(h.request,h.dependencies);assert.equal(h.calls[2].item.price,null);});
test('existing sheet-only equipment cannot create phantom stock in an empty ledger',async()=>{
 const h=fixture();h.dependencies.preview=async()=>({success:true,status:'preview',inventory:[{name:'New',matches:[{id:'CAM-001',name:'New'}]}]});
 await assert.rejects((await modulePromise).registerCatalogInventory(h.request,h.dependencies),/existing|identity/);assert.deepEqual(h.calls,['verify']);
});
test('an existing sheet identity is allowed only for the same-source saved stock receipt',async()=>{
 const h=fixture();h.dependencies.preview=async()=>({success:true,status:'preview',inventory:[{name:'New',matches:[{id:'ETC-001',name:'New'}]}]});h.dependencies.confirmation=async()=>({equipment_id:'ETC-001'});
 assert.equal((await (await modulePromise).registerCatalogInventory(h.request,h.dependencies)).status,'inventory_verified');
 h.dependencies.confirmation=async()=>({equipment_id:'ETC-999'});await assert.rejects((await modulePromise).registerCatalogInventory(h.request,h.dependencies),/existing|identity/);
});
