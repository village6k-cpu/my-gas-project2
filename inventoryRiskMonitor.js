/** GAS adapters and delivery for registered inventory risks. All business reads are read-only. */
var INVENTORY_RISK_PREFIX_ = 'inventoryRisk_v1_';

function inventoryRiskSheetRows_(ss, name, required) {
  var sheet=ss.getSheetByName(name);
  if(!sheet) throw new Error(name+' 시트 없음');
  var rows=sheet.getDataRange().getDisplayValues(), headers=rows.shift() || [];
  required.forEach(function(header){if(headers.indexOf(header)<0) throw new Error(name+' 열 확인 필요: '+header);});
  return {headers:headers, rows:rows, value:function(row,header){return row[headers.indexOf(header)];}};
}

function inventoryRiskDateTime_(date,time) {
  var day=String(date || '').trim().replace(/\./g,'-').replace(/\s+/g,'');
  var clock=String(time || '').trim();
  var match=/^(\d{4})-(\d{1,2})-(\d{1,2})-?$/.exec(day), hm=/^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(clock);
  if(!match || !hm) return '';
  var normalized=match[1]+'-'+match[2].padStart(2,'0')+'-'+match[3].padStart(2,'0')+'T'+hm[1].padStart(2,'0')+':'+hm[2]+':00+09:00';
  var parsed=Date.parse(normalized);
  return Number.isFinite(parsed) && new Date(parsed+9*3600000).toISOString().slice(0,16)===normalized.slice(0,16)?normalized:'';
}

function inventoryRiskDbRows_(cfg,token,table,query) {
  var rows=[];
  for(var offset=0;offset<100000;offset+=500) {
    var response=UrlFetchApp.fetch(cfg.url+'/rest/v1/'+table+'?'+query+'&limit=500&offset='+offset,{
      method:'get',headers:{apikey:cfg.apikey,Authorization:'Bearer '+token,'Accept-Profile':'village'},muteHttpExceptions:true});
    if(response.getResponseCode()!==200) throw new Error('재고 점검 보조 데이터 조회 실패: '+table);
    var page=JSON.parse(response.getContentText());
    if(!Array.isArray(page)) throw new Error('재고 점검 보조 데이터 형식 오류');
    rows=rows.concat(page);
    if(page.length<500) return rows;
  }
  throw new Error('재고 점검 조회 범위 초과');
}

function readInventoryRiskSnapshot_() {
  var ss=SpreadsheetApp.getActiveSpreadsheet();
  var eq=inventoryRiskSheetRows_(ss,'장비마스터',['장비ID','장비명','총보유수량','정비중수량','상태']);
  var set=inventoryRiskSheetRows_(ss,'세트마스터',['세트명','구성장비명','수량']);
  var schedule=inventoryRiskSheetRows_(ss,'스케줄상세',['스케줄ID','거래ID','세트명','장비명','수량','반출일','반출시간','반납일','반납시간','상태']);
  var contract=inventoryRiskSheetRows_(ss,'계약마스터',['거래ID','예약자명','계약상태']);
  var contractById={},equipmentById={},setsByName={};
  contract.rows.forEach(function(r){contractById[contract.value(r,'거래ID')]={name:contract.value(r,'예약자명'),status:contract.value(r,'계약상태')};});
  var equipment=eq.rows.filter(function(r){return eq.value(r,'장비ID') && eq.value(r,'장비명');}).map(function(r){
    var item={id:eq.value(r,'장비ID'),name:eq.value(r,'장비명'),category:eq.value(r,'카테고리'),stock:eq.value(r,'총보유수량'),maintenance:eq.value(r,'정비중수량'),status:eq.value(r,'상태'),aliases:[]};
    equipmentById[item.id]=item; return item;
  });
  set.rows.forEach(function(r){
    var name=set.value(r,'세트명'),component=set.value(r,'구성장비명');
    if(!name) return;
    if(!setsByName[name])setsByName[name]={name:name,components:[]};
    if(component)setsByName[name].components.push({name:component,quantity:set.value(r,'수량'),
      tracked:String(set.value(r,'가용체크(Y/N)') || set.value(r,'가용체크') || '').toUpperCase()!=='N' && !_isCompositeSetAccessoryManifest_(component)});
  });
  var schedules=schedule.rows.filter(function(r){return schedule.value(r,'스케줄ID') || schedule.value(r,'장비명');}).map(function(r){
    var tradeId=schedule.value(r,'거래ID'), c=contractById[tradeId] || {};
    return {id:schedule.value(r,'스케줄ID'),tradeId:tradeId,customer:c.name || '',tradeStatus:c.status || '',
      note:schedule.value(r,'비고'),setName:schedule.value(r,'세트명'),name:schedule.value(r,'장비명'),quantity:schedule.value(r,'수량'),
      start:inventoryRiskDateTime_(schedule.value(r,'반출일'),schedule.value(r,'반출시간')),
      end:inventoryRiskDateTime_(schedule.value(r,'반납일'),schedule.value(r,'반납시간')),status:schedule.value(r,'상태')};
  });
  var sourceIssues=[];
  try {
    var cfg=SUPA_CFG_(),token=supaToken_(cfg);
    if(!token) throw new Error('보조 데이터 인증 확인 필요');
    var aliasCache=CacheService.getScriptCache(),aliasText=aliasCache.get('inventory_risk_ledger_aliases_v1');
    var aliases=aliasText?JSON.parse(aliasText):inventoryRiskDbRows_(cfg,token,'equipment_ledger','select=equipment_id,name,aliases&order=equipment_id');
    if(!aliasText)try{aliasCache.put('inventory_risk_ledger_aliases_v1',JSON.stringify(aliases),60);}catch(cacheError){}
    aliases.forEach(function(row){var item=equipmentById[row.equipment_id];if(item)item.aliases=[row.name].concat(row.aliases || []);});
    var today=Utilities.formatDate(new Date(),'Asia/Seoul','yyyy-MM-dd')+'T00:00:00+09:00';
    var trades=inventoryRiskDbRows_(cfg,token,'trades','select=trade_id,setup_done,return_done&order=trade_id&or='+encodeURIComponent('(return_at.gte.'+today+',and(setup_done.eq.true,return_done.eq.false))'));
    var tradesById={},itemsById={};
    trades.forEach(function(t){tradesById[t.trade_id]=t;});
    // Only physical execution overrides the registered plan. New GAS registrations
    // need no Supabase row yet; this avoids hiding the projection's short delay.
    var physicalIds=trades.filter(function(t){return t.setup_done && !t.return_done;}).map(function(t){return t.trade_id;});
    for(var i=0;i<physicalIds.length;i+=80) {
      var ids=physicalIds.slice(i,i+80).map(function(id){return '"'+String(id).replace(/"/g,'')+'"';}).join(',');
      inventoryRiskDbRows_(cfg,token,'schedule_items','select=schedule_id,trade_id,actual_name,actual_taken_qty,taken_qty,removed_at,checkout_state&order=schedule_id&trade_id=in.('+encodeURIComponent(ids)+')')
        .forEach(function(row){itemsById[row.schedule_id]=row;});
    }
    schedules.forEach(function(row){
      var trade=tradesById[row.tradeId],item=itemsById[row.id];
      if(trade?.return_done)row.returned=true;
      if(trade?.setup_done && !trade.return_done)row.checkedOut=true;
      if(!item)return;
      if(item.removed_at || item.checkout_state==='excluded'){row.quantity=0;return;}
      if(item.actual_name)row.name=item.actual_name;
      if(item.actual_taken_qty!=null)row.quantity=item.actual_taken_qty;
      else if(item.taken_qty!=null)row.quantity=item.taken_qty;
    });
  } catch(error) {sourceIssues.push(String(error.message || error));}
  return {equipment:equipment,sets:Object.keys(setsByName).map(function(k){return setsByName[k];}),schedules:schedules,sourceIssues:sourceIssues};
}

function getInventoryRiskReport(force) {
  var props=PropertiesService.getScriptProperties(),cache=CacheService.getScriptCache();
  var cacheKey='inventoryRisk_report_v2_'+(props.getProperty(INVENTORY_RISK_PREFIX_+'dirty') || 'initial');
  var cached=force===true?null:inventoryRiskCacheRead_(cache,cacheKey);
  if(cached)return cached;
  var snapshot=readInventoryRiskSnapshot_();
  var report=buildInventoryRiskReport_(snapshot,{turnaroundMinutes:Number(props.getProperty(INVENTORY_RISK_PREFIX_+'turnaroundMinutes') || 60)});
  (snapshot.sourceIssues || []).forEach(function(message){
    report.coverage.complete=false;report.sourceUnavailable=true;report.riskCount++;
    report.alerts.unshift({key:'source_unavailable',kind:'source_unavailable',severity:'risk',equipment:'재고 점검 데이터',message:message,bookings:[],sourceNames:[],start:null});
  });
  inventoryRiskCacheWrite_(cache,cacheKey,report,30);
  return report;
}

function inventoryRiskCacheRead_(cache,key) {
  try {
    var text=cache.get(key);if(!text)return null;
    var meta=JSON.parse(text);if(meta.inventoryChunks!==1)return meta;
    var keys=[];for(var i=0;i<meta.count;i++)keys.push(key+'_'+meta.generation+'_'+i);
    var values=cache.getAll(keys),parts=[];
    for(var j=0;j<keys.length;j++){if(values[keys[j]]==null)return null;parts.push(values[keys[j]]);}
    return JSON.parse(parts.join(''));
  }catch(error){return null;}
}

function inventoryRiskCacheWrite_(cache,key,value,ttl) {
  try {
    var text=JSON.stringify(value),generation=Utilities.getUuid(),parts=Math.ceil(text.length/18000),payload={};
    for(var i=0;i<parts;i++)payload[key+'_'+generation+'_'+i]=text.slice(i*18000,(i+1)*18000);
    cache.putAll(payload,ttl);
    cache.put(key,JSON.stringify({inventoryChunks:1,generation:generation,count:parts}),ttl);
  }catch(error){/* Cache misses trigger a full read, never a partial or empty report. */}
}

function inventoryRiskLabel_(kind) {
  return {invalid_supply_allocation:'외부 조달·상위 대체 기록 확인',shortage:'재고 부족',capacity_tight:'여유 재고 10% 이하',turnaround:'반납·반출 간격 부족',unknown_equipment:'장비명 확인 필요',ambiguous_equipment:'장비명 중복 연결',unknown_stock:'보유·정비 수량 확인',
    invalid_quantity:'예약 수량 확인',invalid_schedule:'예약 날짜·시간 확인',overdue_return:'반납 처리 확인 필요',set_component_missing:'세트 구성품 확인',
    invalid_set_component:'세트 구성 수량 확인',maintenance_unquantified:'정비 수량 미기록',source_unavailable:'점검 데이터 연결 확인'}[kind] || '재고 위험';
}

function inventoryRiskOperationsAlerts_(report) {
  return report.alerts.map(function(a){return {date:a.start?Utilities.formatDate(new Date(a.start),'Asia/Seoul','yyyy-MM-dd'):'',equipment:a.equipment,
    stock:a.stock,booked:a.booked,overBy:a.shortage || 0,severity:a.severity,kind:a.kind,reason:inventoryRiskLabel_(a.kind),candidates:a.candidates || [],
    start:a.start,end:a.end,component:a.component || '',bookings:(a.bookings || []).map(function(b){return {tid:b.tradeId,customer:b.customer,from:b.start,to:b.end,qty:b.quantity,name:b.name};})};});
}

function inventoryRiskAttachOperations_(result, report) {
  report=report || getInventoryRiskReport();
  result.inventoryAlerts=inventoryRiskOperationsAlerts_(report);
  result.inventoryCoverage=report.coverage;result.inventoryGeneratedAt=report.generatedAt;
  result.inventoryTurnaroundMinutes=report.turnaroundMinutes;
  result.inventoryUnknownCount=report.alerts.filter(function(a){return a.kind==='unknown_equipment' || a.kind==='ambiguous_equipment';}).length;
  result.summary.inventoryConflicts=report.conflictCount;result.summary.inventoryTight=report.riskCount;
  var p=PropertiesService.getScriptProperties(),lastScan=JSON.parse(p.getProperty(INVENTORY_RISK_PREFIX_+'lastScan') || 'null');
  result.inventoryMonitor={enabled:p.getProperty(INVENTORY_RISK_PREFIX_+'enabled')==='true',lastScanAt:lastScan?.at || null,
    notificationFrequency:'daily',notificationHour:inventoryRiskNotificationHour_(),notificationTimeZone:'Asia/Seoul',
    error:p.getProperty(INVENTORY_RISK_PREFIX_+'lastError') || p.getProperty(INVENTORY_RISK_PREFIX_+'lastScanError') || null};
  delete result.inventoryHorizonDays;
  return result;
}

function inventoryRiskNotificationHour_() {
  var value=PropertiesService.getScriptProperties().getProperty(INVENTORY_RISK_PREFIX_+'notificationHour'),hour=Number(value);
  return value!==null && Number.isInteger(hour) && hour>=0 && hour<=23?hour:9;
}

function inventoryRiskDigest_(value) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,typeof value==='string'?value:JSON.stringify(value),Utilities.Charset.UTF_8)
    .map(function(byte){return ('0'+(byte & 255).toString(16)).slice(-2);}).join('');
}

function inventoryRiskNotificationPlan_(report, previous) {
  previous=previous || {};var entries={},changed=[];
  var today=new Date(Date.parse(report.generatedAt)+9*3600000).toISOString().slice(0,10);
  report.alerts.filter(function(alert){return !report.sourceUnavailable || alert.kind==='source_unavailable';}).forEach(function(alert){
    var key=inventoryRiskDigest_(alert.key), day=alert.start?new Date(Date.parse(alert.start)+9*3600000).toISOString().slice(0,10):'';
    var entry={fingerprint:inventoryRiskDigest_([alert.kind,alert.stock,alert.booked,alert.start,alert.candidates,alert.component,alert.bookings,day && day<=today?'today':'future']),
      shortage:alert.shortage || 0,severity:alert.severity};
    entries[key]=entry;
    if(!previous[key] || previous[key].fingerprint!==entry.fingerprint)changed.push(alert);
  });
  if(report.sourceUnavailable)Object.keys(previous).forEach(function(key){if(!entries[key])entries[key]=previous[key];});
  var resolved=Object.keys(previous).filter(function(key){return !entries[key];}).length;
  return {entries:entries,changed:changed,resolved:resolved,notify:changed.length>0 || (resolved>0 && !report.alerts.length)};
}

function inventoryRiskSlackText_(report, plan, detailUrl) {
  function clean(s){return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/[\r\n]/g,' ');}
  function when(s){return s?Utilities.formatDate(new Date(s),'Asia/Seoul','M/d HH:mm'):'일정 확인 필요';}
  if(report.sourceUnavailable)return '⚠️ *재고 점검 연결 확인 필요*\n전체 점검을 완료하지 못했습니다. 기존 위험은 유지합니다.\n<'+detailUrl+'|재고 점검 상태 보기>';
  if(!report.alerts.length)return (plan.resolved?'✅ 재고 위험 해소 · 이전 '+plan.resolved+'건':'✅ 재고 충돌·위험 없음')+'\n오늘부터 전체 향후 일정 점검 완료';
  var lines=[(plan.daily?'☀️ *아침 재고 점검*':'🚨 *재고 경보*')+' · 🔴 부족 '+report.conflictCount+'건 · ⚠️ 위험 '+report.riskCount+'건'];
  plan.changed.slice(0,5).forEach(function(a){
    var label=a.kind==='shortage'?a.shortage+'개 부족':inventoryRiskLabel_(a.kind);
    lines.push((a.kind==='shortage'?'🔴':'⚠️')+' *'+clean(a.equipment)+'* — '+label);
    lines.push('　'+when(a.start)+(a.stock!==undefined?' · 가용 '+a.stock+' / 필요 '+a.booked:''));
    var people=Array.from(new Set((a.bookings || []).map(function(b){return clean(b.customer || b.tradeId);}))).slice(0,4);
    if(people.length)lines.push('　'+people.join(' · '));
    if(a.candidates?.length)lines.push('　이름 후보: '+a.candidates.slice(0,2).map(clean).join(' / '));
  });
  if(plan.changed.length>5)lines.push((plan.daily?'외 ':'외 변경 ')+(plan.changed.length-5)+'건');
  lines.push('<'+detailUrl+'|전체 위험·예약 보기>');
  return lines.join('\n');
}
