/** Durable, independently scheduled inventory alerts. Never edits a rental or a customer message. */
function inventoryRiskLoadState_() {
  var p=PropertiesService.getScriptProperties(),head=p.getProperty(INVENTORY_RISK_PREFIX_+'state');
  if(!head)return {entries:{},pending:null};
  var pointer=JSON.parse(head),text='';
  for(var i=0;i<pointer.parts;i++) {
    var part=p.getProperty(INVENTORY_RISK_PREFIX_+'state_'+pointer.generation+'_'+i);
    if(part===null)throw new Error('재고 경보 저장 상태 확인 필요');
    text+=part;
  }
  return JSON.parse(text);
}

function inventoryRiskSaveState_(state) {
  var p=PropertiesService.getScriptProperties(),oldText=p.getProperty(INVENTORY_RISK_PREFIX_+'state');
  var old=oldText?JSON.parse(oldText):null,text=JSON.stringify(state),generation=Utilities.getUuid(),parts=Math.ceil(text.length/1800),patch={};
  // A new generation is complete before changing the pointer. Korean stays below 9 KB/property.
  for(var i=0;i<parts;i++)patch[INVENTORY_RISK_PREFIX_+'state_'+generation+'_'+i]=text.slice(i*1800,(i+1)*1800);
  p.setProperties(patch);
  p.setProperty(INVENTORY_RISK_PREFIX_+'state',JSON.stringify({generation:generation,parts:parts}));
  if(old)for(var j=0;j<old.parts;j++)p.deleteProperty(INVENTORY_RISK_PREFIX_+'state_'+old.generation+'_'+j);
}

function inventoryRiskSlack_(method,payload) {
  var p=PropertiesService.getScriptProperties(),token=p.getProperty(INVENTORY_RISK_PREFIX_+'slackToken');
  if(!token)throw new Error('재고 경보 Slack 연결 필요');
  var backoffKey=INVENTORY_RISK_PREFIX_+'retryAfter_'+method;
  if(Number(p.getProperty(backoffKey) || 0)>Date.now())throw new Error('Slack 재시도 대기: '+method);
  var read=['auth.test','conversations.info','conversations.history'].indexOf(method)>=0;
  var url='https://slack.com/api/'+method,options={method:read?'get':'post',headers:{Authorization:'Bearer '+token},muteHttpExceptions:true};
  if(read){var query=Object.keys(payload || {}).map(function(k){return encodeURIComponent(k)+'='+encodeURIComponent(String(payload[k]));}).join('&');if(query)url+='?'+query;}
  else{options.contentType='application/json; charset=utf-8';options.payload=JSON.stringify(payload || {});}
  var response=UrlFetchApp.fetch(url,options);
  if(response.getResponseCode()===429){
    var headers=response.getAllHeaders(),retry=Number(headers['Retry-After'] || headers['retry-after'] || 60);
    p.setProperty(backoffKey,String(Date.now()+Math.max(1,retry || 60)*1000));throw new Error('Slack 재시도 대기: '+method);
  }
  if(response.getResponseCode()!==200)throw new Error('Slack 응답 확인 필요: '+method+' ('+response.getResponseCode()+')');
  var result=JSON.parse(response.getContentText());
  if(!result.ok)throw new Error('Slack 연결 확인 필요: '+method+' '+String(result.error || 'unknown_error').replace(/[^a-z0-9_]/gi,''));
  p.deleteProperty(backoffKey);
  return result;
}

function inventoryRiskReceipt_(pending) {
  var cursor='';
  for(var i=0;i<20;i++) {
    var args={channel:pending.channel,oldest:String((pending.createdAt-60000)/1000),inclusive:true,limit:100,include_all_metadata:true};
    if(pending.ts){args.oldest=pending.ts;args.latest=pending.ts;}
    if(cursor)args.cursor=cursor;
    var page=inventoryRiskSlack_('conversations.history',args);
    var found=(page.messages || []).find(function(m){
      return (m.client_msg_id===pending.id || m.metadata?.event_type==='inventory_risk_alert' && m.metadata?.event_payload?.id===pending.id)
        && (!pending.ts || m.ts===pending.ts);
    });
    if(found)return {found:true,ts:found.ts,channel:pending.channel};
    cursor=page.response_metadata?.next_cursor || '';
    if(!cursor && !page.has_more)return {found:false,complete:true};
    if(!cursor)break;
  }
  return {found:false,complete:false};
}

function inventoryRiskDeliver_(state, options) {
  options=options || {};
  var pending=state.pending,receipt;
  if(pending.attemptedAt) {
    receipt=inventoryRiskReceipt_(pending);
    if(!receipt.found && (!receipt.complete || pending.ts || Date.now()-pending.attemptedAt<60000))return false;
  }
  if(!receipt?.found) {
    // Reconcile uncertain receipts at any time, but send/retry only in the daily window.
    if(options.allowSend!==true)return false;
    if(options.draft){pending.text=options.draft.text;pending.entries=options.draft.entries;}
    pending.attemptedAt=Date.now();inventoryRiskSaveState_(state);
    var response=inventoryRiskSlack_('chat.postMessage',{channel:pending.channel,text:pending.text,unfurl_links:false,unfurl_media:false,
      client_msg_id:pending.id,metadata:{event_type:'inventory_risk_alert',event_payload:{id:pending.id}}});
    pending.ts=response.ts;inventoryRiskSaveState_(state);
    receipt=inventoryRiskReceipt_(pending);
    if(!receipt.found)return false;
  }
  state.entries=pending.entries;state.lastReceipt={channel:receipt.channel,ts:receipt.ts,at:new Date().toISOString(),id:pending.id};
  state.pending=null;inventoryRiskSaveState_(state);
  return true;
}

function inventoryRiskClaim_() {
  var lock=LockService.getScriptLock();
  if(!lock.tryLock(1000))return null;
  try {
    var p=PropertiesService.getScriptProperties(),raw=p.getProperty(INVENTORY_RISK_PREFIX_+'lease'),lease=raw?JSON.parse(raw):null;
    if(lease && lease.until>Date.now())return null;
    var owner=Utilities.getUuid();p.setProperty(INVENTORY_RISK_PREFIX_+'lease',JSON.stringify({owner:owner,until:Date.now()+7*60000}));
    return owner;
  }finally{lock.releaseLock();}
}

function inventoryRiskRelease_(owner) {
  var lock=LockService.getScriptLock();if(!lock.tryLock(1000))return;
  try{var p=PropertiesService.getScriptProperties(),raw=p.getProperty(INVENTORY_RISK_PREFIX_+'lease');
    if(raw && JSON.parse(raw).owner===owner)p.deleteProperty(INVENTORY_RISK_PREFIX_+'lease');
  }finally{lock.releaseLock();}
}

function inventoryRiskDetailUrl_() {
  return 'https://today-dashboard-ten.vercel.app/operations';
}

function inventoryRiskNotificationSchedule_(state, now) {
  var offset=9*3600000,local=new Date(now+offset),today=local.toISOString().slice(0,10),hour=inventoryRiskNotificationHour_();
  var receipt=state.lastReceipt,deliveredAt=receipt && (Number(receipt.ts)>0?Number(receipt.ts)*1000:Date.parse(receipt.at));
  // A legacy/change alert sent earlier today also consumes today's one delivery.
  // Use Slack's actual send time, not a later reconciliation time across midnight.
  var lastDate=deliveredAt && Number.isFinite(deliveredAt)?new Date(deliveredAt+offset).toISOString().slice(0,10):null;
  var due=lastDate!==today && local.getUTCHours()===hour;
  var next=new Date(Date.parse(today+'T00:00:00Z')+hour*3600000-offset);
  if(lastDate===today || local.getUTCHours()>hour)next=new Date(next.getTime()+24*3600000);
  return {date:today,due:due,hour:hour,lastNotificationDate:lastDate,nextNotificationAt:next.toISOString()};
}

function inventoryRiskDailyDraft_(report, state) {
  var plan=inventoryRiskNotificationPlan_(report,state.entries);
  // Each morning summarizes current unresolved risks, even when nothing changed.
  plan.daily=true;plan.changed=report.alerts;
  return {text:inventoryRiskSlackText_(report,plan,inventoryRiskDetailUrl_()),entries:plan.entries};
}

function flushInventoryRiskAlerts(event) {
  if(event?.triggerUid)ScriptApp.getProjectTriggers().forEach(function(t){
    if(t.getUniqueId()===event.triggerUid && t.getHandlerFunction()==='flushInventoryRiskAlerts')ScriptApp.deleteTrigger(t);
  });
  var p=PropertiesService.getScriptProperties();
  if(p.getProperty(INVENTORY_RISK_PREFIX_+'enabled')!=='true')return {status:'disabled'};
  var owner=inventoryRiskClaim_();if(!owner)return {status:'busy'};
  var started=Date.now();p.deleteProperty(INVENTORY_RISK_PREFIX_+'queuedAt');
  try {
    var state=inventoryRiskLoadState_();
    var report;
    try{report=getInventoryRiskReport(true);}
    catch(error){
      report={generatedAt:new Date().toISOString(),sourceUnavailable:true,coverage:{complete:false,allFuture:true},conflictCount:0,riskCount:1,
        alerts:[{key:'source_unavailable',kind:'source_unavailable',severity:'risk',equipment:'재고 점검 데이터',bookings:[],start:null}]};
      p.setProperty(INVENTORY_RISK_PREFIX_+'lastScanError','시트·보조 데이터 조회 확인 필요');
    }
    if(!report.sourceUnavailable)p.deleteProperty(INVENTORY_RISK_PREFIX_+'lastScanError');
    p.setProperty(INVENTORY_RISK_PREFIX_+'lastScan',JSON.stringify({at:report.generatedAt,elapsedMs:Date.now()-started,
      coverage:report.coverage,conflicts:report.conflictCount,risks:report.riskCount,sourceUnavailable:!!report.sourceUnavailable}));
    var schedule=inventoryRiskNotificationSchedule_(state,Date.now());
    if(state.pending && !inventoryRiskDeliver_(state,{allowSend:schedule.due,draft:schedule.due?inventoryRiskDailyDraft_(report,state):null})){
      return {status:schedule.due?'pending':'scheduled',nextNotificationAt:schedule.nextNotificationAt};
    }
    schedule=inventoryRiskNotificationSchedule_(state,Date.now());
    if(!schedule.due){
      p.deleteProperty(INVENTORY_RISK_PREFIX_+'lastError');
      return {status:schedule.lastNotificationDate===schedule.date?'already_sent':'scheduled',
        nextNotificationAt:schedule.nextNotificationAt,conflicts:report.conflictCount,risks:report.riskCount};
    }
    var draft=inventoryRiskDailyDraft_(report,state);
    state.pending={id:Utilities.getUuid(),createdAt:Date.now(),channel:p.getProperty(INVENTORY_RISK_PREFIX_+'channel'),
      text:draft.text,entries:draft.entries};
    inventoryRiskSaveState_(state);
    if(!inventoryRiskDeliver_(state,{allowSend:true}))return {status:'pending'};
    p.deleteProperty(INVENTORY_RISK_PREFIX_+'lastError');
    return {status:'sent',conflicts:report.conflictCount,risks:report.riskCount,receipt:state.lastReceipt};
  }catch(error){
    // Do not expose request headers/tokens or mark an uncertain delivery as sent.
    var reason=/^(Slack |재고 )/.test(String(error.message))?String(error.message).slice(0,160):'재고 경보 전송·상태 확인 필요';
    p.setProperty(INVENTORY_RISK_PREFIX_+'lastError',JSON.stringify({at:new Date().toISOString(),message:reason}));
    return {status:'pending',error:'재고 경보 전송·상태 확인 필요'};
  }finally{inventoryRiskRelease_(owner);}
}

function inventoryRiskHeartbeat(){return flushInventoryRiskAlerts();}

function requestInventoryRiskScan_() {
  // Called from booking locks too: no nested locks or network work here.
  try{
    var p=PropertiesService.getScriptProperties();p.setProperty(INVENTORY_RISK_PREFIX_+'dirty',String(Date.now()));
    if(p.getProperty(INVENTORY_RISK_PREFIX_+'enabled')!=='true')return;
    var queued=Number(p.getProperty(INVENTORY_RISK_PREFIX_+'queuedAt') || 0);
    if(Date.now()-queued<60000)return;
    p.setProperty(INVENTORY_RISK_PREFIX_+'queuedAt',String(Date.now()));
    ScriptApp.newTrigger('flushInventoryRiskAlerts').timeBased().after(1000).create();
  }catch(error){/* Independent minute heartbeat also scans when one-shot capacity is busy. */}
}

function getInventoryRiskMonitorStatus() {
  var p=PropertiesService.getScriptProperties(),state=inventoryRiskLoadState_();
  var schedule=inventoryRiskNotificationSchedule_(state,Date.now());
  return {enabled:p.getProperty(INVENTORY_RISK_PREFIX_+'enabled')==='true',channel:p.getProperty(INVENTORY_RISK_PREFIX_+'channel'),
    turnaroundMinutes:Number(p.getProperty(INVENTORY_RISK_PREFIX_+'turnaroundMinutes') || 60),
    notificationFrequency:'daily',notificationHour:schedule.hour,notificationTimeZone:'Asia/Seoul',
    nextNotificationAt:schedule.nextNotificationAt,lastNotificationDate:schedule.lastNotificationDate,
    triggerCount:ScriptApp.getProjectTriggers().filter(function(t){return t.getHandlerFunction()==='inventoryRiskHeartbeat';}).length,
    lastScan:JSON.parse(p.getProperty(INVENTORY_RISK_PREFIX_+'lastScan') || 'null'),lastReceipt:state.lastReceipt || null,
    pending:!!state.pending,lastError:p.getProperty(INVENTORY_RISK_PREFIX_+'lastError'),lastScanError:p.getProperty(INVENTORY_RISK_PREFIX_+'lastScanError')};
}

function setupInventoryRiskMonitor(options) {
  options=options || {};var p=PropertiesService.getScriptProperties();
  if(options.channel && !/^[CG][A-Z0-9]{8,}$/.test(options.channel))throw new Error('Slack 채널 ID 확인 필요');
  if(options.turnaroundMinutes!==undefined && (!Number.isInteger(options.turnaroundMinutes) || options.turnaroundMinutes<0 || options.turnaroundMinutes>1440))throw new Error('반납 여유시간 확인 필요');
  if(options.notificationHour!==undefined && (!Number.isInteger(options.notificationHour) || options.notificationHour<0 || options.notificationHour>23))throw new Error('재고 알림 시간 확인 필요');
  if(options.slackToken)p.setProperty(INVENTORY_RISK_PREFIX_+'slackToken',String(options.slackToken));
  if(options.channel)p.setProperty(INVENTORY_RISK_PREFIX_+'channel',options.channel);
  if(options.turnaroundMinutes!==undefined)p.setProperty(INVENTORY_RISK_PREFIX_+'turnaroundMinutes',String(options.turnaroundMinutes));
  if(options.notificationHour!==undefined)p.setProperty(INVENTORY_RISK_PREFIX_+'notificationHour',String(options.notificationHour));
  var channel=p.getProperty(INVENTORY_RISK_PREFIX_+'channel');if(!channel)throw new Error('Slack 채널 설정 필요');
  inventoryRiskSlack_('auth.test',{});
  // The preselected channel's readable history proves both identity and access.
  // Do not block useful delivery behind a separate, rate-limited channel-info call.
  inventoryRiskSlack_('conversations.history',{channel:channel,limit:1});
  var existing=ScriptApp.getProjectTriggers().filter(function(t){return t.getHandlerFunction()==='inventoryRiskHeartbeat';});
  if(!existing.length)ScriptApp.newTrigger('inventoryRiskHeartbeat').timeBased().everyMinutes(1).create();
  p.setProperty(INVENTORY_RISK_PREFIX_+'enabled',options.enabled===false?'false':'true');
  return getInventoryRiskMonitorStatus();
}
