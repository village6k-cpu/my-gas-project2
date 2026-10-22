/** The AI decides what a set component means; code checks evidence and applies arithmetic. */
var INVENTORY_SEMANTIC_PREFIX_='inventorySemantic_v1_';
function inventorySemanticScopes_(snapshot) {
 var scopes=[];
 (snapshot.sets || []).forEach(function(set){(set.components || []).forEach(function(c){
  var raw={setName:set.name,componentName:c.name,quantity:c.quantity,note:c.note || '',alternatives:c.alternatives || '',observedOnly:!!c.observedOnly,tracked:c.sourceTracked===undefined?c.tracked:c.sourceTracked};
  scopes.push({setName:set.name,componentName:c.name,sourceHash:inventoryRiskDigest_(raw)});
 });});return scopes.filter(function(s,i){return scopes.findIndex(function(x){return x.setName===s.setName&&x.componentName===s.componentName&&x.sourceHash===s.sourceHash;})===i;});
}
function inventorySemanticKey_(scope){return INVENTORY_SEMANTIC_PREFIX_+inventoryRiskDigest_([scope.setName,scope.componentName]);}

function inventorySemanticLegacyRecords_() {
 var values=PropertiesService.getScriptProperties().getProperties();
 var documentStore=typeof PropertiesService.getDocumentProperties==='function'?PropertiesService.getDocumentProperties():null;
 if(values.inventorySemanticStore_v1_manifest || documentStore?.getProperty('inventorySemanticStore_v1_manifest'))throw new Error('AI 판단 저장소 reader 확인 필요');
 return values;
}

/** Internal metadata audit only. Stale AI evidence remains durable; nothing here expires or rewrites it. */
function auditInventorySemanticStorage() {
 var props=PropertiesService.getScriptProperties(),before=props.getProperties(),snapshot=null,sourceComplete=false;
 var legacyCount=Object.keys(before).filter(function(key){return key.indexOf(INVENTORY_SEMANTIC_PREFIX_)===0;}).length;
 var audited=Object.assign({},before),stored=typeof inventorySemanticStorageRead_==='function'?inventorySemanticStorageRead_():inventorySemanticLegacyRecords_();
 Object.keys(audited).forEach(function(key){if(key.indexOf(INVENTORY_SEMANTIC_PREFIX_)===0)delete audited[key];});
 Object.keys(stored).forEach(function(key){if(key.indexOf(INVENTORY_SEMANTIC_PREFIX_)===0)audited[key]=stored[key];});
 try{snapshot=readInventoryRiskSnapshot_();sourceComplete=!!snapshot && !(snapshot.sourceIssues || []).length;}catch(sourceError){}
 var scopes=sourceComplete?inventorySemanticScopes_(snapshot):[],byKey={},reasons=Object.create(null),bundle={};
 scopes.forEach(function(scope){var key=inventorySemanticKey_(scope);(byKey[key] || (byKey[key]=[])).push(scope);});
 var result={mode:'read_only',sourceComplete:sourceComplete,deletionCandidates:0,
  storage:typeof inventorySemanticStorageState_==='function'?inventorySemanticStorageStatus_(inventorySemanticStorageState_(true)):
   {mode:before.inventorySemanticStore_v1_manifest?'drive':'legacy',legacyCount:legacyCount},
  records:{count:0,keyBytes:0,valueBytes:0},classifications:{},reviewedAtTimeZone:'UTC',reviewedAtDays:{},
  reasonDuplication:{recordCount:0,distinctCount:0,totalBytes:0,distinctBytes:0,repeatedBytes:0},
  compression:{encoding:'gzip_base64',excludesStorageEnvelope:true,roundTripVerifiedCount:0,failedCount:0,individualSourceBytes:0,individualBase64Bytes:0,individualSavedBytes:0,bundleInputBytes:null,bundleBase64Bytes:null,bundleSavedBytes:null},
  otherProperties:{count:0,valueBytes:0,changedDuringRead:0}};
 ['active','source_changed','equipment_identity_changed','missing_scope','ambiguous_scope','invalid_record','source_unavailable']
  .forEach(function(kind){result.classifications[kind]={count:0,valueBytes:0};});
 function bytes(text){return Utilities.newBlob(text).getBytes().length;}
 function gzipBytes(text){
  var compressed=Utilities.gzip(Utilities.newBlob(text,'application/json'));
  if(Utilities.ungzip(compressed).getDataAsString('UTF-8')!==text)throw new Error('Compression round-trip mismatch');
  return Utilities.base64Encode(compressed.getBytes()).length;
 }
 Object.keys(audited).forEach(function(key){
  var text=String(audited[key]),size=bytes(text);
  if(key.indexOf(INVENTORY_SEMANTIC_PREFIX_)!==0){result.otherProperties.count++;result.otherProperties.valueBytes+=size;return;}
  result.records.count++;result.records.keyBytes+=bytes(key);result.records.valueBytes+=size;bundle[key]=text;
  try{var compressedSize=gzipBytes(text);result.compression.roundTripVerifiedCount++;
   result.compression.individualSourceBytes+=size;result.compression.individualBase64Bytes+=compressedSize;result.compression.individualSavedBytes+=size-compressedSize;
  }catch(compressionError){result.compression.failedCount++;}
  var review=null,kind='invalid_record',day='unknown';
  try{review=JSON.parse(text);}catch(parseError){}
  if(review && typeof review==='object' && !Array.isArray(review)){
   var reviewedAt=Date.parse(review.reviewedAt);
   if(Number.isFinite(reviewedAt))day=new Date(reviewedAt).toISOString().slice(0,10);
   if(typeof review.reason==='string'){
    var reasonBytes=bytes(review.reason);result.reasonDuplication.recordCount++;result.reasonDuplication.totalBytes+=reasonBytes;
    if(!Object.prototype.hasOwnProperty.call(reasons,review.reason)){reasons[review.reason]=true;result.reasonDuplication.distinctCount++;result.reasonDuplication.distinctBytes+=reasonBytes;}
   }
   if(typeof review.setName==='string' && typeof review.componentName==='string' && typeof review.sourceHash==='string'
      && ['included','stock'].indexOf(review.disposition)>=0 && Array.isArray(review.allocations)
      && key===inventorySemanticKey_(review)){
    var current=byKey[key] || [];
    if(!sourceComplete)kind='source_unavailable';
    else if(!current.length)kind='missing_scope';
    else if(current.length!==1)kind='ambiguous_scope';
    else if(review.sourceHash!==current[0].sourceHash)kind='source_changed';
    else if(review.allocations.some(function(a){return !a || !snapshot.equipment.some(function(e){return e.id===a.equipmentId && e.name===a.equipmentName;});}))kind='equipment_identity_changed';
    else kind='active';
   }
  }
  result.classifications[kind].count++;result.classifications[kind].valueBytes+=size;
  var dateGroup=result.reviewedAtDays[day] || (result.reviewedAtDays[day]={count:0,valueBytes:0});dateGroup.count++;dateGroup.valueBytes+=size;
 });
 result.reasonDuplication.repeatedBytes=result.reasonDuplication.totalBytes-result.reasonDuplication.distinctBytes;
 try{var bundleText=JSON.stringify(bundle),bundleSize=gzipBytes(bundleText);result.compression.bundleInputBytes=bytes(bundleText);result.compression.bundleBase64Bytes=bundleSize;
  result.compression.bundleSavedBytes=result.records.valueBytes-bundleSize;
 }catch(bundleError){}
 var after=props.getProperties(),changed=0,allKeys=Object.keys(before).concat(Object.keys(after).filter(function(key){return !Object.prototype.hasOwnProperty.call(before,key);}));
 allKeys.forEach(function(key){if(before[key]!==after[key]){changed++;if(key.indexOf(INVENTORY_SEMANTIC_PREFIX_)!==0)result.otherProperties.changedDuringRead++;}});
 result.propertiesStableDuringRead=changed===0;
 return result;
}

function inventoryApplySemanticReviews_(snapshot) {
 // Observed replacement/packing rows are evidence, never new default kit contents.
 (snapshot.sets || []).forEach(function(set){if(!set.components.length)set.components.push({name:set.name,quantity:1,note:'',tracked:true,wholeItem:true});});
 var observed=(snapshot.schedules || []).concat(typeof inventoryReviewPendingRows_==='function'?inventoryReviewPendingRows_():[]);
 observed.forEach(function(row){
  if(!row.setName||!row.name||Date.parse(row.end || '')<Date.now()||!Number.isFinite(Date.parse(row.end || '')))return;
  var set=snapshot.sets.find(function(s){return inventoryRiskNameKey_(s.name)===inventoryRiskNameKey_(row.setName);});
  if(!set||inventoryRiskNameKey_(row.name)===inventoryRiskNameKey_(set.name)||set.components.some(function(c){return inventoryRiskNameKey_(c.name)===inventoryRiskNameKey_(row.name);}))return;
  set.components.push({name:row.name,quantity:1,note:'',tracked:true,observedOnly:true});
 });
 var props=typeof inventorySemanticStorageRead_==='function'?inventorySemanticStorageRead_():inventorySemanticLegacyRecords_(),scopes=inventorySemanticScopes_(snapshot);
 snapshot.semanticScopes=scopes;
 (snapshot.sets || []).forEach(function(set){(set.components || []).forEach(function(c){
  var matches=scopes.filter(function(s){return s.setName===set.name&&s.componentName===c.name;});if(matches.length!==1)return;
  var text=props[inventorySemanticKey_(matches[0])];if(!text)return;var review;
  try{review=JSON.parse(text);}catch(e){return;}
  if(review.sourceHash!==matches[0].sourceHash)return;
  if((review.allocations || []).some(function(a){return !snapshot.equipment.some(function(e){return e.id===a.equipmentId&&e.name===a.equipmentName;});}))return;
  if(c.sourceTracked===undefined)c.sourceTracked=c.tracked;c.semanticReview=review;
  if(review.disposition==='included')c.tracked=false;
  if(review.disposition==='stock'){c.tracked=true;c.allocations=review.allocations;}
 });});return snapshot;
}
function applyInventorySemanticReview(input) {
 if(!input || Object.keys(input).some(function(k){return ['reason','resolutions','execute'].indexOf(k)<0;}) || typeof input.reason!=='string'||!input.reason.trim()||input.reason.length>1600||!Array.isArray(input.resolutions)||!input.resolutions.length||input.resolutions.length>40)throw new Error('AI 구성품 판단 근거 필요');
 var lock=LockService.getScriptLock();if(!lock.tryLock(5000))throw new Error('재고 판단 반영 중');
 try {
  var snapshot=readInventoryRiskSnapshot_();if(snapshot.sourceIssues?.length)throw new Error('전체 재고 자료 확인 필요');
  var scopes=inventorySemanticScopes_(snapshot),seen={},validated=input.resolutions.map(function(r){
   if(!r || Object.keys(r).some(function(k){return ['setName','componentName','sourceHash','disposition','allocations'].indexOf(k)<0;}))throw new Error('구성품 판단 형식 오류');
   var current=scopes.filter(function(s){return s.setName===r.setName&&s.componentName===r.componentName;});
   var key=inventorySemanticKey_(r);if(seen[key]||current.length!==1||current[0].sourceHash!==r.sourceHash)throw new Error('세트 구성 원문이 바뀌었습니다');seen[key]=true;
   if(['included','stock'].indexOf(r.disposition)<0||!Array.isArray(r.allocations)||(r.disposition==='included'?r.allocations.length!==0:!r.allocations.length)||r.allocations.length>12)throw new Error('실물 구성 분류 필요');
   var ids={};r.allocations.forEach(function(a){if(!a||Object.keys(a).some(function(k){return ['equipmentId','equipmentName','quantity'].indexOf(k)<0;})||!Number.isInteger(a.quantity)||a.quantity<1||a.quantity>999||ids[a.equipmentId]||!snapshot.equipment.some(function(e){return e.id===a.equipmentId&&e.name===a.equipmentName;}))throw new Error('실제 장비와 배정 수량 대조 필요');ids[a.equipmentId]=true;});
   return Object.assign({},r,{reason:input.reason,decidedBy:'native_ai',reviewedAt:new Date().toISOString()});
  });
  if(input.execute===false)return {success:true,dryRun:true,resolutions:validated};
  if(typeof inventorySemanticStorageWrite_==='function')inventorySemanticStorageWrite_(validated);
  else {
   inventorySemanticLegacyRecords_();
   var props=PropertiesService.getScriptProperties();validated.forEach(function(r){var text=JSON.stringify(r);if(Utilities.newBlob && Utilities.newBlob(text).getBytes().length>8500)throw new Error('재고 판단 근거 크기 초과');props.setProperty(inventorySemanticKey_(r),text);});
   validated.forEach(function(r){if(JSON.parse(props.getProperty(inventorySemanticKey_(r))).sourceHash!==r.sourceHash)throw new Error('AI 구성품 판단 저장 확인 필요');});
  }
  if(typeof requestInventoryRiskScan_==='function')requestInventoryRiskScan_();
  return {success:true,action:'classify_component',verified:true,effective:true,resolutions:validated};
 }finally{lock.releaseLock();}
}
