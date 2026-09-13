/** Read-only inventory risk arithmetic. Sales names/prices and bookings are never rewritten. */
function inventoryRiskNameKey_(value) {
  return String(value == null ? '' : value).normalize('NFKC').toLowerCase().replace(/[^0-9a-z가-힣]/g, '');
}

function inventoryRiskNumber_(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  var number = Number(value);
  return Number.isFinite(number) && number >= 0 && Number.isInteger(number) ? number : null;
}

function inventoryRiskIdentity_(equipment) {
  var keys = {}, exact = {}, byId = {};
  (equipment || []).forEach(function(item) {
    var id = String(item.id || '');
    if (!id || !item.name) return;
    byId[id] = item;
    exact[String(item.name)] = exact[String(item.name)] || [];
    if (exact[String(item.name)].indexOf(id) < 0) exact[String(item.name)].push(id);
    [item.name].concat(item.aliases || []).forEach(function(name) {
      var key = inventoryRiskNameKey_(name);
      if (!key) return;
      keys[key] = keys[key] || [];
      if (keys[key].indexOf(id) < 0) keys[key].push(id);
    });
  });
  return {
    byId: byId,
    resolve: function(name) {
      var ids = exact[String(name)] || keys[inventoryRiskNameKey_(name)] || [];
      return {item: ids.length === 1 ? byId[ids[0]] : null, candidates: ids.map(function(id) {return byId[id].name;})};
    }
  };
}

function inventoryRiskCandidates_(name, equipment) {
  // Suggestions never allocate inventory or establish identity.
  var key = inventoryRiskNameKey_(name);
  if (key.length < 3) return [];
  var grams = {};
  for (var i = 0; i < key.length - 1; i++) grams[key.slice(i, i + 2)] = true;
  return (equipment || []).map(function(item) {
    var target = inventoryRiskNameKey_(item.name), count = 0;
    Object.keys(grams).forEach(function(g) {if (target.indexOf(g) >= 0) count++;});
    return {name:item.name, score:count / Math.max(1, Object.keys(grams).length)};
  }).filter(function(item) {return item.score >= 0.55;})
    .sort(function(a,b) {return b.score-a.score || a.name.localeCompare(b.name);})
    .slice(0,4).map(function(item) {return item.name;});
}

function inventoryRiskBooking_(row) {
  return {scheduleId:row.id, tradeId:row.tradeId, customer:row.customer || '', name:row.name,
    quantity:row.quantity, start:row.start, end:row.end};
}

function inventoryRiskSweep_(rows, stock, from, until, bufferMs, kind) {
  var events = {};
  function event(time, action, row) {
    if (!events[time]) events[time] = [];
    events[time].push({action:action,row:row});
  }
  rows.forEach(function(row) {
    var start = Math.max(from, row.startMs), end = Math.min(until, row.endMs + bufferMs);
    if (start >= end) return;
    event(start,1,row); event(end,-1,row);
  });
  var times=Object.keys(events).map(Number).sort(function(a,b){return a-b;}), active={}, found=[], segment=null;
  for(var i=0;i<times.length-1;i++) {
    var t=times[i], next=times[i+1];
    events[t].forEach(function(e){if(e.action<0) delete active[e.row.key];});
    events[t].forEach(function(e){if(e.action>0) active[e.row.key]=e.row;});
    var at=Object.keys(active).map(function(key){return active[key];});
    var quantity=at.reduce(function(sum,r){return sum+r.quantity;},0);
    var actual=at.filter(function(r){return r.endMs>t;}).reduce(function(sum,r){return sum+r.quantity;},0);
    var unsafe=kind==='capacity_tight' ? stock>0 && quantity>=stock*0.9 && quantity<=stock
      : quantity>stock && (kind!=='turnaround' || actual<=stock);
    if(!unsafe) {segment=null; continue;}
    if(!segment) {
      segment={kind:kind,severity:kind==='shortage'?'conflict':'risk',stock:stock,booked:0,shortage:0,
        windowStart:new Date(t).toISOString(),windowEnd:new Date(next).toISOString()};
      found.push(segment);
    }
    segment.windowEnd=new Date(next).toISOString();
    if(quantity>segment.booked) {
      segment.booked=quantity; segment.shortage=Math.max(0,quantity-stock);
      segment.start=new Date(t).toISOString(); segment.end=new Date(next).toISOString();
      segment.bookings=at.map(inventoryRiskBooking_).sort(function(a,b){return String(a.scheduleId).localeCompare(String(b.scheduleId));});
      segment.sourceNames=Array.from(new Set(at.map(function(r){return r.name;})));
    }
  }
  return found;
}

function buildInventoryRiskReport_(snapshot, options) {
  options=options || {};
  var now=Date.parse(options.now || new Date().toISOString());
  if(!Number.isFinite(now)) throw new Error('재고 점검 시각 오류');
  var today=new Date(now+9*3600000).toISOString().slice(0,10);
  var from=Date.parse(today+'T00:00:00+09:00');
  var bufferMinutes=options.turnaroundMinutes === undefined ? 60 : Number(options.turnaroundMinutes);
  if(!Number.isFinite(bufferMinutes) || bufferMinutes<0 || bufferMinutes>1440) throw new Error('반납 여유시간 오류');
  var bufferMs=bufferMinutes*60000, alerts=[], equipment=snapshot.equipment || [];
  var identity=inventoryRiskIdentity_(equipment), sets={}, groups={}, expanded={}, omitted={}, demands=[], complete=true;
  var relevant=[], coverageEnd=now, skipped=0;
  function risk(kind,row,extra) {
    complete=false;
    var issue={kind:kind,severity:'risk',equipment:row.name || '',equipmentId:null,start:row.start || null,end:row.end || null,
      bookings:[inventoryRiskBooking_(row)],sourceNames:[row.name || '']};
    Object.keys(extra || {}).forEach(function(key){issue[key]=extra[key];}); alerts.push(issue);
  }
  (snapshot.sets || []).forEach(function(set){sets[inventoryRiskNameKey_(set.name)]=set;});
  function groupKey(row,setKey) {return [row.tradeId,setKey,row.start,row.end].join('|');}
  // Remember explicit expansion even when every component was returned/excluded.
  (snapshot.schedules || []).forEach(function(row){
    var setKey=inventoryRiskNameKey_(row.setName);
    if(sets[setKey] && inventoryRiskNameKey_(row.name)!==setKey) {
      var key=groupKey(row,setKey);expanded[key]=true;
      if(['제외','반납완료'].indexOf(String(row.status || ''))>=0 || row.returned===true)
        (omitted[key] || (omitted[key]=[])).push(row.name);
    }
  });
  (snapshot.schedules || []).forEach(function(raw,index) {
    var row=Object.assign({},raw), status=String(row.status || ''), tradeStatus=String(row.tradeStatus || '');
    if(['취소','거절','반납완료','제외'].indexOf(status)>=0 || ['취소','거절','반납완료'].indexOf(tradeStatus)>=0 || row.returned===true) {skipped++;return;}
    row.quantity=inventoryRiskNumber_(row.quantity);
    if(row.quantity===0) {skipped++;return;}
    row.startMs=Date.parse(row.start || ''); row.endMs=Date.parse(row.end || '');
    row.key=String(row.id || 'row-'+index)+'|'+index;
    var checkedOut=row.checkedOut===true || ['반출','반출완료','대여중'].indexOf(status)>=0;
    if(Number.isFinite(row.endMs) && row.endMs+bufferMs<=from && !checkedOut) {skipped++;return;}
    if(row.quantity===null) {risk('invalid_quantity',row);return;}
    if(!Number.isFinite(row.startMs)||!Number.isFinite(row.endMs)||row.endMs<=row.startMs) {risk('invalid_schedule',row);return;}
    row.overdue=checkedOut && row.endMs<now;
    coverageEnd=Math.max(coverageEnd,row.endMs);
    relevant.push(row);
    var setKey=inventoryRiskNameKey_(row.setName || row.name), set=sets[setKey];
    if(set && (set.components || []).length) {
      var key=groupKey(row,setKey);
      if(!groups[key]) groups[key]={set:set,headers:[],components:[]};
      var header=inventoryRiskNameKey_(row.name)===setKey;
      groups[key][header?'headers':'components'].push(row);
      row.setGroup=key; row.setHeader=header;
    }
  });
  coverageEnd=Math.max(coverageEnd,now+bufferMs+1);
  function allocate(row) {
    var policyItem=identity.resolve(row.name).item;
    if(typeof inventorySupplyExcluded_==='function' && inventorySupplyExcluded_(row.name,policyItem?.category))return;
    if(row.note && /^\[(외부조달|상위대체)\]/m.test(row.note) && typeof inventorySupplyPhysicalRows_==='function') {
      try {
        var physical=inventorySupplyPhysicalRows_({equipment:row.name,qty:row.quantity,startDT:new Date(row.startMs),endDT:new Date(row.endMs),note:row.note});
        physical.forEach(function(p,i){allocate(Object.assign({},row,{key:row.key+'|supply-'+i,name:p.equipment,quantity:p.qty,note:''}));});
      } catch(error){risk('invalid_supply_allocation',row,{message:String(error.message || error)});allocate(Object.assign({},row,{note:''}));}
      return;
    }
    // A missing return checkbox is not proof of continuing possession. Keep it
    // visible as uncertainty without extending a past reservation into November.
    if(row.overdue && row.endMs<=from) {risk('overdue_return',row);return;}
    var match=identity.resolve(row.name);
    if(!match.item) {
      risk(match.candidates.length?'ambiguous_equipment':'unknown_equipment',row,
        {candidates:match.candidates.length?match.candidates:inventoryRiskCandidates_(row.name,equipment)});
      return;
    }
    var item=match.item;
    if(row.overdue) risk('overdue_return',row,{equipment:item.name,equipmentId:item.id});
    row.equipmentId=item.id; demands.push(row);
  }
  relevant.forEach(function(row) {
    var group=row.setGroup?groups[row.setGroup]:null;
    if(row.setHeader) {
      if(expanded[row.setGroup]) return;
      group.set.components.forEach(function(component,index) {
        if(component.tracked===false) return;
        var q=inventoryRiskNumber_(component.quantity);
        if(q===null) {risk('invalid_set_component',row,{component:component.name});return;}
        if(!q) return;
        allocate(Object.assign({},row,{key:row.key+'|component-'+index,name:component.name,quantity:row.quantity*q}));
      });
      return;
    }
    if(group) {
      var component=group.set.components.find(function(c){return inventoryRiskNameKey_(c.name)===inventoryRiskNameKey_(row.name);});
      if(component && component.tracked===false) return;
    }
    allocate(row);
  });
  // Expanded schedules are authoritative: flag missing tracked components instead
  // of inventing an allocation that could contradict an intentional substitution.
  Object.keys(groups).forEach(function(key) {
    var group=groups[key];
    if(!group.headers.length || !group.components.length || group.headers[0].endMs<from) return;
    group.set.components.forEach(function(c) {
      if(c.tracked===false || (typeof inventorySupplyExcluded_==='function' && inventorySupplyExcluded_(c.name,identity.resolve(c.name).item?.category))) return;
      var expected=identity.resolve(c.name).item;
      if(!expected) return;
      var present=group.components.some(function(r){return identity.resolve(r.name).item?.id===expected.id;}) ||
        (omitted[key] || []).some(function(name){return identity.resolve(name).item?.id===expected.id;});
      if(!present) risk('set_component_missing',group.headers[0],{component:c.name});
    });
  });
  var pools={};
  // Internal consumers reuse the same expanded, aliased, physically allocated rows.
  // JSON API callers cannot supply this callback.
  if(typeof options.onDemands==='function')options.onDemands(demands,identity);
  demands.forEach(function(row){if(!pools[row.equipmentId])pools[row.equipmentId]=[];pools[row.equipmentId].push(row);});
  Object.keys(pools).forEach(function(id) {
    var item=identity.byId[id], stock=inventoryRiskNumber_(item.stock), maint=inventoryRiskNumber_(item.maintenance);
    if(stock===null || maint===null || maint>stock) {risk('unknown_stock',pools[id][0],{equipment:item.name,equipmentId:id});return;}
    if(['정비중','수리중'].indexOf(item.status)>=0 && maint===0) risk('maintenance_unquantified',pools[id][0],{equipment:item.name,equipmentId:id});
    var available=Math.max(0,stock-maint);
    inventoryRiskSweep_(pools[id],available,from,coverageEnd,0,'shortage')
      .concat(bufferMs?inventoryRiskSweep_(pools[id],available,from,coverageEnd+bufferMs,bufferMs,'turnaround'):[])
      .concat(inventoryRiskSweep_(pools[id],available,from,coverageEnd,0,'capacity_tight'))
      .forEach(function(alert){alert.equipment=item.name;alert.equipmentId=id;alert.totalStock=stock;alert.maintenance=maint;alerts.push(alert);});
  });
  // One warning per unresolved return / unknown identity, retaining every source row.
  var grouped={},compact=[];
  alerts.forEach(function(alert){
    var key=alert.kind==='overdue_return'?'return|'+alert.bookings[0].tradeId
      : alert.kind==='unknown_equipment' || alert.kind==='ambiguous_equipment' ? alert.kind+'|'+inventoryRiskNameKey_(alert.equipment):'';
    if(!key){compact.push(alert);return;}
    if(grouped[key]){grouped[key].bookings=grouped[key].bookings.concat(alert.bookings);grouped[key].sourceNames=Array.from(new Set(grouped[key].sourceNames.concat(alert.sourceNames)));return;}
    if(alert.kind==='overdue_return'){alert.equipment=(alert.bookings[0].customer || alert.bookings[0].tradeId)+' · 반납 기록';alert.equipmentId=null;}
    grouped[key]=alert;compact.push(alert);
  });
  alerts=compact;
  alerts.forEach(function(alert) {
    var ids=alert.bookings.map(function(b){return String(b.scheduleId || b.tradeId);}).sort();
    alert.key=[alert.kind,alert.equipmentId || inventoryRiskNameKey_(alert.equipment),ids.join(','),alert.component || '',alert.windowStart || ''].join('|');
  });
  alerts.sort(function(a,b){return (a.severity==='conflict'?0:1)-(b.severity==='conflict'?0:1) || String(a.start || '').localeCompare(String(b.start || '')) || a.key.localeCompare(b.key);});
  return {schema:'inventory-risk-report/v1',success:true,generatedAt:new Date(now).toISOString(),
    coverage:{start:new Date(from).toISOString(),end:new Date(coverageEnd).toISOString(),allFuture:true,complete:complete,schedules:relevant.length,skipped:skipped},
    inventoryPolicy:typeof getInventorySupplyPolicy==='function'?getInventorySupplyPolicy():null,
    turnaroundMinutes:bufferMinutes,conflictCount:alerts.filter(function(a){return a.kind==='shortage';}).length,
    riskCount:alerts.filter(function(a){return a.kind!=='shortage';}).length,alerts:alerts};
}
