import test from 'node:test';import assert from 'node:assert/strict';import './helpers/tsResolve.mjs';
import {stockNameKey,stockThreadHash} from '../lib/server/slackStockCore.mjs';
const {getStockReports,reviewStock,scanStockQuestions,confirmStockQuestion,retryConfirmedStockMirrors,processInventoryQuestionDelivery:inventoryQuestionDelivery}=await import('../lib/server/slackStock.ts');
process.env.NEXT_PUBLIC_SUPABASE_URL='https://review-db.test';process.env.SUPABASE_SERVICE_ROLE_KEY='test';process.env.GAS_SYNC_URL='https://review-gas.test/exec';process.env.VILLAGE_GAS_INTERNAL_KEY='private';process.env.SLACK_INVENTORY_OWNER_IDS='UOWNER';
const originalFetch=globalThis.fetch,questionId='00000000-0000-4000-8000-000000000001';
let source,context,ledger,reviews,aliases,mutations,receipts,sheet,failAfterLink;
test.beforeEach(()=>{
 source={name:'TVLogic 17인치',kinds:['unknown_equipment'],bookings:[{scheduleId:'S1',tradeId:'T1',quantity:1,start:'2099-01-01',end:'2099-01-02'}],setNames:['카메라 세트']};
 context={reports:[],equipment:[{id:'MON-012',name:'LVM-170A',category:'17인치 모니터',stock:4,maintenance:0,aliases:[]}],sets:[{name:'카메라 세트',components:[{name:source.name,quantity:1}]}],investigations:[source],channel:'C123',sourceIssues:[]};
 failAfterLink=false;ledger=[{equipment_id:'MON-012',name:'LVM-170A',stock_total:4,stock_maint:0,updated_at:'2026-09-14T00:00:00Z'}];reviews=[];aliases=[];mutations=[];receipts=[];sheet=[];
 globalThis.fetch=async(input,options={})=>{
  const url=new URL(typeof input==='string'?input:input.url||input.href),body=options.body?JSON.parse(options.body):null,method=options.method||'GET',table=url.pathname.split('/').at(-1);
  if(url.hostname==='review-gas.test'){
   if(body?.action==='run'&&failAfterLink&&aliases.length){failAfterLink=false;return Response.json({success:false,error:'readback temporarily unavailable'});}
   if(body?.action==='run')return Response.json({success:true,result:context});
   if(body?.action==='equipmentMasterSync'){const r=body.append[0];sheet.push([r.id,r.name,r.total,r.maint,r.state]);return Response.json({success:true});}
   if(url.searchParams.get('action')==='read')return Response.json({headers:['장비ID','장비명','총보유수량','정비중수량','상태'],data:sheet});
  }
  if(url.hostname==='slack.com')throw Error('cloud must not own Slack');
  if(method==='POST'||method==='PATCH')mutations.push({table,body});
  let result;
  if(table==='inventory_identity_reviews'&&method==='PATCH'){Object.assign(reviews[0],body);result=null;}
  else if(table==='inventory_identity_reviews')result=url.searchParams.has('id')?reviews.find(r=>r.id===url.searchParams.get('id').slice(3)):reviews;
  else if(table==='equipment_ledger'){const id=url.searchParams.get('equipment_id');result=id?ledger.find(r=>r.equipment_id===id.slice(3)):ledger;}
  else if(table==='inventory_identity_aliases')result=aliases.find(r=>r.name_key===url.searchParams.get('name_key')?.slice(3));
  else if(table==='record_inventory_identity_review'){
   const p=body.p_decision,r={id:questionId,source_key:p.sourceId,source_name:p.sourceName,source_hash:p.sourceHash,action:p.action,evidence:p,question_channel:p.channel,question_text:p.question};reviews.push(r);
   if(p.action==='link_existing'){aliases.push({name_key:stockNameKey(p.sourceName),source_name:p.sourceName,equipment_id:p.equipmentId,equipment_name:p.equipmentName});context.equipment[0].aliases.push(p.sourceName);context.investigations=[];}
   result={ok:true,id:questionId,action:p.action,sourceName:p.sourceName,equipmentId:p.equipmentId};
  }else if(table==='claim_inventory_identity_question')result=reviews[0]||null;
  else if(table==='mark_inventory_identity_question_attempt')result=true;
  else if(table==='complete_inventory_identity_question'){Object.assign(reviews[0],{question_ts:body.p_ts,posted_at:'2026-09-14T00:01:00Z'});result=true;}
  else if(table==='confirm_missing_inventory_stock'){ledger.push({equipment_id:'NEW-001',...body.p_item,state:'정상',note:'',updated_at:'2026-09-14T00:02:00Z'});receipts.push({equipment_id:'NEW-001',synced_at:null});result={ok:true,equipmentId:'NEW-001'};}
  else if(table==='inventory_stock_confirmations'){if(method==='PATCH'){receipts.forEach(r=>Object.assign(r,body));result=null;}else result=receipts.filter(r=>!r.synced_at);}
  else throw Error('unexpected '+table);
  return Response.json(result);
 };
});
test.afterEach(()=>globalThis.fetch=originalFetch);
function decision(scan,action='link_existing'){return {sourceId:scan.investigations[0].id,sourceHash:scan.investigations[0].sourceHash,catalogHash:scan.catalogHash,action,reason:'전체 카탈로그에서 브랜드와 화면 크기를 대조한 동일 모델',...(action==='link_existing'?{equipmentId:'MON-012',equipmentName:'LVM-170A'}:{question:'신규 구성 장비의 실제 총보유·정비 수량은 각각 몇 개인가요?'})};}
test('investigation without comments reaches server validation, persistent alias and effective GAS readback',async()=>{
 const before=structuredClone(ledger),scan=await getStockReports();assert.equal(scan.reports.length,0);assert.equal(scan.investigations.length,1);
 const p=decision(scan);assert.equal((await reviewStock(p,false)).dryRun,true);assert.equal(mutations.length,0);
 const result=await reviewStock(p,true);assert.equal(result.verified,true);assert.equal(result.effective,true);assert.deepEqual(ledger,before);assert.equal((await getStockReports()).investigations.length,0);
});
test('a changed current source is rejected before writing an identity mapping',async()=>{const p=decision(await getStockReports());source.bookings[0].quantity=2;await assert.rejects(reviewStock(p,true),/바뀌었습니다/);assert.equal(mutations.length,0);});
test('component-only missing inventory flows through concrete Slack question and owner reply to verified master',async()=>{
 source.name='새 구성장비';source.setNames=['카메라 세트'];context.equipment=[];ledger=[];
 const d=decision(await getStockReports(),'ask_owner');assert.equal((await reviewStock(d,true)).deliveryPending,true);
 const claim=await inventoryQuestionDelivery({operation:'claim'}),owner=claim.question.owner;await inventoryQuestionDelivery({operation:'attempt',id:questionId,owner});
 const root={ts:'1789344060.001',bot_id:'B1',text:d.question,metadata:{event_type:'inventory_risk_alert',event_payload:{id:questionId}}};
 const evidence={reportId:questionId,channel:'C123',ts:root.ts,complete:true,messages:[root]};
 await inventoryQuestionDelivery({operation:'receipt',id:questionId,owner,receipt:evidence});context.investigations=[];
 const scan=await getStockReports();assert.equal(scan.reports[0].names[0],'새 구성장비');assert.ok(scan.catalog.sets.some(s=>s.name==='새 구성장비'));
 evidence.messages.push({ts:'1789344100.002',user:'UOWNER',text:'총 2개, 수리는 0개'});
 const replies=await scanStockQuestions([evidence]);assert.equal(replies.questions.length,1);
 const result=await confirmStockQuestion({reportId:questionId,threadEvidence:evidence,confirmation:{catalogName:'새 구성장비',stockTotal:2,stockMaintenance:0,major:'기타',category:'그립',quote:evidence.messages[1].text,sourceMessageTs:evidence.messages[1].ts,sourceHash:stockThreadHash(evidence.messages)}},true);
 assert.equal(result.equipmentId,'NEW-001');assert.equal(ledger[0].price,null);assert.equal((await retryConfirmedStockMirrors())[0].verified,true);assert.deepEqual(sheet[0],['NEW-001','새 구성장비',2,0,'정상']);
});

test('an obsolete queued question is canceled before a new Slack post is authorized',async()=>{
 const d=decision(await getStockReports(),'ask_owner');await reviewStock(d,true);const claim=await inventoryQuestionDelivery({operation:'claim'});
 context.investigations=[];const result=await inventoryQuestionDelivery({operation:'attempt',id:questionId,owner:claim.question.owner});
 assert.equal(result.allowed,false);assert.equal(result.stale,true);assert.ok(reviews[0].cancelled_at);assert.equal(mutations.some(r=>r.table==='mark_inventory_identity_question_attempt'),false);
});

test('post-commit readback failure retries the saved identity receipt without a second write',async()=>{
 const p=decision(await getStockReports());failAfterLink=true;await assert.rejects(reviewStock(p,true));const before=mutations.length;
 const retry=await reviewStock(p,true);assert.equal(retry.duplicate,true);assert.equal(retry.effective,true);assert.equal(mutations.length,before);
 await assert.rejects(reviewStock({...p,equipmentId:'OTHER'},true),/근거/);
});
test('a model-choice question stays visible in the AI queue until the booking is actually resolved',async()=>{
 source.name='17인치 모니터';source.kinds=['model_selection'];await reviewStock(decision(await getStockReports(),'ask_owner'),true);
 const next=await getStockReports();assert.equal(next.investigations.length,1);assert.equal(next.investigations[0].status,'waiting_model_choice');assert.match(next.investigations[0].question.text,/수량/);
});
