/** Physical identity is equipment-master B (ID), never a sales/catalog spelling.
 * Reviewed aliases are references to that ID, not new stock or fuzzy matches.
 */
var INVENTORY_IDENTITY_REQUEST_ = null;

function inventoryIdentityEnrich_(equipment) {
  var cfg = SUPA_CFG_(), token = supaToken_(cfg);
  if (!token) throw new Error('장비 ID 연결 원장 인증 확인 필요');
  var cache = CacheService.getScriptCache();
  function read(key, table, query, ttl) {
    var text = cache.get(key);
    if (text) return JSON.parse(text);
    var rows = inventoryRiskDbRows_(cfg, token, table, query);
    try { cache.put(key, JSON.stringify(rows), ttl); } catch (cacheError) {}
    return rows;
  }
  var ledger = read('inventory_risk_ledger_aliases_v2', 'equipment_ledger',
    'select=equipment_id,name,aliases,stock_total,stock_maint,state,verify_status&order=equipment_id', 60);
  var links = read('inventory_identity_links_v1', 'inventory_identity_aliases',
    'select=source_name,equipment_id,equipment_name&order=source_name', 30);
  inventoryRiskEnrichLedger_(equipment, ledger, links);
  return equipment;
}

function inventoryIdentityCatalog_(equipSheet) {
  if(!equipSheet && INVENTORY_IDENTITY_REQUEST_)return INVENTORY_IDENTITY_REQUEST_.catalog;
  if (!equipSheet) equipSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('장비마스터');
  if (!equipSheet) throw new Error('장비마스터 없음');
  var sheetKey=typeof equipSheet.getSheetId==='function'?equipSheet.getSheetId():equipSheet;
  if (INVENTORY_IDENTITY_REQUEST_ && INVENTORY_IDENTITY_REQUEST_.sheetKey === sheetKey)
    return INVENTORY_IDENTITY_REQUEST_.catalog;
  var rows = typeof getEquipMasterRows_ === 'function' ? getEquipMasterRows_(equipSheet)
    : equipSheet.getRange(2, 1, Math.max(0, equipSheet.getLastRow() - 1), 12).getValues();
  var equipment = rows.filter(function(r) { return r[1] && r[3]; }).map(function(r) {
    return { id: String(r[1]).trim(), name: String(r[3]).trim(), category: r[2] || '',
      stock: r[4], maintenance: r[7], status: r[8] || '', unitPrice: r[11] || 0, aliases: [] };
  });
  var sourceIssues=[];
  try { inventoryIdentityEnrich_(equipment); }
  catch(identitySourceError) { sourceIssues.push('장비 ID 별칭 원장 조회 실패'); }
  var catalog = inventoryRiskIdentity_(equipment);
  catalog.equipment = equipment;
  catalog.sourceIssues = sourceIssues;
  INVENTORY_IDENTITY_REQUEST_ = { sheetKey: sheetKey, catalog: catalog };
  return catalog;
}

function inventoryIdentityName_(name, catalog) {
  var text = String(name || '').trim();
  var match = (catalog || inventoryIdentityCatalog_()).resolve(text);
  if (match.candidates.length > 1) throw new Error('AMBIGUOUS_INVENTORY_IDENTITY: ' + text);
  return match.item ? match.item.name : text;
}

function inventoryIdentitySame_(left, right) {
  var catalog=inventoryIdentityCatalog_(),a=catalog.resolve(left),b=catalog.resolve(right);
  if(b.candidates.length>1 || a.candidates.length>1 && b.item && a.candidates.indexOf(b.item.name)>=0)
    throw new Error('AMBIGUOUS_INVENTORY_IDENTITY: '+(b.candidates.length>1?right:left));
  if(a.item && b.item)return a.item.id===b.item.id;
  return String(left || '').trim()===String(right || '').trim();
}

function inventoryIdentityMatchesAny_(name, names, catalog) {
  catalog=catalog || inventoryIdentityCatalog_();
  var source=catalog.resolve(name);
  return (names || []).some(function(target){
    var item=catalog.resolve(target).item;
    return item ? source.item?.id===item.id || source.candidates.indexOf(item.name)>=0
      : inventoryRiskNameKey_(name)===inventoryRiskNameKey_(target);
  });
}

function inventoryIdentityRelatedNames_(names) {
  var catalog = inventoryIdentityCatalog_(), out = (names || []).slice();
  (names || []).forEach(function(name) {
    var item = catalog.resolve(name).item;
    if (item) out = out.concat(item.name, item.aliases || []);
  });
  return Array.from(new Set(out));
}

function inventoryIdentityVersion_() {
  var raw=JSON.stringify(inventoryIdentityCatalog_().equipment.map(function(e){return [e.id,e.name,e.aliases];}));
  return Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,raw)).slice(0,24);
}

function inventoryIdentityBindings_(plan) {
  var catalog=inventoryIdentityCatalog_();
  return (plan || []).map(function(row){
    var name=String(row.name || '').trim(),match=catalog.resolve(name);
    return {sourceName:name,quantity:Number(row.quantity || row.qty)||1,
      equipmentId:match.item?match.item.id:null,canonicalName:match.item?match.item.name:null,
      status:catalog.sourceIssues.length?'unverified':match.item?'linked':match.candidates.length?'ambiguous':'unresolved'};
  });
}

function inventoryIdentityMeta_(meta, equipSheet) {
  var catalog = inventoryIdentityCatalog_(equipSheet);
  meta.identityNames = {};
  meta.identityConflicts = {};
  meta.identitySourceIssues = catalog.sourceIssues.slice();
  catalog.equipment.forEach(function(item) {
    var info = { total: Number(item.stock) || 0, maintenance: Number(item.maintenance) || 0,
      category: item.category, 단가: item.unitPrice, equipmentId: item.id,
      canonicalName: item.name, aliases: (item.aliases || []).slice() };
    [item.name].concat(item.aliases || []).forEach(function(name) {
      var match = catalog.resolve(name);
      if (!match.item) {
        delete meta.equipment[name];
        meta.identityConflicts[inventoryRiskNameKey_(name)]=match.candidates;
        return;
      }
      meta.equipment[name] = info;
      meta.identityNames[inventoryRiskNameKey_(name)] = item.name;
    });
  });
  return meta;
}

function inventoryIdentityRows_(rows, catalog, sourceRows) {
  catalog = catalog || inventoryIdentityCatalog_();
  function key(r) {
    return JSON.stringify([r.contractID || '', r.setName || '',
      r.startDT && r.startDT.getTime(), r.endDT && r.endDT.getTime()]);
  }
  var explicitBodies = {};
  (sourceRows || rows || []).forEach(function(r) {
    var name = r.sourceEquipment || r.equipment, item = catalog.resolve(name).item;
    if (item && r.setName && name !== r.setName)
      explicitBodies[key(r) + '|' + item.id] = true;
  });
  return (rows || []).filter(function(r) {
    var name = r.sourceEquipment || r.equipment, item = catalog.resolve(name).item;
    return !(item && r.setName === name && explicitBodies[key(r) + '|' + item.id]);
  }).map(function(r) {
    var name = r.sourceEquipment || r.equipment, match = catalog.resolve(name);
    if (match.candidates.length > 1)return Object.assign({},r,{identityCandidates:match.candidates,
      identityError:'AMBIGUOUS_INVENTORY_IDENTITY'});
    return match.item ? Object.assign({}, r, { sourceEquipment: name, equipment: match.item.name,
      equipmentId: match.item.id }) : r;
  });
}

function inventoryIdentityAllocationRows_(rows) {
  var catalog=inventoryIdentityCatalog_();
  return (rows || []).filter(function(r){
    if(!r[2] || r[2]!==r[3])return true;
    var children=rows.filter(function(other){return other[1]===r[1] && other[2]===r[2] &&
      other[3]!==r[3] && JSON.stringify(other.slice(5,9))===JSON.stringify(r.slice(5,9));});
    if(!children.length)return true;
    var main=catalog.resolve(r[3]).item;
    return !!main && !children.some(function(child){return catalog.resolve(child[3]).item?.id===main.id;});
  });
}

function getInventoryIdentityCatalog() {
  var catalog = inventoryIdentityCatalog_();
  return { success: !catalog.sourceIssues.length, mode: 'read_only', source: '장비마스터.장비ID', sourceIssues:catalog.sourceIssues,
    equipment: catalog.equipment.map(function(e) {
      return { equipmentId: e.id, canonicalName: e.name, aliases: e.aliases || [] };
    }) };
}
