// Runs the actual GAS document handlers in isolated VM instances. All Sheets,
// Drive and provider services are doubles: this runner cannot send to customers.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const root=path.resolve(process.argv[2] || '../my-gas-project');
const agreement=fs.readFileSync(path.join(root,'agreement.js'),'utf8');
const sources={quote:agreement.slice(agreement.indexOf('function sendAutomaticPricingEstimate_(')),
  provider:fs.readFileSync(path.join(root,'AutomaticQuotationDelivery.js'),'utf8'),
  statement:fs.readFileSync(path.join(root,'AutomaticStatement.js'),'utf8')};
assert.ok(sources.quote.startsWith('function sendAutomaticPricingEstimate_('));
const report={schema:'village-document-provider-stress/v1',sourceRoot:root,
  hashes:Object.fromEntries(Object.entries(sources).map(([key,value])=>[key,createHash('sha256').update(value).digest('hex')])),
  customerSends:0,checks:0};
function harness(state={store:new Map(),sends:0,renders:0}) {
  const props={getProperty:key=>state.store.get(key)||null,setProperty:(key,value)=>state.store.set(key,value)};
  const context=vm.createContext({PropertiesService:{getScriptProperties:()=>props},
    Utilities:{DigestAlgorithm:{SHA_256:'sha256'},computeDigest:(_kind,data)=>createHash('sha256').update(data).digest(),base64EncodeWebSafe:data=>Buffer.from(data).toString('base64url')},
    LockService:{getScriptLock:()=>({tryLock:()=>!state.locked,releaseLock(){}})},
    guardDuplicateManualEstimateSend_:()=>({blocked:false,key:'mock'}),markManualEstimateSent_:()=>{},
    generateQuoteManual:()=>({fileId:'pdf-test',url:'https://docs.google.com/spreadsheets/d/pdf-test'}),
    sendQuoteManual:()=>{state.sends++;state.reentrant?.();if(state.loss)throw Error('response_lost');return {deliveryConfirmed:false,pending:true,pdfUrl:'https://drive.google.com/file/d/pdf-test/view',providerReceiptNum:'receipt'};},
    CONTRACT_TEMPLATE_CODE:'template',checkAlimtalkDelivery:()=>({templateCode:state.wrongTemplate?'other':'template',
      msgs:[{receiveNum:state.wrongPhone?'01099999999':'01012345678',state:state.providerState??3,result:state.providerResult??100,
        btns:[{u1:`https://drive.google.com/file/d/${state.wrongPdf?'other':'pdf-test'}/view`}]}]}),
    requireVillageOwnerKey_:()=>{},generateStatement:()=>{state.renders++;if(state.loss)throw Error('response_lost');return {fileId:'statement-pdf'};}});
  vm.runInContext(Object.values(sources).join('\n'),context);
  context.automaticPricingEstimatePreflight_=()=>({합계:7700});
  context.automaticStatementSnapshot_=()=>({row:2,totalVatIncluded:7700,customerName:'검증고객'});
  context.exportAutomaticStatementAttachment_=()=>({documentAccess:'private',mimeType:'application/pdf',pdfBase64:'mock-bytes'});
  return {context,state};
}
const manual={고객명:'검증고객',연락처:'01012345678',할인유형:'학생',items:[]};
const body=index=>({operationId:createHash('sha256').update(`operation-${index}`).digest('hex'),expectedTotal:7700,pricingSource:{source:'catalog'}});
const h=harness();
for(let index=0;index<100;index++) {
  const request=body(index),before=h.state.sends;
  h.state.reentrant=()=>{assert.equal(h.context.sendAutomaticPricingEstimate_(request,manual).status,'OUTCOME_UNKNOWN');report.checks++;};
  const result=h.context.sendAutomaticPricingEstimate_(request,manual);
  assert.equal(result.status,'OK');assert.equal(result.operationId,request.operationId);assert.equal(result.deliveryConfirmed,true);
  h.state.reentrant=null;
  const restarted=harness(h.state);
  for(let retry=0;retry<10;retry++)assert.equal(restarted.context.sendAutomaticPricingEstimate_(request,manual).replayed,true);
  assert.equal(h.state.sends,before+1);
  assert.throws(()=>restarted.context.sendAutomaticPricingEstimate_({...request,expectedTotal:8000},manual),/충돌/);
  report.checks+=13;
}
for(const fault of ['wrongTemplate','wrongPhone','wrongPdf','pending','providerFailure','loss','locked']) {
  const x=harness();
  if(fault==='pending')x.state.providerState=2;
  else if(fault==='providerFailure')x.state.providerResult=500;
  else x.state[fault]=true;
  const request=body(fault),first=x.context.sendAutomaticPricingEstimate_(request,manual);
  assert.equal(first.deliveryConfirmed,false);
  for(let retry=0;retry<20;retry++)assert.equal(harness(x.state).context.sendAutomaticPricingEstimate_(request,manual).deliveryConfirmed,false);
  assert.equal(x.state.sends,fault==='locked'?0:1);report.checks+=22;
}
const s=harness();
for(let index=0;index<100;index++) {
  const request={...body(`statement-${index}`),id:'261110-001'};
  const result=s.context.prepareAutomaticStatement_(request);assert.equal(result.status,'PREPARED');assert.equal(result.deliveryConfirmed,false);
  for(let retry=0;retry<10;retry++)assert.equal(harness(s.state).context.prepareAutomaticStatement_(request).replayed,true);
  report.checks+=12;
}
assert.equal(s.state.renders,100);assert.equal(s.state.sends,0);
const failedStatement=harness();failedStatement.state.loss=true;
assert.equal(failedStatement.context.prepareAutomaticStatement_({...body('statement-loss'),id:'261110-001'}).status,'OUTCOME_UNKNOWN');
for(let retry=0;retry<20;retry++)assert.equal(harness(failedStatement.state).context.prepareAutomaticStatement_({...body('statement-loss'),id:'261110-001'}).status,'OUTCOME_UNKNOWN');
assert.equal(failedStatement.state.renders,1);report.checks+=22;
report.mockQuoteSends=h.state.sends;report.mockStatementRenders=s.state.renders;report.passed=true;
console.log(JSON.stringify(report,null,2));
