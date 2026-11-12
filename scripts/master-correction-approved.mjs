// Trusted local issuer. Keeps Slack credential on the existing bridge host.
// Usage: node scripts/master-correction-approved.mjs PRIVATE_CONFIG REQUEST_JSON
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {issueProof,verifyOwnerCorrection,correctionIdForSource} from '../tools/master-correction/owner-proof.mjs';
const require=createRequire(import.meta.url),{parseEnv}=require('./windows/village-live-read.js');
function envValue(text,name){const line=text.split(/\r?\n/).find(x=>x.trim().startsWith(name+'='));if(!line)throw Error('issuer credential unavailable');return line.slice(line.indexOf('=')+1).trim().replace(/^["']|["']$/g,'');}
let inventoryMayBeSaved=false, activeCorrectionId;
async function main(){
 if(process.env.VILLAGE_NATIVE_MASTER_TOOL!=='1'||process.env.HERMES_DELEGATED_CHILD_CONTEXT)throw Error('Current native owner tool invocation required; standalone CLI disabled');
 const [configFile,requestFile]=process.argv.slice(2);if(!configFile||!requestFile)throw Error('private config and request file required');
 if((fs.statSync(configFile).mode&0o077)!==0)throw Error('issuer config must be private (0600)');
 const config=JSON.parse(fs.readFileSync(configFile,'utf8'));
 const api=parseEnv(fs.readFileSync(config.apiEnvFile,'utf8'));
 const url=new URL(api.VILLAGE2_API_URL);if(url.protocol!=='https:'||url.hostname!=='script.google.com')throw Error('invalid GAS endpoint');
 const request=JSON.parse(fs.readFileSync(requestFile,'utf8'));
 const stableId=correctionIdForSource(request.source||{});if(request.correctionId&&request.correctionId!==stableId)throw Error('correction ID must match original Slack source');request.correctionId=stableId;
 activeCorrectionId=stableId;
 async function post(body){const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...body,key:api.VILLAGE2_API_KEY,action:'masterCorrection'}),signal:AbortSignal.timeout(90000)});const data=await response.json();if(!response.ok||!data.success)throw Error(data.error||'master API failed');return data;}
 const stateFile=requestFile+'.prepared.json',inputDigest=createHash('sha256').update(JSON.stringify(request)).digest('hex');
 const issuerConfig={ownerId:config.ownerId,teamId:config.teamId,questionBotId:config.questionBotId,signingKey:config.signingKey,slackToken:envValue(fs.readFileSync(config.slackEnvFile,'utf8'),'SLACK_BOT_TOKEN')};
 let prepared;
 if(fs.existsSync(stateFile)){const saved=JSON.parse(fs.readFileSync(stateFile,'utf8'));if(saved.inputDigest!==inputDigest)throw Error('prepared request differs; do not reuse operation ID');prepared=saved.request;inventoryMayBeSaved=Boolean(request.newEquipment?.length);}
 else {
  if(request.newEquipment?.length){
   const checked=await verifyOwnerCorrection({request,config:issuerConfig});
   const stockEnv=fs.readFileSync(config.inventoryEnvFile||path.join(path.dirname(configFile),'slack-heybilli.env'),'utf8');
   const stockToken=envValue(stockEnv,'SLACK_HEYBILLI_API_TOKEN');
   if(!stockToken||stockToken===issuerConfig.slackToken||/^xox[a-z]-/.test(stockToken))throw Error('Separate internal inventory API credential required');
   const endpoint=new URL(config.inventoryApiUrl||'https://today-dashboard-ten.vercel.app/api/internal/catalog-stock');
   if(endpoint.protocol!=='https:'||endpoint.hostname!=='today-dashboard-ten.vercel.app'||endpoint.pathname!=='/api/internal/catalog-stock')throw Error('Invalid inventory endpoint');
   inventoryMayBeSaved=true;
   const response=await fetch(endpoint,{method:'POST',headers:{Authorization:'Bearer '+stockToken,'Content-Type':'application/json'},body:JSON.stringify(checked),signal:AbortSignal.timeout(120000)});
   const stock=await response.json();
   if(!response.ok||stock.success!==true){console.log(JSON.stringify({success:false,status:'inventory_saved_catalog_pending',correctionId:request.correctionId,retrySameSource:true,error:stock.error||'Verify inventory stage before resuming quotation'}));return;}
  }
  const preview=await post({...request,mode:'preview'});prepared={...request,mode:'apply',expectedRevision:preview.revision};
 }
 const verified=await issueProof({request:prepared,config:issuerConfig});
 if(!fs.existsSync(stateFile)){const saved={...verified};delete saved.ownerProof;fs.writeFileSync(stateFile,JSON.stringify({inputDigest,request:saved},null,2)+'\n',{mode:0o600,flag:'wx'});}
 // A timeout must be retried with the SAME correctionId, never a new operation.
 const result=await post(verified);
 console.log(JSON.stringify(result,null,2));
}
main().catch(error=>{
 if(inventoryMayBeSaved){console.log(JSON.stringify({success:false,status:'inventory_saved_catalog_pending',correctionId:activeCorrectionId,retrySameSource:true,error:error.message}));}
 else {console.error(error.message);process.exitCode=1;}
});
