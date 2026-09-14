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

function inventoryRiskComponentIncluded_(note) {
  return /(?:^|\n)\[재고:동봉품\](?:\r?$|\s)/m.test(String(note || ''));
}

function inventoryRiskEnrichLedger_(equipment,ledger,resolutions) {
  var byId={};equipment.forEach(function(item){byId[item.id]=item;});
  ledger.forEach(function(row){
    var item=byId[row.equipment_id];if(!item)return;
    item.aliases=[row.name].concat(row.aliases || []);
    // Supplemental counts only fill an absent cell for the same verified asset.
    // Never replace explicit zero, maintenance state, or a differing master count.
    if(item.maintenance==='' && row.verify_status==='verified' && item.name===row.name &&
      item.status===row.state && Number(item.stock)===row.stock_total && Number.isInteger(row.stock_maint) && row.stock_maint>=0 && row.stock_maint<=row.stock_total) {
      item.maintenance=row.stock_maint;item.maintenanceSource='verified_equipment_ledger';
    }
  });
  (resolutions || []).forEach(function(link){var item=byId[link.equipment_id];
    if(item && item.name===link.equipment_name)item.aliases=Array.from(new Set((item.aliases || []).concat(link.source_name)));
  });
}

function readInventoryRiskSnapshot_() {
  var ss=SpreadsheetApp.getActiveSpreadsheet();
  var eq=inventoryRiskSheetRows_(ss,'장비마스터',['장비ID','장비명','총보유수량','정비중수량','상태']);
  var set=inventoryRiskSheetRows_(ss,'세트마스터',['세트명','구성장비명','수량']);
  var schedule=inventoryRiskSheetRows_(ss,'스케줄상세',['스케줄ID','거래ID','세트명','장비명','수량','반출일','반출시간','반납일','반납시간','상태']);
  var contract=inventoryRiskSheetRows_(ss,'계약마스터',['거래ID','예약자명','계약상태']);
  var contractById={},equipmentById={},setsByName={};
  contract.rows.forEach(function(r){contractById[contract.value(r,'거래ID')]={name:contract.value(r,'예약자명'),status:contract.value(r,'계약상태'),start:inventoryRiskDateTime_(contract.value(r,'반출일'),contract.value(r,'반출시간')),end:inventoryRiskDateTime_(contract.value(r,'반납일'),contract.value(r,'반납시간'))};});
  var equipment=eq.rows.filter(function(r){return eq.value(r,'장비ID') && eq.value(r,'장비명');}).map(function(r){
    var item={id:eq.value(r,'장비ID'),name:eq.value(r,'장비명'),category:eq.value(r,'카테고리'),stock:eq.value(r,'총보유수량'),maintenance:eq.value(r,'정비중수량'),status:eq.value(r,'상태'),aliases:[]};
    equipmentById[item.id]=item; return item;
  });
  set.rows.forEach(function(r){
    var name=set.value(r,'세트명'),component=set.value(r,'구성장비명');
    if(!name) return;
    if(!setsByName[name])setsByName[name]={name:name,price:set.value(r,'단가'),components:[]};
    if(component)setsByName[name].components.push({name:component,quantity:set.value(r,'수량'),
      note:set.value(r,'비고') || '',alternatives:set.value(r,'대체가능장비') || '',
      tracked:String(set.value(r,'가용체크(Y/N)') || set.value(r,'가용체크') || '').toUpperCase()!=='N' && !inventoryRiskComponentIncluded_(set.value(r,'비고'))});
  });
  var schedules=schedule.rows.filter(function(r){return schedule.value(r,'스케줄ID') || schedule.value(r,'장비명');}).map(function(r){
    var tradeId=schedule.value(r,'거래ID'), c=contractById[tradeId] || {};
    return {id:schedule.value(r,'스케줄ID'),tradeId:tradeId,customer:c.name || '',tradeStatus:c.status || '',
      note:schedule.value(r,'비고'),setName:schedule.value(r,'세트명'),name:schedule.value(r,'장비명'),quantity:schedule.value(r,'수량'),
      start:inventoryRiskDateTime_(schedule.value(r,'반출일'),schedule.value(r,'반출시간')) || c.start || '',
      end:inventoryRiskDateTime_(schedule.value(r,'반납일'),schedule.value(r,'반납시간')) || c.end || '',status:schedule.value(r,'상태')};
  });
  var sourceIssues=[];
  try {
    var cfg=SUPA_CFG_(),token=supaToken_(cfg);
    if(!token) throw new Error('보조 데이터 인증 확인 필요');
    var aliasCache=CacheService.getScriptCache(),aliasText=aliasCache.get('inventory_risk_ledger_aliases_v2');
    var aliases=aliasText?JSON.parse(aliasText):inventoryRiskDbRows_(cfg,token,'equipment_ledger','select=equipment_id,name,aliases,stock_total,stock_maint,state,verify_status&order=equipment_id');
    if(!aliasText)try{aliasCache.put('inventory_risk_ledger_aliases_v2',JSON.stringify(aliases),60);}catch(cacheError){}
    var linkText=aliasCache.get('inventory_identity_links_v1');
    var links=linkText?JSON.parse(linkText):inventoryRiskDbRows_(cfg,token,'inventory_identity_aliases','select=source_name,equipment_id,equipment_name&order=source_name');
    if(!linkText)try{aliasCache.put('inventory_identity_links_v1',JSON.stringify(links),30);}catch(cacheError){}
    inventoryRiskEnrichLedger_(equipment,aliases,links);
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
  var snapshot={equipment:equipment,sets:Object.keys(setsByName).map(function(k){return setsByName[k];}),schedules:schedules,sourceIssues:sourceIssues};
  if(typeof inventoryApplySemanticReviews_==='function')inventoryApplySemanticReviews_(snapshot);
  return snapshot;
}

function getInventoryRiskReport(force) {
  var props=PropertiesService.getScriptProperties(),cache=CacheService.getScriptCache();
  var cacheKey='inventoryRisk_report_v3_'+(props.getProperty(INVENTORY_RISK_PREFIX_+'dirty') || 'initial');
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
    catalog_stock_missing:'실보유수량 확인 후 장비마스터 등록',model_selection:'구체 모델 선택',conflicting_set_definition:'중복 세트 구성 대조',invalid_set_component:'세트 구성 수량 확인',maintenance_unquantified:'정비 수량 미기록',source_unavailable:'점검 데이터 연결 확인'}[kind] || '재고 위험';
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

function inventoryRiskActionableAlert_(a){return ['shortage','turnaround','source_unavailable'].indexOf(a.kind)>=0;}

function inventoryRiskNotificationPlan_(report, previous) {
  previous=previous || {};var entries={},changed=[];
  var today=new Date(Date.parse(report.generatedAt)+9*3600000).toISOString().slice(0,10);
  report.alerts.filter(function(alert){return inventoryRiskActionableAlert_(alert) && (!report.sourceUnavailable || alert.kind==='source_unavailable');}).forEach(function(alert){
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
  // Only physical shortages and actual return/checkout collisions require this channel.
  // Other findings remain available to the AI and operations view, never relabelled as shortages.
  function actionable(a){return inventoryRiskActionableAlert_(a);}
  var deferred=report.alerts.some(function(a){return !actionable(a);});
  report=Object.assign({},report,{alerts:report.alerts.filter(function(a){return actionable(a);})});
  plan=Object.assign({},plan,{changed:plan.changed.filter(function(a){return actionable(a);})});
  report.conflictCount=report.alerts.filter(function(a){return a.kind==='shortage';}).length;
  report.riskCount=report.alerts.filter(function(a){return a.kind!=='shortage';}).length;
  if(deferred && !report.alerts.length)return null;
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
    if(a.kind==='catalog_stock_missing')lines.push('　대표님, 실제 몇 개 보유 중인가요? 수리 중 수량이 있으면 함께 이 스레드에 답해주세요. 답변을 재고 원장·장비마스터에 반영합니다.');
    if(a.candidates?.length)lines.push('　이름 후보: '+a.candidates.slice(0,2).map(clean).join(' / '));
  });
  if(plan.changed.length>5)lines.push((plan.daily?'외 ':'외 변경 ')+(plan.changed.length-5)+'건');
  lines.push('<'+detailUrl+'|전체 위험·예약 보기>');
  return lines.join('\n');
}


/** Ephemeral period assessment; no RQ or schedule is written. */
function inventoryResolutionPreview_(plan,snapshot) {
  if(!plan || Object.keys(plan).some(function(k){return ['items','start','end'].indexOf(k)<0;}) ||
    !Array.isArray(plan.items) || !plan.items.length || plan.items.length>40)throw new Error('재고 판단 계획 형식 오류');
  ['start','end'].forEach(function(k){
    var value=plan[k],time=Date.parse(value);
    if(typeof value!=='string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\+09:00$/.test(value) || !Number.isFinite(time) ||
      new Date(time+9*3600000).toISOString().slice(0,19)!==value.slice(0,19))throw new Error('재고 판단 기간 오류');
  });
  if(Date.parse(plan.end)<=Date.parse(plan.start))throw new Error('재고 판단 기간 오류');
  var seen={},rows=[];
  function add(name,quantity,setName){rows.push({id:'preview-'+rows.length,name:name,quantity:quantity,setName:setName,start:plan.start,end:plan.end,status:'대기'});}
  plan.items.forEach(function(item){
    if(!item || Object.keys(item).some(function(k){return k!=='name' && k!=='quantity';}) || typeof item.name!=='string' || !item.name.trim() || item.name.length>200 ||
      inventoryRiskNumber_(item.quantity)!==item.quantity || item.quantity<1 || item.quantity>999 || seen[item.name])throw new Error('재고 판단 장비 오류');
    seen[item.name]=true;var set=snapshot.sets.find(function(s){return s.name===item.name;});
    add(item.name,item.quantity,set?item.name:'');
    (set?.components || []).forEach(function(c){
      var qty=inventoryRiskNumber_(c.quantity);add(c.name,qty===null?null:qty*item.quantity,item.name);
    });
  });
  return {id:'preview',preview:true,customer:'',rows:rows};
}

/** Read-only evidence for native AI; the model owns identity and model selection. */
function getInventoryResolutionContext(options) {
  options=options || {};
  if(Object.keys(options).some(function(k){return k!=='requestId' && k!=='plan';}) ||
    (options.requestId && options.plan) || (options.requestId && !/^RQ-\d{6}-\d{3}$/.test(options.requestId)))throw new Error('재고 판단 조회 형식 오류');
  var snapshot=readInventoryRiskSnapshot_();
  var result={schema:'inventory-resolution-context/v1',mode:'read_only',decidedBy:'native_ai',
    equipment:snapshot.equipment,sets:snapshot.sets,semanticScopes:snapshot.semanticScopes || [],sourceIssues:snapshot.sourceIssues || [],
    guidance:'이 자료는 판단 근거다. 코드 후보는 추천일 뿐이다. AI가 원문, 전체 카탈로그, 세트 구성과 용도를 비교해 선택한다. 구성품과 별도 대여품을 구분하고, 의미 있는 선택만 고객에게 묻는다. 판매 카탈로그에 있지만 재고 기록이 없는 경우는 매칭 실패나 품절로 단정하지 않는다.'};
  if(options.requestId || options.plan) {
    var request=options.plan?inventoryResolutionPreview_(options.plan,snapshot):preRegistrationStockRequest_(options.requestId,true,true);
    result.request=request;result.evaluation=request?preRegistrationStockEvaluate_(request,snapshot):null;
    result.modelChoices=[];
    if(request && !request.registered)request.rows.forEach(function(row){
      var candidates=snapshot.equipment.filter(function(item){return inventoryRiskNameKey_(item.category)===inventoryRiskNameKey_(row.name);});
      if(!candidates.length)return;
      result.modelChoices.push({rowId:row.id,setName:row.setName,name:row.name,quantity:row.quantity,truncated:candidates.length>8,
        candidates:candidates.slice(0,8).map(function(item){
          var planned=Object.assign({},request,{rows:request.rows.map(function(r){return r.id===row.id?Object.assign({},r,{name:item.name}):r;})});
          var check=preRegistrationStockEvaluate_(planned,snapshot);
          return {id:item.id,name:item.name,stock:item.stock,maintenance:item.maintenance,status:item.status,
            shortages:check.shortages.filter(function(a){return a.equipment===item.name;}),
            uncertainty:check.uncertain.filter(function(a){return a.equipment===item.name;})};
        })});
    });
  }
  return result;
}
