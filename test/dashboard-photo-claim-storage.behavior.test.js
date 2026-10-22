'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const crypto=require('node:crypto'),zlib=require('node:zlib');
const now=Date.parse('2026-10-22T18:00:00Z'),prefix='dashboardPhotoUpload_v2_',tid='261023-999';
const fixtureSource=fs.readFileSync(path.join(__dirname,'fixtures/dashboard-photo-upload-v804.js'),'utf8');
const duplicateFields=['tid','phase','fileId','relativePath','thumb','url','uploadedAt','memo','row','recovered'];
function receipt(overrides={}) {
  const phase='checkout',fileId='private-fixture-file';
  const result={success:true,tid,phase,deduped:false,photo:{phase,url:'https://example.invalid/file',thumbnailUrl:'https://example.invalid/thumb',fileId,
    sheetValue:'private/path.jpg',uploadedAt:'2026-10-20 00:00:00',memo:'private evidence',row:2}};
  return {scope:tid+'|'+phase,state:'done',at:now-48*3600000,tid,phase,photoId:'private-photo-id',fileId,relativePath:result.photo.sheetValue,
    thumb:result.photo.thumbnailUrl,url:result.photo.url,uploadedAt:result.photo.uploadedAt,memo:result.photo.memo,row:2,recovered:false,
    retryReady:false,result,unknownFuture:{preserve:['all','evidence']},...overrides};
}
function compact(claim) { const next=JSON.parse(JSON.stringify(claim));duplicateFields.forEach(key=>delete next[key]);return next; }
function old804(claim,{cacheHit=false,wrongScope=false}={}) {
  const events=[],key=prefix+'fixture',values={[key]:JSON.stringify(claim)};
  const props={getProperties:()=>({...values}),getProperty:k=>values[k]??null,
    setProperty(k,value){values[k]=value;events.push(['property-set',JSON.parse(value).state]);},deleteProperty(k){delete values[k];events.push(['property-delete']);}};
  const c={Date:class extends Date {constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}},
    PropertiesService:{getScriptProperties:()=>props},LockService:{getScriptLock:()=>({tryLock:()=>true,releaseLock(){}})},
    CacheService:{getScriptCache:()=>({get:()=>cacheHit?'1':null,put(){}})},Utilities:{base64Decode:()=>[],newBlob:()=>({}),formatDate:()=> '2026-10-23 03:00:00',getUuid:()=> 'new-photo'},
    DriveApp:{Access:{ANYONE_WITH_LINK:'link'},Permission:{VIEW:'view'}},DASHBOARD_PHOTO_APPSHEET_FOLDER_NAME_:'folder',
    normalizeEquipmentCheckTradeId_:value=>value,normalizeDashboardPhotoPhase_:value=>value,
    makeDashboardPhotoId_:()=> 'new-photo',normalizeDashboardUploadData_:()=>({base64:'eA==',mimeType:'image/jpeg'}),makeDashboardPhotoFileName_:()=> 'fixture.jpg',
    getDashboardPhotoSheet_:()=>({getLastRow:()=>1,getLastColumn:()=>8,getRange:()=>({setValues(){events.push(['sheet-append']);}})}),
    getDashboardPhotoSchema_:()=>({tradeIdCol:1,keyCol:2,fileIdCol:3,photoCol:4,phaseCol:5,thumbCol:6,uploadedAtCol:7,memoCol:8,maxCol:8}),
    getDashboardPhotoWriteCol_:()=>4,getDashboardPhotoStorageFolder_:()=>({createFile(){events.push(['drive-create']);return {getId:()=> 'new-file',setSharing(){},setTrashed(){events.push(['drive-trash']);}};}}),
    rememberDashboardPhotoFileIndexEntry_(){},invalidateDashboardPhotoCache_(){},invalidateDashboardCache(){}};
  vm.runInNewContext(fixtureSource,c);
  const result=c.uploadDashboardPhoto(wrongScope?'261023-998':tid,'checkout','fixture.jpg','image/jpeg','eA==','fixture','fixture');
  return {result:JSON.parse(JSON.stringify(result)),events,values};
}
for(const expired of [false,true])for(const cacheHit of [false,true])for(const wrongScope of [false,true])
test('actual804 full/compact result and effects are identical: '+JSON.stringify({expired,cacheHit,wrongScope}),()=>{
  const claim=receipt({at:now-(expired?48*3600000:10*60000)}),a=old804(claim,{cacheHit,wrongScope}),b=old804(compact(claim),{cacheHit,wrongScope});
  assert.deepEqual(b.result,a.result);assert.deepEqual(b.events,a.events);
  if(expired&&!cacheHit) { assert.ok(a.events.some(e=>e[0]==='property-delete'));assert.ok(a.events.some(e=>e[0]==='drive-create'));assert.ok(a.events.some(e=>e[0]==='sheet-append')); }
  else assert.equal(a.events.length,0);
});

function harness(claims={one:receipt()}) {
  const values=Object.fromEntries(Object.entries(claims).map(([key,value])=>[prefix+key,typeof value==='string'?value:JSON.stringify(value)]));
  values.INTERNAL_CREDENTIAL='private-config';const events=[],files=new Map(),flags={};let serial=0,locked=false,sets=0;
  const blob=value=>({getBytes:()=>[...Buffer.from(value)],getDataAsString:()=>Buffer.from(value).toString('utf8')});
  const props={getProperties:()=>({...values}),getProperty(key){if(flags.readFailAfterSet&&sets)throw Error('private read error');return values[key]??null;},
    setProperty(key,value){sets++;events.push(['set',key]);assert.ok(locked);if(flags.beforeSet)flags.beforeSet(key,value,sets);values[key]=value;if(flags.afterSet)flags.afterSet(key,value,sets);},
    deleteProperty(){throw Error('compaction must never delete');}};
  const c={Date:class extends Date {constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}},PropertiesService:{getScriptProperties:()=>props},
    Utilities:{DigestAlgorithm:{SHA_256:'sha256'},Charset:{UTF_8:'utf8'},computeDigest:(_,text)=>[...crypto.createHash('sha256').update(text).digest()],getUuid:()=> 'fixture-'+(++serial),
      newBlob:input=>blob(input),gzip:value=>blob(zlib.gzipSync(Buffer.from(value.getBytes()))),ungzip:value=>blob(zlib.gunzipSync(Buffer.from(value.getBytes())))},
    LockService:{getScriptLock:()=>({tryLock(){if(flags.busy)return false;locked=true;return true;},releaseLock(){locked=false;}})},
    DriveApp:{Access:{PRIVATE:'private'},Permission:{NONE:'none'},createFile(value){events.push(['backup-create']);if(flags.createFail)throw Error('private Drive failure');
      const id='backup-'+(++serial),state={value,access:'private'};const file={getId:()=>id,setSharing(){if(flags.shareFail)throw Error('private ACL');},
        getSharingAccess:()=>flags.publicBackup?'link':state.access,getEditors:()=>[],getViewers:()=>[],getBlob(){events.push(['backup-read']);if(flags.corrupt)return blob('bad gzip');return state.value;},setTrashed(){throw Error('no file deletion');}};
      files.set(id,file);if(flags.duringBackup)flags.duringBackup();return file;},getFileById(id){return files.get(id);}}};
  const module=path.join(__dirname,'../dashboardPhotoClaimStorage.js');if(fs.existsSync(module))vm.runInNewContext(fs.readFileSync(module,'utf8'),c);
  return {c,values,props,events,files,flags,plan:()=>c.compactDashboardPhotoUploadClaims(),execute(hash){return c.compactDashboardPhotoUploadClaims({execute:true,expectedSnapshotHash:hash??this.plan().snapshotHash});}};
}
test('dry run is metadata only, retains expired DONE candidates and computes exact UTF-8 savings',()=>{
  const h=harness(),before={...h.values},plan=h.plan();assert.equal(plan.ok,true);assert.equal(plan.dryRun,true);assert.equal(plan.eligibleCount,1);
  assert.equal(plan.expectedSavedBytes,Buffer.byteLength(before[prefix+'one'])-Buffer.byteLength(JSON.stringify(compact(receipt()))));
  assert.deepEqual(h.values,before);assert.equal(h.events.length,0);assert.match(plan.snapshotHash,/^[a-f0-9]{64}$/);
  for(const secret of ['private-fixture-file','private evidence','private-config',prefix+'one'])assert.ok(!JSON.stringify(plan).includes(secret));
});
test('execution first verifies a private exact raw backup, then only shrinks DONE values preserving result and unknown fields',()=>{
  const h=harness({one:receipt(),pending:receipt({state:'pending'}),file:receipt({state:'file'})}),before={...h.values},result=h.execute();
  assert.equal(result.ok,true);assert.equal(result.compactedCount,1);assert.equal(result.savedBytes,result.expectedSavedBytes);assert.equal(result.backup.verified,true);
  const file=h.files.get(result.backup.fileId),text=zlib.gunzipSync(Buffer.from(file.getBlob().getBytes())).toString('utf8'),payload=JSON.parse(text);
  assert.equal(crypto.createHash('sha256').update(text).digest('hex'),result.backup.payloadHash);assert.equal(payload.records[prefix+'one'],before[prefix+'one']);
  assert.equal(payload.records[prefix+'pending'],before[prefix+'pending']);assert.equal(payload.records.INTERNAL_CREDENTIAL,undefined);
  assert.deepEqual(JSON.parse(h.values[prefix+'one']),compact(receipt()));assert.equal(h.values[prefix+'pending'],before[prefix+'pending']);assert.equal(h.values[prefix+'file'],before[prefix+'file']);
  assert.ok(h.events.findIndex(e=>e[0]==='backup-read')<h.events.findIndex(e=>e[0]==='set'));assert.equal(Object.keys(h.values).length,Object.keys(before).length);
  assert.equal(h.plan().eligibleCount,0);const noOp=h.execute();assert.equal(noOp.compactedCount,0);assert.equal(h.files.size,1);
});
for(const kind of ['pending','file','young','future','missing-time','invalid-time','invalid-json','scope-mismatch','result-invalid','duplicate-mismatch'])test('unsafe or uncertain claim is untouched: '+kind,()=>{
  let claim=receipt();if(['pending','file'].includes(kind))claim.state=kind;
  if(kind==='young')claim.at=now-7*60000+1;if(kind==='future')claim.at=now+1;if(kind==='missing-time')delete claim.at;if(kind==='invalid-time')claim.at='unknown';
  if(kind==='scope-mismatch')claim.scope='other|checkout';if(kind==='result-invalid')claim.result.photo=null;if(kind==='duplicate-mismatch')claim.fileId='different';if(kind==='invalid-json')claim='{broken';
  const h=harness({one:claim}),before={...h.values};assert.equal(h.plan().eligibleCount,0);assert.equal(h.execute().compactedCount,0);assert.deepEqual(h.values,before);assert.equal(h.files.size,0);
});
test('seven-minute boundary is eligible and unequal typed duplicates remain protected',()=>{
  assert.equal(harness({one:receipt({at:now-7*60000})}).plan().eligibleCount,1);
  assert.equal(harness({one:receipt({row:'2'})}).plan().eligibleCount,0);
});
test('unknown JSON keys including __proto__ remain intact after lossless compaction',()=>{
  const claim=JSON.parse(JSON.stringify(receipt()).slice(0,-1)+',"__proto__":{"unknownEvidence":"retain"},"constructor":"retain-constructor"}');
  const h=harness({one:claim});assert.equal(h.execute().ok,true);
  assert.deepEqual(JSON.parse(h.values[prefix+'one']),compact(claim));
});
test('missing or stale snapshot hash and busy lock stop before backup or mutation',()=>{
  const h=harness();assert.equal(h.c.compactDashboardPhotoUploadClaims({execute:true}).ok,false);
  assert.equal(h.execute('wrong').ok,false);h.flags.busy=true;assert.equal(h.execute().ok,false);assert.equal(h.events.length,0);
});
for(const failure of ['createFail','shareFail','publicBackup','corrupt'])test('backup failure prevents every property write and retains any created file reference: '+failure,()=>{
  const h=harness(),before={...h.values};h.flags[failure]=true;const result=h.execute();assert.equal(result.ok,false);assert.deepEqual(h.values,before);
  assert.equal(h.events.filter(e=>e[0]==='set').length,0);assert.ok(!JSON.stringify(result).includes('private Drive failure'));
  assert.equal(result.backup.creationOutcomeUnknown,failure==='createFail');
  if(failure!=='createFail')assert.ok(result.backup.fileId);
});
test('backup preparation failure before createFile does not assert an uncertain Drive write',()=>{
  const h=harness();h.c.Utilities.gzip=()=>{throw Error('preparation failed');};const result=h.execute();
  assert.equal(result.ok,false);assert.equal(result.backup.creationOutcomeUnknown,false);assert.equal(h.events.length,0);
});
test('a well-formed stale snapshot hash stops before backup or mutation',()=>{
  const h=harness(),hash=h.plan().snapshotHash;h.values[prefix+'one']=JSON.stringify(receipt({at:now-49*3600000}));
  const result=h.execute(hash);assert.equal(result.reason,'snapshot_changed');assert.equal(h.events.length,0);
});
test('a changed snapshot while making backup aborts without overwriting newer claims',()=>{
  const h=harness();h.flags.duringBackup=()=>{h.values[prefix+'one']='new concurrent raw';};const result=h.execute();
  assert.equal(result.ok,false);assert.equal(result.backup.verified,true);assert.equal(h.values[prefix+'one'],'new concurrent raw');assert.equal(h.events.filter(e=>e[0]==='set').length,0);
});
test('per-key CAS stops if a claim changes after the complete snapshot readback',()=>{
  const h=harness(),getProperty=h.props.getProperty;
  h.props.getProperty=key=>{h.values[key]='new exact-key raw';return getProperty(key);};
  const result=h.execute();assert.equal(result.reason,'claim_changed');assert.equal(result.backup.verified,true);
  assert.equal(h.values[prefix+'one'],'new exact-key raw');assert.equal(h.events.filter(e=>e[0]==='set').length,0);
});
test('partial failure returns verified backup metadata and never retries or rolls back a confirmed shrink',()=>{
  const h=harness({one:receipt(),two:receipt()}),before={...h.values};h.flags.beforeSet=(_key,_value,n)=>{if(n===2)throw Error('quota with private detail');};
  const result=h.execute();assert.equal(result.ok,false);assert.equal(result.compactedCount,1);assert.equal(result.backup.verified,true);
  assert.notEqual(h.values[prefix+'one'],before[prefix+'one']);assert.equal(h.values[prefix+'two'],before[prefix+'two']);assert.equal(h.events.filter(e=>e[0]==='set').length,2);
  assert.ok(!JSON.stringify(result).includes('private detail'));
});
test('ambiguous successful writes use exact readback without a second set',()=>{
  const h=harness();h.flags.afterSet=()=>{throw Error('response lost');};const result=h.execute();assert.equal(result.ok,true);assert.equal(result.compactedCount,1);assert.equal(h.events.filter(e=>e[0]==='set').length,1);
});
test('unavailable post-write readback reports uncertainty with backup and stops further mutation',()=>{
  const h=harness({one:receipt(),two:receipt()});h.flags.readFailAfterSet=true;const result=h.execute();
  assert.equal(result.ok,false);assert.equal(result.outcomeUnknown,true);assert.equal(result.backup.verified,true);assert.equal(h.events.filter(e=>e[0]==='set').length,1);
});
test('internal run forwards compaction arguments while public catalog credential cannot call it',()=>{
  const h=harness();vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../sheetAPI.js'),'utf8'),h.c);
  const result=h.c.runFunction('compactDashboardPhotoUploadClaims',{args:[{execute:false}]});assert.equal(result.success,true);assert.equal(result.result.dryRun,true);
  h.c.jsonResponse=(body,status)=>({body,status});const denied=h.c.handleRequestCore_({parameter:{},postData:{contents:JSON.stringify({key:'village2026',action:'run',func:'compactDashboardPhotoUploadClaims',args:[{execute:true}]})}});
  assert.equal(denied.status,403);assert.equal(h.events.length,0);
});
