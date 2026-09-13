/** Immediate owner notices for real reservation checks; independent of the 07:00 digest. */
var PREREG_STOCK_PREFIX_='preRegStock_v1_';

function preRegistrationStockEvaluate_(request,snapshot) {
  var candidateId='pending:'+request.id,demands=[],identity;
  // A delivered/registered request can later be changed directly in the schedule.
  // Reconcile pending notices against that current trade, not the old request copy.
  var currentRows=request.registered && request.tradeId?
    (snapshot.schedules || []).filter(function(row){return row.tradeId===request.tradeId;}):request.rows;
  var proposed=currentRows.map(function(row){return Object.assign({},row,{tradeId:candidateId,customer:request.customer,
    status:request.registered?row.status:(row.status==='제외'?'제외':'대기')});});
  var existing=(snapshot.schedules || []).filter(function(row){return !request.tradeId || row.tradeId!==request.tradeId;});
  var report=buildInventoryRiskReport_(Object.assign({},snapshot,{schedules:existing.concat(proposed)}),{
    turnaroundMinutes:0,onDemands:function(rows,index){demands=rows;identity=index;}
  });
  var uncertain=report.alerts.filter(function(a){return a.kind!=='shortage' && a.kind!=='capacity_tight' && a.kind!=='overdue_return' &&
    a.bookings.some(function(b){return b.tradeId===candidateId;});});
  if((snapshot.sourceIssues || []).length)uncertain.push({kind:'source_unavailable',equipment:'실재고·별칭 연결 확인 필요'});
  var equipment={},periods={},shortages=[];
  (snapshot.equipment || []).forEach(function(e){equipment[e.name]={total:Number(e.stock),maintenance:Number(e.maintenance),category:e.category};});
  demands.filter(function(d){return d.tradeId===candidateId;}).forEach(function(d){
    var key=d.start+'|'+d.end,group=periods[key] || (periods[key]={start:d.start,end:d.end,items:{}}),name=identity.byId[d.equipmentId].name;
    group.items[name]=(group.items[name] || 0)+d.quantity;
  });
  Object.keys(periods).forEach(function(key){
    var group=periods[key],rows=demands.filter(function(d){return d.tradeId!==candidateId || d.start+'|'+d.end!==key;});
    var schedule=rows.map(function(d){return {equipment:identity.byId[d.equipmentId].name,qty:d.quantity,startDT:new Date(d.start),endDT:new Date(d.end),status:d.status};});
    var items=Object.keys(group.items).filter(function(name){
      var original=(snapshot.equipment || []).find(function(e){return e.name===name;});
      if(inventoryRiskNumber_(original.stock)===null || inventoryRiskNumber_(original.maintenance)===null || Number(original.maintenance)>Number(original.stock)) {
        uncertain.push({kind:'unknown_stock',equipment:name});return false;
      }
      return true;
    }).map(function(name){return {name:name,qty:group.items[name]};});
    var plan=inventorySupplyPlan_(items,new Date(group.start),new Date(group.end),{equipment:equipment},schedule);
    plan.conflicts.forEach(function(conflict){
      if(!Number.isFinite(conflict.available)||!Number.isFinite(conflict.requested)) {uncertain.push({kind:'inventory_check',equipment:conflict.equipment});return;}
      var related=inventorySupplyRelatedNames_([conflict.equipment]);
      var bookings=rows.filter(function(d){return related.indexOf(identity.byId[d.equipmentId].name)>=0 && d.startMs<Date.parse(group.end) && d.endMs>Date.parse(group.start);})
        .map(function(d){return inventoryRiskBooking_(d);});
      shortages.push({equipment:conflict.equipment,requested:conflict.requested,available:conflict.available,shortage:conflict.requested-conflict.available,
        start:group.start,end:group.end,bookings:bookings});
    });
  });
  return {requestId:request.id,customer:request.customer,tradeId:request.tradeId || '',registered:!!request.registered,
    start:proposed[0]?.start || request.rows[0]?.start || '',end:proposed.reduce(function(end,r){return r.end>end?r.end:end;},'') || request.rows[0]?.end || '',shortages:shortages,uncertain:uncertain};
}

function preRegistrationStockText_(result) {
  function clean(value){return String(value || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/[\r\n]/g,' ');}
  function when(value){return Utilities.formatDate(new Date(value),'Asia/Seoul','M/d HH:mm');}
  var lines=[(result.shortages.length?'🚨 *재고 부족*':'⚠️ *재고 확인 필요*')+' · '+clean(result.customer),
    '🗓️ '+when(result.start)+' ~ '+when(result.end)];
  result.shortages.slice(0,4).forEach(function(s){
    lines.push('🔴 '+clean(s.equipment)+' — 필요 '+s.requested+' / 가용 '+s.available+' · *'+s.shortage+'대 부족*');
    var names=Array.from(new Set(s.bookings.map(function(b){return clean(b.customer || b.tradeId);}))).slice(0,3);
    if(names.length)lines.push('　겹치는 예약: '+names.join(' · '));
  });
  result.uncertain.slice(0,3).forEach(function(a){lines.push('❓ '+clean(a.component || a.equipment)+' — 재고 연결 확인 필요');});
  if(result.shortages.length>4)lines.push('외 부족 '+(result.shortages.length-4)+'건');
  lines.push(result.registered?'👉 등록된 예약입니다. 공급 가능 여부를 즉시 확인해 주세요.':'👉 등록 전에 대체 장비·외부 조달 여부를 확인해 주세요.');
  lines.push('<https://today-dashboard-ten.vercel.app/schedule|예약 보기> · '+clean(result.requestId));
  return lines.join('\n').slice(0,2200);
}

function preRegistrationStockHash_(value) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,JSON.stringify(value),Utilities.Charset.UTF_8)
    .map(function(b){return ('0'+((b+256)%256).toString(16)).slice(-2);}).join('');
}

function preRegistrationStockReceipt_(pending) {
  var args={channel:pending.channel,oldest:pending.ts || String((pending.createdAt-60000)/1000),inclusive:true,limit:100,include_all_metadata:true};
  if(pending.ts)args.latest=pending.ts;
  var cursor='';
  for(var i=0;i<3;i++) {
    if(cursor)args.cursor=cursor;
    var page=inventoryRiskSlack_('conversations.history',args);
    var message=(page.messages || []).find(function(m){return m.metadata?.event_type==='preregistration_stock_alert' &&
      m.metadata?.event_payload?.id===pending.id && m.text===pending.text && (!pending.ts || pending.ts===m.ts);});
    if(message)return {found:true,ts:message.ts};
    cursor=page.response_metadata?.next_cursor || '';
    if(!cursor && !page.has_more)return {found:false,complete:true};
    if(!cursor)break;
  }
  return {found:false,complete:false};
}

function preRegistrationStockDeliver_(evaluation) {
  var p=PropertiesService.getScriptProperties(),key=PREREG_STOCK_PREFIX_+'state_'+evaluation.requestId;
  var state=JSON.parse(p.getProperty(key) || '{}'),reconciled=false;
  var fingerprint=preRegistrationStockHash_({customer:evaluation.customer,start:evaluation.start,end:evaluation.end,
    shortages:evaluation.shortages.map(function(s){return [s.equipment,s.start,s.end,s.requested,s.available];}).sort(),
    uncertain:evaluation.uncertain.map(function(a){return [a.kind,a.equipment,a.component || ''];}).sort()});
  var actionable=evaluation.shortages.length+evaluation.uncertain.length>0;
  function save(){p.setProperty(key,JSON.stringify(state));}
  try {
    if(state.pending) {
      var prior=preRegistrationStockReceipt_(state.pending);
      if(prior.found) {
        state.lastHash=state.pending.hash;state.lastReceipt={id:state.pending.id,ts:prior.ts,channel:state.pending.channel,at:new Date().toISOString()};
        state.pending=null;state.error=null;reconciled=true;save();
      } else if(!prior.complete || state.pending.ts || Date.now()-state.pending.attemptedAt<60000) {
        return {status:'pending',requestId:evaluation.requestId};
      } else if(state.pending.hash!==fingerprint || !actionable) {state.pending=null;save();}
    }
    if(!actionable) {state.lastHash='';state.end=evaluation.end;state.pending=null;save();return {status:'clear',requestId:evaluation.requestId};}
    if(state.lastHash===fingerprint)return {status:reconciled?'sent':'already_sent',requestId:evaluation.requestId,receipt:state.lastReceipt};
    if(!state.pending)state.pending={id:Utilities.getUuid(),hash:fingerprint,channel:p.getProperty(PREREG_STOCK_PREFIX_+'channel'),
      createdAt:Date.now(),text:preRegistrationStockText_(evaluation)};
    state.end=evaluation.end;state.pending.attemptedAt=Date.now();save();
    var response=inventoryRiskSlack_('chat.postMessage',{channel:state.pending.channel,text:state.pending.text,
      unfurl_links:false,unfurl_media:false,client_msg_id:state.pending.id,
      metadata:{event_type:'preregistration_stock_alert',event_payload:{id:state.pending.id,request_id:evaluation.requestId}}});
    if(!response.ts || response.channel && response.channel!==state.pending.channel)throw new Error('Slack 전달 결과 불일치');
    state.pending.ts=response.ts;save();
    var receipt=preRegistrationStockReceipt_(state.pending);
    if(!receipt.found)return {status:'pending',requestId:evaluation.requestId};
    state.lastHash=state.pending.hash;state.lastReceipt={id:state.pending.id,ts:receipt.ts,channel:state.pending.channel,at:new Date().toISOString()};
    state.pending=null;state.error=null;save();
    return {status:'sent',requestId:evaluation.requestId,receipt:state.lastReceipt};
  }catch(error){state.error='Slack 재고 알림 전달 확인 대기';save();return {status:'pending',requestId:evaluation.requestId,error:state.error};}
}

function queuePreRegistrationStockCheck_(requestId) {
  var p=PropertiesService.getScriptProperties();
  if(p.getProperty(PREREG_STOCK_PREFIX_+'enabled')!=='true' || !/^RQ-\d{6}-\d{3}$/.test(String(requestId)))return;
  // Writers own dirty; the consumer only writes checked. A newer generation can
  // never be erased by an older check completing between a comparison and delete.
  // Ordinary request writes already own UserLock; registration owns ScriptLock.
  // A direct API queue takes UserLock so retention can briefly fence both writers.
  var inputLock=LockService.getUserLock(),ownsInputLock=false;
  if(!inputLock.hasLock() && !LockService.getScriptLock().hasLock()){inputLock.waitLock(30000);ownsInputLock=true;}
  try {p.setProperty(PREREG_STOCK_PREFIX_+'dirty_'+requestId,Date.now()+':'+Utilities.getUuid());}
  finally {if(ownsInputLock)inputLock.releaseLock();}
}

function preRegistrationStockPrune_(scriptLockHeld) {
  var lock=LockService.getScriptLock(),inputLock=LockService.getUserLock(),ownsInputLock=false;
  if(!scriptLockHeld && !lock.tryLock(1000))return;
  try {
    if(!inputLock.hasLock()) {if(!inputLock.tryLock(100))return;ownsInputLock=true;}
    var p=PropertiesService.getScriptProperties(),all=p.getProperties(),prefix=PREREG_STOCK_PREFIX_+'dirty_',cutoff=Date.now()-7*86400000;
    Object.keys(all).filter(function(k){return k.indexOf(prefix)===0;}).forEach(function(k){
      var id=k.slice(prefix.length),state=JSON.parse(all[PREREG_STOCK_PREFIX_+'state_'+id] || '{}');
      if(all[k]!==all[PREREG_STOCK_PREFIX_+'checked_'+id] || state.pending)return;
      if(state.end?!(Date.parse(state.end)<cutoff):!(parseInt(all[k],10)<cutoff))return;
      ['state_','dirty_','checked_','registered_','registering_'].forEach(function(part){p.deleteProperty(PREREG_STOCK_PREFIX_+part+id);});
    });
  }finally{if(ownsInputLock)inputLock.releaseLock();if(!scriptLockHeld)lock.releaseLock();}
}

function preRegistrationStockPendingKeys_(properties) {
  var prefix=PREREG_STOCK_PREFIX_+'dirty_';
  return Object.keys(properties).filter(function(k){return k.indexOf(prefix)===0 &&
    properties[k]!==properties[PREREG_STOCK_PREFIX_+'checked_'+k.slice(prefix.length)];})
    .sort(function(a,b){return parseInt(properties[a],10)-parseInt(properties[b],10);});
}

function preRegistrationStockRequest_(requestId,includeRegistered,forRegistration) {
  var ss=SpreadsheetApp.getActiveSpreadsheet(),table=inventoryRiskSheetRows_(ss,'확인요청',
    ['요청ID','반출일','반출시간','반납일','반납시간','장비or세트명','수량','예약자명','등록상태','거래ID']);
  var value=table.value,rows=table.rows.filter(function(r){var status=value(r,'등록상태');
    return value(r,'요청ID')===requestId && (forRegistration || ['거절','보류'].indexOf(status)<0);});
  var active=rows.filter(function(r){return value(r,'등록상태')!=='제외';});
  if(!active.length)return null;
  var registered=active.every(function(r){return /^등록완료/.test(value(r,'등록상태'));});
  if(registered && !includeRegistered)return null;
  var first=rows.find(function(r){return value(r,'반출일');}) || rows[0];
  var customer=rows.map(function(r){return value(r,'예약자명');}).find(Boolean);
  var trades=Array.from(new Set(rows.map(function(r){return value(r,'거래ID');}).filter(Boolean)));
  if(!customer || trades.length>1)return null;
  var items=rows.map(function(r,i){
    var name=value(r,'장비or세트명'),tag=value(r,'비고'),setName=tag.indexOf('[세트]')===0?tag.slice(4):name;
    return {id:requestId+'-'+i,name:name,setName:setName,quantity:Number(value(r,'수량')),status:value(r,'등록상태')==='제외'?'제외':'대기',
      start:inventoryRiskDateTime_(value(r,'반출일') || value(first,'반출일'),value(r,'반출시간') || value(first,'반출시간')),
      end:inventoryRiskDateTime_(value(r,'반납일') || value(first,'반납일'),value(r,'반납시간') || value(first,'반납시간'))};
  });
  if(items.some(function(r){return !r.name || !r.start || !r.end || Date.parse(r.start)>=Date.parse(r.end);}))return null;
  if(items.every(function(r){return Date.parse(r.end)<Date.now();}))return null;
  return {id:requestId,customer:customer,tradeId:trades[0] || '',registered:registered,rows:items};
}

function preRegistrationStockFlush_(requestId,scriptLockHeld,includeRegistered,preparedEvaluation) {
  var p=PropertiesService.getScriptProperties();
  if(p.getProperty(PREREG_STOCK_PREFIX_+'enabled')!=='true')return {status:'disabled'};
  var lock=LockService.getScriptLock(),owner=Utilities.getUuid(),claimed=false;
  if(!scriptLockHeld && !lock.tryLock(1000))return {status:'busy'};
  try {
    var lease=JSON.parse(p.getProperty(PREREG_STOCK_PREFIX_+'lease') || '{}');
    if(lease.until>Date.now())return {status:'busy'};
    p.setProperty(PREREG_STOCK_PREFIX_+'lease',JSON.stringify({owner:owner,until:Date.now()+7*60000}));claimed=true;
  }finally{if(!scriptLockHeld)lock.releaseLock();}
  if(!claimed)return {status:'busy'};
  var results=[];
  try {
    var properties=p.getProperties(),prefix=PREREG_STOCK_PREFIX_+'dirty_';
    var ids=requestId?[requestId]:preRegistrationStockPendingKeys_(properties).slice(0,4).map(function(k){return k.slice(prefix.length);});
    var snapshot=null;
    ids.forEach(function(id){
      var marker=p.getProperty(prefix+id),priorState=JSON.parse(p.getProperty(PREREG_STOCK_PREFIX_+'state_'+id) || '{}');
      var allowRegistered=includeRegistered || !!priorState.pending || p.getProperty(PREREG_STOCK_PREFIX_+'registered_'+id)==='true';
      var forRegistration=p.getProperty(PREREG_STOCK_PREFIX_+'registering_'+id)==='true';
      var request;
      if(preparedEvaluation && preparedEvaluation.requestId===id)request={id:id};
      else {
        var inputLock=LockService.getUserLock(),inputLockHeld=inputLock.hasLock();
        if(!inputLockHeld && !inputLock.tryLock(1000)){results.push({requestId:id,status:'pending'});return;}
        try {request=preRegistrationStockRequest_(id,allowRegistered,forRegistration);}
        finally {if(!inputLockHeld)inputLock.releaseLock();}
      }
      if(!request){if(marker)p.setProperty(PREREG_STOCK_PREFIX_+'checked_'+id,marker);results.push({requestId:id,status:'skipped'});return;}
      if(!preparedEvaluation && !snapshot)snapshot=readInventoryRiskSnapshot_();
      var evaluation=preparedEvaluation && preparedEvaluation.requestId===id?preparedEvaluation:preRegistrationStockEvaluate_(request,snapshot);
      var result=preRegistrationStockDeliver_(evaluation);results.push(result);
      if(result.status!=='pending' && marker)p.setProperty(PREREG_STOCK_PREFIX_+'checked_'+id,marker);
      p.setProperty(PREREG_STOCK_PREFIX_+'lastResult',JSON.stringify(Object.assign({at:new Date().toISOString()},result)));
    });
    // Bound ScriptProperties use, retaining every future/pending receipt and
    // taking both writer locks only for the short deletion of closed generations.
    preRegistrationStockPrune_(scriptLockHeld);
    p.deleteProperty(PREREG_STOCK_PREFIX_+'lastError');
    return {status:'ok',results:results};
  }catch(error){p.setProperty(PREREG_STOCK_PREFIX_+'lastError','등록 전 재고 검사·알림 재시도 대기');return {status:'pending',results:results,error:'등록 전 재고 검사·알림 재시도 대기'};}
  finally{
    var current=JSON.parse(p.getProperty(PREREG_STOCK_PREFIX_+'lease') || '{}');
    if(current.owner===owner)p.deleteProperty(PREREG_STOCK_PREFIX_+'lease');
  }
}

function flushPreRegistrationStockAlerts(){return preRegistrationStockFlush_(null,false,false);}
function checkPreRegistrationStockBeforeRegister_(requestId){
  if(PropertiesService.getScriptProperties().getProperty(PREREG_STOCK_PREFIX_+'enabled')!=='true')return {ready:true,status:'disabled'};
  try {
    var request=preRegistrationStockRequest_(requestId,false,true);
    if(!request)return {ready:true,status:'skipped'};
    var evaluation=preRegistrationStockEvaluate_(request,readInventoryRiskSnapshot_());
    if(!evaluation.shortages.length && !evaluation.uncertain.length)return {ready:true,status:'clear'};
    PropertiesService.getScriptProperties().setProperty(PREREG_STOCK_PREFIX_+'registering_'+requestId,'true');
    queuePreRegistrationStockCheck_(requestId);
    var result=preRegistrationStockFlush_(requestId,true,false,evaluation);
    return {ready:result.status==='ok' && result.results.length===1 && ['sent','already_sent'].indexOf(result.results[0].status)>=0,result:result};
  }catch(error){return {ready:false,status:'pending'};}
}

function checkPreRegistrationStockAlert(options) {
  options=options || {};var id=String(options.requestId || '');
  if(!/^RQ-\d{6}-\d{3}$/.test(id))throw new Error('확인요청 ID 확인 필요');
  if(options.notify===true){
    if(options.includeRegistered===true)PropertiesService.getScriptProperties().setProperty(PREREG_STOCK_PREFIX_+'registered_'+id,'true');
    queuePreRegistrationStockCheck_(id);return preRegistrationStockFlush_(id,false,options.includeRegistered===true);
  }
  var request=preRegistrationStockRequest_(id,options.includeRegistered===true);
  return request?preRegistrationStockEvaluate_(request,readInventoryRiskSnapshot_()):{status:'skipped',requestId:id};
}

function getPreRegistrationStockAlertStatus() {
  var p=PropertiesService.getScriptProperties(),all=p.getProperties();
  return {enabled:p.getProperty(PREREG_STOCK_PREFIX_+'enabled')==='true',channel:p.getProperty(PREREG_STOCK_PREFIX_+'channel'),
    pending:preRegistrationStockPendingKeys_(all).length,
    lastResult:JSON.parse(p.getProperty(PREREG_STOCK_PREFIX_+'lastResult') || 'null'),lastError:p.getProperty(PREREG_STOCK_PREFIX_+'lastError')};
}

function setupPreRegistrationStockAlerts(options) {
  options=options || {};var p=PropertiesService.getScriptProperties(),channel=options.channel || p.getProperty(PREREG_STOCK_PREFIX_+'channel');
  if(!/^[CG][A-Z0-9]{8,}$/.test(channel || ''))throw new Error('Slack 채널 ID 확인 필요');
  inventoryRiskSlack_('conversations.history',{channel:channel,limit:1});
  p.setProperty(PREREG_STOCK_PREFIX_+'channel',channel);p.setProperty(PREREG_STOCK_PREFIX_+'enabled',options.enabled===false?'false':'true');
  if(!ScriptApp.getProjectTriggers().some(function(t){return t.getHandlerFunction()==='inventoryRiskHeartbeat';}))
    ScriptApp.newTrigger('inventoryRiskHeartbeat').timeBased().everyMinutes(1).create();
  return getPreRegistrationStockAlertStatus();
}
