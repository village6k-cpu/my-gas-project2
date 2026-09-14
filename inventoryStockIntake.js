/** Keep exact report threads available for AI follow-up, independently of booking lifetime. */
function rememberInventoryStockQuestion_(receipt,signature) {
  if(!receipt?.id || !signature)return;
  var names=(signature.uncertain || []).filter(function(a){return inventoryRiskNeedsIdentityReview_(a[0]);}).map(function(a){return a[1];});
  if(!names.length)return;
  var p=PropertiesService.getScriptProperties(),key='inventoryStockQuestion_'+receipt.id,prior=JSON.parse(p.getProperty(key) || '{}');
  names=Array.from(new Set((prior.names || []).concat(names)));
  p.setProperty(key,JSON.stringify({id:receipt.id,channel:receipt.channel,ts:receipt.ts,names:names}));
}
function getInventoryStockQuestions(options) {
  if(options?.refresh===true){var cache=CacheService.getScriptCache();cache.remove('inventory_identity_links_v1');cache.remove('inventory_risk_ledger_aliases_v2');}
  var props=PropertiesService.getScriptProperties().getProperties(),reports={},snapshot=readInventoryRiskSnapshot_();
  var pending=inventoryReviewPendingRows_(),context={equipment:snapshot.equipment,sets:snapshot.sets.slice()};
  var report=buildInventoryRiskReport_(Object.assign({},snapshot,{schedules:snapshot.schedules.concat(pending)})),byName={};
  report.alerts.filter(function(a){return inventoryRiskNeedsIdentityReview_(a.kind);}).forEach(function(a){
    var key=inventoryRiskNameKey_(a.equipment),entry=byName[key] || (byName[key]={name:a.equipment,kinds:[],bookings:[],setNames:[]});
    entry.kinds=Array.from(new Set(entry.kinds.concat(a.kind)));entry.bookings=entry.bookings.concat(a.bookings || []);
    if(a.setName)entry.setNames=Array.from(new Set(entry.setNames.concat(a.setName)));
  });
  var investigations=Object.keys(byName).sort().map(function(k){return byName[k];});
  investigations.forEach(function(a){if(!context.sets.some(function(s){return s.name===a.name;}))context.sets.push({name:a.name,price:null,components:[],source:'requested_equipment'});});
  function add(report){
    if(!report?.id || !report.channel || !report.ts)return;
    var names=(report.names || []).filter(function(name){
      return !context.equipment.some(function(e){return [e.name].concat(e.aliases || []).some(function(n){return inventoryRiskNameKey_(n)===inventoryRiskNameKey_(name);});});
    });
    if(names.length)reports[report.id]=Object.assign({},report,{names:Array.from(new Set((reports[report.id]?.names || []).concat(names)))});
  }
  Object.keys(props).forEach(function(key){
    if(key.indexOf('inventoryStockQuestion_')===0)add(JSON.parse(props[key]));
    if(key.indexOf(PREREG_STOCK_PREFIX_+'state_')===0){
      var state=JSON.parse(props[key]);
      if(state.lastReceipt && state.lastSignature)add(Object.assign({},state.lastReceipt,{names:state.lastSignature.uncertain.map(function(a){return a[1];})}));
    }
  });
  Object.keys(reports).forEach(function(k){reports[k].names.forEach(function(name){if(!context.sets.some(function(s){return s.name===name;}))context.sets.push({name:name,price:null,components:[],source:'reported_equipment'});});});
  return {mode:'read_only',reports:Object.keys(reports).map(function(k){return reports[k];}),equipment:context.equipment,sets:context.sets,
    investigations:investigations,sourceIssues:snapshot.sourceIssues,channel:props[PREREG_STOCK_PREFIX_+'channel'] || props[INVENTORY_RISK_PREFIX_+'channel']};
}

/** Preserve packing quantities, check flags and handwriting while recording an owner decision. */
function setInventoryIncludedComponents(input) {
 if(!input || !Array.isArray(input.rows) || !input.rows.length || input.rows.length>40)throw new Error('동봉품 기록 형식 오류');
 var lock=LockService.getScriptLock();if(!lock.tryLock(5000))throw new Error('세트마스터 반영 중');
 try {
  var sheet=SpreadsheetApp.getActiveSpreadsheet().getSheetByName('세트마스터'),rows=sheet.getDataRange().getValues(),changes=[];
  input.rows.forEach(function(item){
   if(typeof item.setName!=='string'||typeof item.componentName!=='string'||typeof item.expectedNote!=='string')throw new Error('동봉품 원문 필요');
   var found=[];rows.forEach(function(row,index){if(index>0&&row[0]===item.setName&&row[1]===item.componentName)found.push({row:index+1,note:String(row[3] || '')});});
   if(found.length!==1 || found[0].note!==item.expectedNote)throw new Error('세트 구성이나 비고가 바뀌었습니다');
   if(!inventoryRiskComponentIncluded_(found[0].note))changes.push({row:found[0].row,note:'[재고:동봉품]'+(found[0].note?'\n'+found[0].note:'')});
  });
  changes.forEach(function(c){sheet.getRange(c.row,4).setValue(c.note);});SpreadsheetApp.flush();SET_MASTER_SCAN_=null;
  changes.forEach(function(c){if(sheet.getRange(c.row,4).getValue()!==c.note)throw new Error('동봉품 비고 반영 확인 실패');});
  if(typeof requestInventoryRiskScan_==='function')requestInventoryRiskScan_();return {success:true,updated:changes.length};
 } finally {lock.releaseLock();}
}

/** One grouped read keeps unregistered requests visible before any Slack report. */
function inventoryReviewPendingRows_(){
 var table=inventoryRiskSheetRows_(SpreadsheetApp.getActiveSpreadsheet(),'확인요청',['요청ID','장비or세트명','등록상태']),value=table.value,groups={};
 table.rows.forEach(function(r){var id=value(r,'요청ID');if(id)(groups[id] || (groups[id]=[])).push(r);});
 var result=[];Object.keys(groups).forEach(function(id){var rows=groups[id],first=rows.find(function(r){return value(r,'반출일');}) || rows[0];
  rows.forEach(function(r,i){if(/등록완료|거절|보류|제외/.test(value(r,'등록상태')))return;
   var name=value(r,'장비or세트명'),note=value(r,'비고') || '';
   var start=inventoryRiskDateTime_(value(r,'반출일') || value(first,'반출일'),value(r,'반출시간') || value(first,'반출시간'));
   var end=inventoryRiskDateTime_(value(r,'반납일') || value(first,'반납일'),value(r,'반납시간') || value(first,'반납시간'));
   if(!name || !start || !end || Date.parse(end)<=Date.now())return;
   result.push({id:id+':'+i,tradeId:'pending:'+id,customer:value(r,'예약자명') || value(first,'예약자명'),name:name,setName:note.indexOf('[세트]')===0?note.slice(4):name,
    quantity:value(r,'수량'),status:'대기',start:start,end:end});
  });
 });return result;
}
