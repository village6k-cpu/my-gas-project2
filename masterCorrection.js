function mcHash_(x){return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,JSON.stringify(x),Utilities.Charset.UTF_8).map(function(b){return ('0'+((b+256)%256).toString(16)).slice(-2);}).join('');}
const mcKey_=x=>x.normalize('NFC').trim().toLowerCase().replace(/\s+/g,'');
const mcFail_=m=>{throw new Error(m);};
const mcName_=x=>typeof x==='string'&&x.trim()===x&&x.length>0&&x.length<=160&&!/[\r\n\x00]/.test(x)&&!/^\s*[=+@]/.test(x);
function mcRevision_(s){return mcHash_(s);}
function mcValidate_(r){
 if(!/^[a-zA-Z0-9-]{16,80}$/.test(r.operationId||''))mcFail_('invalid operation id');
 if(r.scope!=='standing')mcFail_('standing scope required');
 if(r.source?.verifiedOwner!==true||!r.source.ref||!r.source.quote)mcFail_('verified owner source required');
 if(!mcName_(r.target))mcFail_('exact target required');
 if(!['price','create','component'].includes(r.kind))mcFail_('unsupported correction');
 if(['price','create'].includes(r.kind)&&(r.unit!=='KRW/day'||typeof r.price!=='number'||!Number.isSafeInteger(r.price)||r.price<0))mcFail_('explicit nonnegative integer daily price required');
}
function mcComponents_(r,s){
 if(!Array.isArray(r.components)||!r.components.length||r.components.length>50)mcFail_('complete components required');
 const seen=new Set();
 return r.components.map(c=>{
  if(!mcName_(c.name)||!Number.isSafeInteger(c.qty)||c.qty<1||c.qty>1000)mcFail_('invalid component');
  if(s.equipment.filter(n=>n===c.name).length!==1)mcFail_('unknown or duplicate equipment identity');
  if(seen.has(mcKey_(c.name)))mcFail_('duplicate component');seen.add(mcKey_(c.name));
  return [r.target,c.name,c.qty,'','','Y',''];
 });
}
function mcPlan_(r,s){
 mcValidate_(r);
 if(r.expectedRevision!==mcRevision_(s))mcFail_('master changed; refresh before applying');
 if(!Array.isArray(s.rows)||!Array.isArray(s.equipment)||s.rows.some(x=>!Array.isArray(x)||x.length!==7))mcFail_('invalid schema');
 const exact=s.rows.map((row,i)=>({row,i})).filter(x=>x.row[0]===r.target);
 if(s.rows.some(row=>row[0]!==r.target&&typeof row[0]==='string'&&mcKey_(row[0])===mcKey_(r.target)))mcFail_('ambiguous normalized target');
 const p={target:r.target,updates:[],append:[],beforeRevision:r.expectedRevision};
 if(r.kind==='create'){
  if(exact.length)mcFail_('target exists');
  p.append=mcComponents_(r,s);p.append[0][6]=r.price;
 }else{
  if(!exact.length)mcFail_('target missing');
  if(r.kind==='component'){
   p.append=mcComponents_(r,s);
   if(p.append.some(c=>exact.some(x=>mcKey_(String(x.row[1]))===mcKey_(c[1]))))mcFail_('component exists');
  }else{
   const cells=exact.filter(x=>x.row[6]!==''&&x.row[6]!==null);
   const prices=cells.map(x=>x.row[6]);
   if(prices.some(x=>typeof x!=='number'||!Number.isSafeInteger(x)||x<0)||new Set(prices).size>1)mcFail_('existing price conflict');
   if(prices.length&&prices[0]!==r.price&&!(r.replace?.approved===true&&r.replace.expectedPrice===prices[0]))mcFail_('existing price conflict requires approved replacement');
   const targets=cells.length?cells:[exact[0]];
   for(const x of targets){
    if(s.formulas?.[x.i]?.[6])mcFail_('formula price requires manual review');
    if(x.row[6]!==r.price)p.updates.push({row:x.i+2,col:7,value:r.price});
   }
  }
 }
 const after=JSON.parse(JSON.stringify(s));
 for(const u of p.updates)after.rows[u.row-2][u.col-1]=u.value;
 after.rows.push(...p.append);
 if(after.formulas)after.formulas.push(...p.append.map(()=>Array(7).fill('')));
 p.afterRevision=mcRevision_(after);
 return p;
}

// Narrow master write boundary. ScriptLock serializes this API, not manual Sheets edits.
function mcSnapshot_(ss) {
 const sh=ss.getSheetByName('세트마스터'), eq=ss.getSheetByName('장비마스터');
 if(!sh||!eq)mcFail_('master sheet missing');
 const header=sh.getRange(1,1,1,7).getValues()[0];
 if(JSON.stringify(header)!==JSON.stringify(['세트명','구성장비명','수량','비고','대체가능장비','가용체크(Y/N)','단가']))mcFail_('set schema changed');
 if(eq.getRange(1,4).getValues()[0][0]!=='장비명')mcFail_('equipment schema changed');
 const count=sh.getLastRow()-1;
 return {rows:count>0?sh.getRange(2,1,count,7).getValues():[],equipment:eq.getLastRow()>1?eq.getRange(2,4,eq.getLastRow()-1,1).getValues().map(x=>x[0]).filter(x=>x!==''):[],formulas:count>0?sh.getRange(2,1,count,7).getFormulas():[]};
}
function mcMatches_(ss,p){
 const sh=ss.getSheetByName('세트마스터');
 return p.updates.every(u=>sh.getRange(u.row,u.col).getValues()[0][0]===u.value)&&(!p.append.length||JSON.stringify(sh.getRange(p.appendStart,1,p.append.length,7).getValues())===JSON.stringify(p.append));
}
function masterCorrection_(input){
 const r=JSON.parse(JSON.stringify(input||{}));
 r.operationId=r.correctionId;delete r.correctionId;delete r.key;delete r.action;
 if(r.mode && !['preview','apply'].includes(r.mode))mcFail_('invalid mode');
 mcValidate_(r);
 if(typeof r.source.ref!=='string'||typeof r.source.quote!=='string'||r.source.ref.length>1000||r.source.quote.length>10000)mcFail_('source too long');
 const ss=SpreadsheetApp.getActiveSpreadsheet();
 if(r.mode!=='apply'){
  const snapshot=mcSnapshot_(ss);r.expectedRevision=mcRevision_(snapshot);
  const plan=mcPlan_(r,snapshot);
  if(plan.updates.length>1)mcFail_('multiple price cells require manual review');
  return {success:true,status:'preview',revision:r.expectedRevision,plan:plan,manualEditorRaceProtected:false};
 }
 const lock=LockService.getScriptLock();if(!lock.tryLock(20000))mcFail_('master correction busy');
 try{
  const digest=mcHash_(r),auditName='마스터정정이력';let audit=ss.getSheetByName(auditName);
  if(audit&&audit.getLastRow()>1){
   const rows=audit.getRange(2,1,audit.getLastRow()-1,8).getValues();
   for(let i=0;i<rows.length;i++)if(rows[i][0]===r.operationId){
    if(rows[i][1]!==digest)mcFail_('operation id payload mismatch');
    const oldPlan=JSON.parse(rows[i][7]);
    if(mcRevision_(mcSnapshot_(ss))!==oldPlan.afterRevision||!mcMatches_(ss,oldPlan))mcFail_('previous operation uncertain or later changed; manual review required');
    if(!['verified','synced'].includes(rows[i][2])){audit.getRange(i+2,3).setValue('verified');SpreadsheetApp.flush();}
    return mcFinishSync_(ss,audit,i+2,r,oldPlan,true);
   }
  }
  const snapshot=mcSnapshot_(ss),plan=mcPlan_(r,snapshot);
  if(plan.updates.length>1)mcFail_('multiple price cells require manual review');
  plan.appendStart=snapshot.rows.length+2;
  if(!audit){audit=ss.insertSheet(auditName);audit.getRange(1,1,1,8).setValues([['correctionId','digest','status','timestamp','sourceRef','sourceQuote','beforeRevision','planJson']]);}
  const row=audit.getLastRow()+1;
  // Prefix source text to prevent spreadsheet formula interpretation.
  audit.getRange(row,1,1,8).setValues([[r.operationId,digest,'prepared',new Date().toISOString(),'source: '+r.source.ref,'quote: '+r.source.quote,plan.beforeRevision,JSON.stringify(plan)]]);
  SpreadsheetApp.flush();
  // Recheck immediately before write. Manual editors are still not covered by ScriptLock.
  if(mcRevision_(mcSnapshot_(ss))!==plan.beforeRevision)mcFail_('master changed after prepare; no write');
  const sh=ss.getSheetByName('세트마스터');
  if(plan.updates.length){const u=plan.updates[0];sh.getRange(u.row,u.col,1,1).setValues([[u.value]]);}
  if(plan.append.length)sh.getRange(plan.appendStart,1,plan.append.length,7).setValues(plan.append);
  SpreadsheetApp.flush();
  if(mcRevision_(mcSnapshot_(ss))!==plan.afterRevision||!mcMatches_(ss,plan))mcFail_('master readback mismatch; manual review required');
  audit.getRange(row,3).setValue('verified');SpreadsheetApp.flush();
  return mcFinishSync_(ss,audit,row,r,plan,false);
 }finally{lock.releaseLock();}
}

function mcFinishSync_(ss,audit,row,r,plan,replay){
 const state=audit.getRange(row,3).getValues()[0][0];
 if(state==='synced'){
  const list=ss.getSheetByName('목록');
  const id=PropertiesService.getScriptProperties().getProperty('CONTRACT_TEMPLATE_ID');
  const template=id?SpreadsheetApp.openById(id).getSheets().find(x=>x.getName().indexOf('마스터')>=0):null;
  const rates=mcSnapshot_(ss).rows.filter(x=>x[0]===r.target&&x[6]!==''&&x[6]!==null).map(x=>x[6]);
  const listOk=list&&list.getLastRow()>1&&list.getRange(2,1,list.getLastRow()-1,1).getValues().some(x=>x[0]===r.target);
  const priceOk=template&&template.getLastRow()>1&&rates.length&&template.getRange(2,1,template.getLastRow()-1,2).getValues().some(x=>x[0]===r.target&&x[1]===rates[0]);
  if(!listOk||!priceOk)return {success:true,status:'master_saved_sync_pending',correctionId:r.operationId,downstreamSync:'changed',requiresReview:true};
  return {success:true,status:'already_verified',correctionId:r.operationId,downstreamSync:'verified'};
 }
 try {
  refreshEquipmentList();
  mcSyncTemplateTarget_(ss,r.target);
  SpreadsheetApp.flush();
  const list=ss.getSheetByName('목록');
  if(!list||list.getLastRow()<2||!list.getRange(2,1,list.getLastRow()-1,1).getValues().some(x=>x[0]===r.target))throw new Error('list readback missing');
  const templateId=PropertiesService.getScriptProperties().getProperty('CONTRACT_TEMPLATE_ID');
  if(!templateId)throw new Error('template not configured');
  const template=SpreadsheetApp.openById(templateId).getSheets().find(x=>x.getName().indexOf('마스터')>=0);
  if(!template||template.getLastRow()<2)throw new Error('template master missing');
  const expected=mcSnapshot_(ss).rows.filter(x=>x[0]===r.target&&x[6]!==''&&x[6]!==null).map(x=>x[6]);
  if(expected.length&&!template.getRange(2,1,template.getLastRow()-1,2).getValues().some(x=>x[0]===r.target&&x[1]===expected[0]))throw new Error('template price readback mismatch');
  audit.getRange(row,3).setValue('synced');SpreadsheetApp.flush();
  return {success:true,status:replay?'already_verified':'verified',correctionId:r.operationId,revision:plan.afterRevision,downstreamSync:'verified',manualEditorRaceProtected:false};
 }catch(error){
  return {success:true,status:'master_saved_sync_pending',correctionId:r.operationId,downstreamSync:'pending',errorDetail:String(error.message||error),retrySameCorrectionId:true};
 }
}

// Only derived target A/B; never clear template or rewrite document formulas.
function mcSyncTemplateTarget_(ss,target){
 const expected=mcSnapshot_(ss).rows.filter(x=>x[0]===target&&x[6]!==''&&x[6]!==null).map(x=>x[6]);
 if(!expected.length)throw new Error('target has no catalog rate');
 if(new Set(expected).size!==1)throw new Error('target price conflict');
 const id=PropertiesService.getScriptProperties().getProperty('CONTRACT_TEMPLATE_ID');
 if(!id)throw new Error('template not configured');
 const sheets=SpreadsheetApp.openById(id).getSheets().filter(x=>x.getName().indexOf('마스터')>=0);
 if(sheets.length!==1)throw new Error('template master ambiguous');
 const sh=sheets[0];
 if(JSON.stringify(sh.getRange(1,1,1,2).getValues()[0])!==JSON.stringify(['장비명','단가']))throw new Error('template schema changed');
 const rows=sh.getLastRow()>1?sh.getRange(2,1,sh.getLastRow()-1,2).getValues():[];
 const matches=rows.map((x,i)=>({x,i})).filter(z=>mcKey_(String(z.x[0]))===mcKey_(target));
 if(matches.length>1||matches.some(z=>z.x[0]!==target))throw new Error('template target ambiguous');
 if(matches.length){
  const row=matches[0].i+2;
  if(sh.getRange(row,2).getFormulas()[0][0])throw new Error('template price formula requires review');
  if(matches[0].x[1]!==expected[0])sh.getRange(row,2,1,1).setValues([[expected[0]]]);
 }else sh.getRange(sh.getLastRow()+1,1,1,2).setValues([[target,expected[0]]]);
}
