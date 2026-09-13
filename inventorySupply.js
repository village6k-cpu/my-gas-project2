/** Shared physical supply policy. Sales names, quantities and set-master prices stay intact. */
function getInventorySupplyPolicy() {
  return {version:1, upgrades:[{requestedName:'소니 GM 70-200mm',providedName:'소니 GM 70-200mm II'}],
    exclusions:['메모리','배터리'], externalSupply:'예약 품목·기간별 확정 수량만 자체 재고에서 제외',
    pricing:'요청한 세트마스터 품목의 단가 유지'};
}

function inventorySupplyExcluded_(name, category) {
  var n=String(name || '').normalize('NFKC').trim();
  if (/^(메모리|메모리카드|배터리)$/.test(String(category || '').trim())) return true;
  // Match standalone consumables, never a camera/set merely mentioning a battery.
  return /^(?:(?:소니|샌디스크|삼성|렉사)\s*)?(?:CF-?A\s*\d+|CFexpress\s*(?:Type\s*)?[AB]?\s*\d+|XQD\s*\d+|(?:micro\s*)?SD(?:XC|HC)?\s*\d+|메모리(?:카드)?(?:\s*\d+)?)(?:\s*(?:GB|TB|기가))?$/i.test(n) ||
    /^(?:NP-FZ100|NP-F970|NP-F750|LP-E6(?:N|NH)?|BP-U\d+|(?:V|v|브이)\s*마운트\s*배터리|\d+\s*배터리|배터리)(?:\s*\(전체\))?$/i.test(n);
}

function inventorySupplyUpgrade_(from,to) {
  return getInventorySupplyPolicy().upgrades.some(function(r){return r.requestedName===from && r.providedName===to;});
}

function inventorySupplyRelatedNames_(names) {
  var all=(names || []).slice();
  getInventorySupplyPolicy().upgrades.forEach(function(r){
    if(all.indexOf(r.requestedName)>=0 || all.indexOf(r.providedName)>=0)all=all.concat([r.requestedName,r.providedName]);
  });
  return Array.from(new Set(all));
}

function inventorySupplyClock_(date) {
  var ms=new Date(date).getTime();
  if(!Number.isFinite(ms))throw new Error('재고 배정 기간 오류');
  return new Date(ms+9*3600000).toISOString().slice(0,16).replace('T',' ');
}

function inventorySupplyPeriod_(row) {
  return inventorySupplyClock_(row.startDT)+' ~ '+inventorySupplyClock_(row.endDT);
}

function inventorySupplyAllocations_(row) {
  var parts=[],sum=0;
  String(row.note || '').split(/\r?\n/).forEach(function(line){
    if(!/^\[(외부조달|상위대체)\]/.test(line))return;
    var m=/^\[(외부조달|상위대체)\] (.+?) \| (.+?) \| ([1-9]\d*)대 \| (.+)$/.exec(line);
    if(!m || m[5]!==inventorySupplyPeriod_(row))throw new Error('재고 배정 기록의 기간·형식 확인 필요');
    var a={source:m[1]==='외부조달'?'external':'own',qty:Number(m[4]),name:m[3]};
    if(a.source==='external'){
      a.supplier=m[2];
      if(a.name!==row.equipment)throw new Error('재고 배정 외부 조달 품목 확인 필요');
    } else {
      if(m[2]!==row.equipment || !inventorySupplyUpgrade_(m[2],m[3]))throw new Error('재고 배정 상위 대체 관계 확인 필요');
    }
    sum+=a.qty;parts.push(a);
  });
  if(sum>Number(row.qty))throw new Error('재고 배정 수량이 예약 수량을 초과합니다');
  return parts;
}

function inventorySupplyNote_(previous,row,allocations) {
  var text=String(previous || '').split(/\r?\n/).filter(function(l){return !/^\[(외부조달|상위대체)\]/.test(l);}).join('\n').trim();
  var lines=(allocations || []).filter(function(a){return a.source==='external'||a.name!==row.equipment;}).map(function(a){
    if(!Number.isInteger(a.qty)||a.qty<1 || /[|\r\n]/.test(a.name || '') || /[|\r\n]/.test(a.supplier || '') || /[|\r\n]/.test(row.equipment || ''))throw new Error('재고 배정 품목·수량 형식 오류');
    if(a.source==='external' && !String(a.supplier || '').trim())throw new Error('재고 배정 외부 공급처 필요');
    if(a.source!=='external'&&!inventorySupplyUpgrade_(row.equipment,a.name))throw new Error('승인된 상위 기종 대체만 가능합니다');
    return '['+(a.source==='external'?'외부조달':'상위대체')+'] '+(a.source==='external'?a.supplier:row.equipment)+' | '+a.name+' | '+a.qty+'대 | '+inventorySupplyPeriod_(row);
  });
  var note=[text].concat(lines).filter(Boolean).join('\n');
  inventorySupplyAllocations_(Object.assign({},row,{note:note}));
  return note;
}

function inventorySupplyPhysicalRows_(row) {
  var allocations=inventorySupplyAllocations_(row),used=0,out=[];
  allocations.forEach(function(a){used+=a.qty;if(a.source!=='external')out.push(Object.assign({},row,{equipment:a.name,qty:a.qty,note:'',requestedName:row.equipment}));});
  if(Number(row.qty)>used)out.unshift(Object.assign({},row,{qty:Number(row.qty)-used,note:''}));
  return out;
}

function inventorySupplyAvailabilityRows_(row) {
  try {return inventorySupplyPhysicalRows_(row);}
  catch(error) {
    // A malformed allocation affects only overlapping requests for this supply family.
    return inventorySupplyRelatedNames_([row.equipment]).map(function(name){
      return Object.assign({},row,{equipment:name,supplyError:String(error.message || error),note:''});
    });
  }
}

function inventorySupplyPlan_(items,start,end,meta,schedule) {
  var conflicts=[],warnings=[],allocations=[],equipment=meta.equipment || {},reserved={};
  // Reserve exact upper-model requests first. Flexible lower models use the remainder.
  var order=(items || []).slice().sort(function(a,b){
    return (getInventorySupplyPolicy().upgrades.some(function(r){return r.requestedName===a.name;})?1:0)-
      (getInventorySupplyPolicy().upgrades.some(function(r){return r.requestedName===b.name;})?1:0);
  });
  function free(name) {
    var info=equipment[name];if(!info)return 0;
    var at=[start.getTime()],over=(schedule || []).filter(function(s){return s.equipment===name && s.status!=='반납완료'&&s.status!=='취소'&&s.startDT<end&&s.endDT>start;});
    over.forEach(function(s){if(s.startDT>start)at.push(s.startDT.getTime());});
    var peak=0;at.forEach(function(t){var sum=0;over.forEach(function(s){if(s.startDT.getTime()<=t&&s.endDT.getTime()>t)sum+=Number(s.qty)||0;});peak=Math.max(peak,sum);});
    return Math.max(0,(Number(info.total)||0)-(Number(info.maintenance)||0)-peak-(reserved[name]||0));
  }
  order.forEach(function(item){
    var name=String(item.name || '').trim(),qty=Number(item.qty)||1,info=equipment[name];
    if(inventorySupplyExcluded_(name,info?.category))return;
    var related=inventorySupplyRelatedNames_([name]);
    var invalid=(schedule || []).find(function(s){return s.supplyError && related.indexOf(s.equipment)>=0 && s.startDT<end && s.endDT>start;});
    if(invalid){conflicts.push({equipment:name,message:invalid.supplyError,code:'INVALID_SUPPLY_ALLOCATION'});return;}
    if(!info){
      if(meta.categories?.[name])conflicts.push({equipment:name,message:name+' 모델 선택 필요'});
      else warnings.push({equipment:name,message:name+' 미등록, 가용확인 제외'});
      return;
    }
    var candidates=[name].concat(getInventorySupplyPolicy().upgrades.filter(function(r){return r.requestedName===name;}).map(function(r){return r.providedName;}));
    var remaining=qty,ownFree=free(name);
    candidates.forEach(function(provided){
      var quantity=Math.min(remaining,free(provided));if(!quantity)return;
      allocations.push({requestedName:name,name:provided,qty:quantity,source:'own'});
      reserved[provided]=(reserved[provided]||0)+quantity;remaining-=quantity;
    });
    if(remaining)conflicts.push({equipment:name,total:Number(info.total)||0,available:qty-remaining,requested:qty,
      message:name+' 가용 '+(qty-remaining)+'/'+qty+(candidates.length>1?' (상위 대체 포함)':'')});
    else if(ownFree<qty)warnings.push({equipment:name,message:name+' 상위 기종 대체 '+(qty-ownFree)+'대',kind:'upgrade_allocated'});
  });
  return {ok:!conflicts.length,conflicts:conflicts,warnings:warnings,allocations:allocations};
}

/** Apply a plan to row notes at the same atomic sheet write as the reservation. */
function inventorySupplyApplyRows_(rows,plan) {
  var remaining=(plan?.allocations || []).map(function(a){return Object.assign({},a);});
  var namesWithComponents={};rows.forEach(function(r){if(r[2]&&r[2]!==r[3])namesWithComponents[r[2]]=true;});
  rows.forEach(function(r){
    if(r[2]===r[3]&&namesWithComponents[r[3]])return;
    var qty=Number(r[4]),parts=[];
    remaining.forEach(function(a){if(a.requestedName!==r[3]||!a.qty||!qty)return;var n=Math.min(qty,a.qty);parts.push(Object.assign({},a,{qty:n}));a.qty-=n;qty-=n;});
    if(parts.some(function(a){return a.name!==r[3] || a.source==='external';}))r[10]=inventorySupplyNote_(r[10],{equipment:r[3],qty:r[4],startDT:parseDT(r[5],r[6]),endDT:parseDT(r[7],r[8])},parts);
  });
  return rows;
}

/** Exact CAS on the existing schedule row. Does not alter prices or checkout/return state. */
function setScheduleSupplyAllocation(args) {
  if(!args || !args.scheduleId || !args.expected || !Array.isArray(args.allocations))throw new Error('재고 배정 대상·기준선 필요');
  var lock=LockService.getScriptLock();if(!lock.tryLock(1000))return {success:false,retryable:true,error:'다른 변경 작업 처리 중'};
  try {
    var sheet=SpreadsheetApp.getActiveSpreadsheet().getSheetByName('스케줄상세');
    var found=sheet.getRange(2,1,sheet.getLastRow()-1,1).createTextFinder(args.scheduleId).matchEntireCell(true).findAll();
    if(found.length!==1)throw new Error('재고 배정 스케줄ID가 유일하지 않습니다');
    var index=found[0].getRow(),r=sheet.getRange(index,1,1,13).getDisplayValues()[0];
    var row={equipment:r[3],qty:Number(r[4]),startDT:parseDT(r[5],r[6]),endDT:parseDT(r[7],r[8]),note:r[10]};
    var e=args.expected;
    if(r[1]!==e.tradeId || r[3]!==e.name || row.qty!==Number(e.qty) || inventorySupplyPeriod_(row)!==e.period || ['취소','반납완료'].indexOf(r[9])>=0)throw new Error('재고 배정 기준선 변경: 다시 조회 필요');
    var next=inventorySupplyNote_(row.note,row,args.allocations);
    if(row.note!==next && row.note!==String(e.note || ''))throw new Error('재고 배정 메모가 변경되었습니다');
    if(args.allocations.some(function(a){return a.source!=='external';}))throw new Error('상위 대체는 예약 가용성 검증 경로로 적용하세요');
    if(args.dryRun===true)return {success:true,dryRun:true,scheduleId:r[0],note:next,ownQuantity:inventorySupplyPhysicalRows_(Object.assign({},row,{note:next})).reduce(function(n,p){return n+p.qty;},0)};
    sheet.getRange(index,11).setValue(next);SpreadsheetApp.flush();
    if(sheet.getRange(index,11).getValue()!==next)throw new Error('재고 배정 읽기검증 실패');
    invalidateTimelineCache();
    if(typeof requestInventoryRiskScan_==='function')requestInventoryRiskScan_();
    supaMarkTradeDirty_(r[1]);
    return {success:true,scheduleId:r[0],tradeId:r[1],note:next,quantity:row.qty};
  } finally {lock.releaseLock();}
}
