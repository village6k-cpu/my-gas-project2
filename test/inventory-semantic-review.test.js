const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),crypto=require('node:crypto');
function env(){const props={},c={Utilities:{DigestAlgorithm:{SHA_256:'sha256'},Charset:{UTF_8:'utf8'},computeDigest:(_a,s)=>[...crypto.createHash('sha256').update(s).digest()]},PropertiesService:{getScriptProperties:()=>({getProperties:()=>({...props}),getProperty:k=>props[k]??null,setProperty:(k,v)=>props[k]=v})},LockService:{getScriptLock:()=>({tryLock:()=>true,releaseLock(){}})}};vm.createContext(c);for(const f of ['inventoryRisk.js','inventoryRiskMonitor.js','inventorySemanticReview.js'])if(fs.existsSync(__dirname+'/../'+f))vm.runInContext(fs.readFileSync(__dirname+'/../'+f,'utf8'),c);return c;}
const snapshot=()=>({equipment:[{id:'M1',name:'Field monitor',stock:1,maintenance:0}],sets:[{name:'Camera kit',components:[{name:'Monitor and mounting kit',quantity:1,note:'Keep handwritten note',tracked:true}]}],schedules:[],sourceIssues:[]});
test('AI may identify packing contents without a name rule or an owner stock question',()=>{
 const c=env(),s=snapshot();assert.equal(typeof c.inventorySemanticScopes_,'function');const scope=c.inventorySemanticScopes_(s)[0];
 c.readInventoryRiskSnapshot_=()=>s;const p={reason:'The set manifest describes included mounting accessories.',resolutions:[{...scope,disposition:'included',allocations:[]}]};
 const result=c.applyInventorySemanticReview(p);assert.equal(result.verified,true);const fresh=snapshot();c.inventoryApplySemanticReviews_(fresh);assert.equal(fresh.sets[0].components[0].tracked,false);assert.equal(fresh.sets[0].components[0].note,'Keep handwritten note');
 const changed=snapshot();changed.sets[0].components[0].quantity=2;c.inventoryApplySemanticReviews_(changed);assert.equal(changed.sets[0].components[0].tracked,true);
});
test('context-specific AI stock allocations preserve a real shortage and never become global aliases',()=>{
 const c=env(),s=snapshot();assert.equal(typeof c.inventorySemanticScopes_,'function');c.readInventoryRiskSnapshot_=()=>s;const scope=c.inventorySemanticScopes_(s)[0];
 c.applyInventorySemanticReview({reason:'The requested kit monitor is this actual stock item.',resolutions:[{...scope,disposition:'stock',allocations:[{equipmentId:'M1',equipmentName:'Field monitor',quantity:1}]}]});
 c.inventoryApplySemanticReviews_(s);assert.equal(s.equipment[0].aliases,undefined);
 s.schedules=[{id:'a',tradeId:'a',setName:'Camera kit',name:'Monitor and mounting kit',quantity:2,start:'2099-01-01T00:00:00Z',end:'2099-01-02T00:00:00Z'}];
 const r=c.buildInventoryRiskReport_(s,{now:'2098-12-31T00:00:00Z'});assert.equal(r.alerts.find(a=>a.kind==='shortage')?.shortage,1);
});
test('stale evidence and nonexistent targets cannot suppress a demand',()=>{
 const c=env(),s=snapshot();assert.equal(typeof c.inventorySemanticScopes_,'function');c.readInventoryRiskSnapshot_=()=>s;const scope=c.inventorySemanticScopes_(s)[0];
 for(const r of [{...scope,sourceHash:'stale',disposition:'included',allocations:[]},{...scope,disposition:'stock',allocations:[{equipmentId:'missing',equipmentName:'invented',quantity:1}]}])assert.throws(()=>c.applyInventorySemanticReview({reason:'source evidence',resolutions:[r]}));
});

test('identical repeated set rows accept one semantic decision without changing the sheet',()=>{
 const c=env(),s=snapshot();s.sets[0].components.push({...s.sets[0].components[0]});c.readInventoryRiskSnapshot_=()=>s;
 assert.equal(c.inventorySemanticScopes_(s).length,1);const scope=c.inventorySemanticScopes_(s)[0];
 c.applyInventorySemanticReview({reason:'Same original manifest appears twice.',resolutions:[{...scope,disposition:'included',allocations:[]}]});
 c.inventoryApplySemanticReviews_(s);assert.ok(s.sets[0].components.every(x=>x.tracked===false));
});
test('a stocked kit occupies its main physical item even with a separately tracked stand',()=>{
 const c=env(),s={equipment:[{id:'L1',name:'Light',stock:1,maintenance:0},{id:'S1',name:'Stand',stock:10,maintenance:0}],sets:[{name:'Light',components:[{name:'head and cable',quantity:1,tracked:false},{name:'Stand',quantity:1,tracked:true}]}],schedules:[]};
 for(const [id,name]of [['a','Light'],['b','head and cable'],['c','Stand']])s.schedules.push({id,tradeId:'t',name,setName:'Light',quantity:2,start:'2099-01-01T00:00:00Z',end:'2099-01-02T00:00:00Z'});
 const r=c.buildInventoryRiskReport_(s,{now:'2098-12-31T00:00:00Z'});assert.equal(r.alerts.find(a=>a.kind==='shortage'&&a.equipmentId==='L1')?.shortage,1);
});

test('physical IDs in semantic splits do not double-count a stocked header and tolerate display spaces',()=>{
 const c=env(),s={equipment:[{id:'L1',name:'Light kit',stock:1,maintenance:0},{id:'S1',name:'Stand',stock:1,maintenance:0}],sets:[{name:'Light kit',components:[{name:'Light and stand',quantity:1,tracked:true,allocations:[{equipmentId:'L1',equipmentName:'Light kit',quantity:1},{equipmentId:'S1',equipmentName:'Stand',quantity:1}]}]}],schedules:[]};
 for(const [id,name]of [['a','Light kit'],['b',' Light and stand ']])s.schedules.push({id,tradeId:'t',name,setName:'Light kit',quantity:1,start:'2099-01-01T00:00:00Z',end:'2099-01-02T00:00:00Z'});
 const r=c.buildInventoryRiskReport_(s,{now:'2098-12-31T00:00:00Z'});assert.equal(r.alerts.filter(a=>a.kind==='shortage'||a.kind==='unknown_equipment').length,0);
});

test('AI can classify a booking component absent from the master without adding it to other bookings',()=>{
 const c=env(),s=snapshot();s.schedules=[{id:'s1',setName:'Camera kit',name:'included spare pack',quantity:3,end:'2099-01-01T00:00:00Z'}];c.inventoryApplySemanticReviews_(s);
 const scope=s.semanticScopes.find(x=>x.componentName==='included spare pack');assert.ok(scope);c.readInventoryRiskSnapshot_=()=>s;
 c.applyInventorySemanticReview({reason:'Original booking lists a spare battery pack under the kit; inventory policy excludes batteries.',resolutions:[{...scope,disposition:'included',allocations:[]}]});
 c.inventoryApplySemanticReviews_(s);assert.equal(s.sets[0].components.find(x=>x.name==='included spare pack').tracked,false);
});

test('another standalone item in the same trade cannot erase a stocked kit header',()=>{
 const c=env(),s={equipment:[{id:'L1',name:'Light',aliases:['Light head'],stock:1,maintenance:0}],sets:[{name:'Light',components:[{name:'packing',quantity:1,tracked:false}]}],schedules:[]};
 for(const [id,name,setName]of [['a','Light','Light'],['b','packing','Light'],['c','Light head','']])s.schedules.push({id,tradeId:'t',name,setName,quantity:1,start:'2099-01-01T00:00:00Z',end:'2099-01-02T00:00:00Z'});
 const r=c.buildInventoryRiskReport_(s,{now:'2098-12-31T00:00:00Z'});assert.equal(r.alerts.find(a=>a.kind==='shortage')?.shortage,1);
});

test('a catalog bundle with no manifest can be allocated to existing physical parts by AI',()=>{
 const c=env(),s=snapshot();s.sets=[{name:'monitor bundle',price:20000,components:[]}];c.inventoryApplySemanticReviews_(s);const scope=s.semanticScopes.find(x=>x.componentName==='monitor bundle');assert.ok(scope);c.readInventoryRiskSnapshot_=()=>s;
 c.applyInventorySemanticReview({reason:'The sales bundle consists of one existing monitor.',resolutions:[{...scope,disposition:'stock',allocations:[{equipmentId:'M1',equipmentName:'Field monitor',quantity:1}]}]});c.inventoryApplySemanticReviews_(s);
 s.schedules=[{id:'s',tradeId:'t',setName:'monitor bundle',name:'monitor bundle',quantity:2,start:'2099-01-01T00:00:00Z',end:'2099-01-02T00:00:00Z'}];assert.equal(c.buildInventoryRiskReport_(s,{now:'2098-12-31T00:00:00Z'}).alerts.find(a=>a.kind==='shortage')?.shortage,1);
});
test('unknown physical kit remains an AI investigation when its packing contents are included',()=>{
 const c=env(),s={equipment:[],sets:[{name:'new speaker',components:[{name:'included mics',quantity:1,tracked:false}]}],schedules:[{id:'a',tradeId:'t',setName:'new speaker',name:'new speaker',quantity:1,start:'2099-01-01T00:00:00Z',end:'2099-01-02T00:00:00Z'}]};assert.ok(c.buildInventoryRiskReport_(s,{now:'2098-12-31T00:00:00Z'}).alerts.some(a=>a.kind==='catalog_stock_missing'&&a.equipment==='new speaker'));
});
