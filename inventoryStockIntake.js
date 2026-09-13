/** Keep exact report threads available for AI follow-up, independently of booking lifetime. */
function rememberInventoryStockQuestion_(receipt,signature) {
  if(!receipt?.id || !signature)return;
  var names=(signature.uncertain || []).filter(function(a){return ['unknown_equipment','catalog_stock_missing'].indexOf(a[0])>=0;}).map(function(a){return a[1];});
  if(!names.length)return;
  var p=PropertiesService.getScriptProperties(),key='inventoryStockQuestion_'+receipt.id,prior=JSON.parse(p.getProperty(key) || '{}');
  names=Array.from(new Set((prior.names || []).concat(names)));
  p.setProperty(key,JSON.stringify({id:receipt.id,channel:receipt.channel,ts:receipt.ts,names:names}));
}
function getInventoryStockQuestions() {
  var props=PropertiesService.getScriptProperties().getProperties(),reports={},context=getInventoryResolutionContext();
  function add(report){
    if(!report?.id || !report.channel || !report.ts)return;
    var names=(report.names || []).filter(function(name){
      return context.sets.some(function(s){return s.name===name;}) &&
        !context.equipment.some(function(e){return [e.name].concat(e.aliases || []).some(function(n){return inventoryRiskNameKey_(n)===inventoryRiskNameKey_(name);});});
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
  return {mode:'read_only',reports:Object.keys(reports).map(function(k){return reports[k];}),equipment:context.equipment,sets:context.sets};
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
