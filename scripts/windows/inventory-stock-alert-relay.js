'use strict';

// Narrow fallback for the GAS stock-notice outbox. Never registers a booking.
const fs = require('node:fs');
const path = require('node:path');
const {parseEnv, DEFAULT_ENV_FILE} = require('./village-live-read');

async function findReceipt(slack, pending) {
  const args = {channel:pending.channel,oldest:pending.ts || String((pending.createdAt-60000)/1000),inclusive:true,limit:100,include_all_metadata:true};
  if(pending.ts)args.latest=pending.ts;
  for(let page=0;page<3;page++) {
    const result=await slack('conversations.history',args);
    const found=(result.messages || []).find(m=>m.metadata?.event_type==='preregistration_stock_alert' &&
      m.metadata?.event_payload?.id===pending.id && m.text===pending.text && (!pending.ts || pending.ts===m.ts));
    if(found)return {found:true,ts:found.ts};
    const cursor=result.response_metadata?.next_cursor;
    if(!cursor && !result.has_more)return {found:false,complete:true};
    if(!cursor)break;
    args.cursor=cursor;
  }
  return {found:false,complete:false};
}

async function relayOnce({gas,slack,channel,now=Date.now}) {
  const claim=await gas('claimPreRegistrationStockAlertRelay');
  if(claim.status!=='claimed')return {status:claim.status};
  const pending=claim.pending;
  if(pending.channel!==channel)throw new Error('relay_channel_mismatch');
  const ack={requestId:claim.requestId,id:pending.id,relayToken:pending.relayToken};
  let receipt=await findReceipt(slack,pending);
  if(!receipt.found) {
    if(!receipt.complete || pending.ts)return {status:'pending',requestId:claim.requestId};
    if(pending.desiredHash!==pending.hash || pending.actionable===false)
      return gas('acknowledgePreRegistrationStockAlertRelay',[{...ack,obsolete:true}]);
    if(!pending.transportRejected && pending.attemptedAt && now()-pending.attemptedAt<60000)
      return {status:'pending',requestId:claim.requestId};
    const authorization=await gas('authorizePreRegistrationStockAlertRelay',[ack]);
    if(authorization.status!=='authorized')return {status:authorization.status,requestId:claim.requestId};
    const posted=await slack('chat.postMessage',{channel,text:pending.text,unfurl_links:false,unfurl_media:false,
      client_msg_id:pending.id,metadata:{event_type:'preregistration_stock_alert',event_payload:{id:pending.id,request_id:claim.requestId}}});
    if(!posted.ts || posted.channel && posted.channel!==channel)throw new Error('relay_post_receipt_missing');
    receipt=await findReceipt(slack,{...pending,ts:posted.ts});
    if(!receipt.found)return {status:'pending',requestId:claim.requestId};
  }
  return gas('acknowledgePreRegistrationStockAlertRelay',[{...ack,delivered:true,channel,ts:receipt.ts}]);
}

function parseArgs(args) {
  const result={mode:'once',stateDir:path.join(process.env.LOCALAPPDATA || 'C:/Village','VillageInventoryAlerts')};
  for(let i=0;i<args.length;i++) {
    if(args[i]==='--setup')result.mode='setup';
    else if(args[i]==='--once')result.mode='once';
    else if(args[i]==='--channel' && args[i+1])result.channel=args[++i];
    else if(args[i]==='--state-dir' && args[i+1])result.stateDir=path.resolve(args[++i]);
    else throw new Error('relay_invalid_arguments');
  }
  return result;
}

function createClients({fetchImpl=fetch,config,slackToken,onBackoff=()=>{}}) {
  if(!config.VILLAGE2_API_KEY || !slackToken)throw new Error('relay_credentials_missing');
  const endpoint=new URL(config.VILLAGE2_API_URL);
  if(endpoint.protocol!=='https:' || endpoint.hostname!=='script.google.com')throw new Error('relay_invalid_gas_endpoint');
  async function gas(func,args=[]) {
    const url=new URL(endpoint);url.searchParams.set('key',config.VILLAGE2_API_KEY);url.searchParams.set('_stockRelay',String(Date.now()));
    const response=await fetchImpl(url,{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({key:config.VILLAGE2_API_KEY,action:'run',func,args}),signal:AbortSignal.timeout(90000)});
    let result;try{result=await response.json();}catch{throw new Error('relay_gas_response_invalid');}
    if(!response.ok || result.success!==true)throw new Error('relay_gas_request_failed');
    return result.result;
  }
  async function slack(method,payload) {
    const read=method!=='chat.postMessage',url=new URL('https://slack.com/api/'+method);
    if(read)for(const [key,value] of Object.entries(payload))url.searchParams.set(key,String(value));
    const response=await fetchImpl(url,{method:read?'GET':'POST',headers:{Authorization:'Bearer '+slackToken,'Content-Type':'application/json; charset=utf-8'},
      body:read?undefined:JSON.stringify(payload),signal:AbortSignal.timeout(20000)});
    if(response.status===429){onBackoff(Date.now()+Math.max(1,Number(response.headers.get('retry-after')) || 60)*1000);throw new Error('relay_slack_backoff');}
    const result=await response.json();
    if(!response.ok || !result.ok)throw new Error('relay_slack_request_failed');
    return result;
  }
  return {gas,slack};
}

async function main() {
  const options=parseArgs(process.argv.slice(2));fs.mkdirSync(options.stateDir,{recursive:true});
  const statePath=path.join(options.stateDir,'status.json'),configPath=path.join(options.stateDir,'config.json');
  const state=fs.existsSync(statePath)?JSON.parse(fs.readFileSync(statePath,'utf8')):{};
  function save(result) {
    const value={...state,at:new Date().toISOString(),...result};
    const temp=statePath+'.'+process.pid+'.tmp';fs.writeFileSync(temp,JSON.stringify(value,null,2));fs.renameSync(temp,statePath);
    console.log(JSON.stringify(value));
  }
  try {
    if(state.retryAfter>Date.now()){save({status:'backoff'});return;}
    const localConfig=fs.existsSync(configPath)?JSON.parse(fs.readFileSync(configPath,'utf8')):{};
    const channel=options.channel || localConfig.channel;
    if(!/^[CG][A-Z0-9]{8,}$/.test(channel || ''))throw new Error('relay_channel_missing');
    const env=fs.readFileSync(path.join(process.env.LOCALAPPDATA,'hermes','.env'),'utf8');
    const token=/^SLACK_BOT_TOKEN\s*=\s*(.+)$/m.exec(env)?.[1]?.trim().replace(/^['"]|['"]$/g,'');
    const clients=createClients({config:parseEnv(fs.readFileSync(DEFAULT_ENV_FILE,'utf8')),slackToken:token,onBackoff:t=>state.retryAfter=t});
    let result;
    if(options.mode==='setup') {
      const info=await clients.slack('conversations.info',{channel});
      if(info.channel?.id!==channel || !info.channel.is_member || info.channel.is_archived)throw new Error('relay_channel_unavailable');
      result=await clients.gas('setupPreRegistrationStockAlerts',[{channel,enabled:true,externalRelay:true}]);
      if(!result.enabled || result.channel!==channel)throw new Error('relay_setup_unverified');
      fs.writeFileSync(configPath,JSON.stringify({channel},null,2));
      save({status:'configured',channel,error:null});return;
    }
    result=await relayOnce({...clients,channel});
    if(result.receipt)state.lastReceipt=result.receipt;
    save({status:result.status,requestId:result.requestId || null,error:null});
  }catch(error){save({status:'error',error:/^relay_[a-z_]+$/.test(error.message)?error.message:'relay_operation_failed'});process.exitCode=1;}
}

module.exports={findReceipt,relayOnce,parseArgs,createClients};
if(require.main===module)main().catch(()=>{console.error('relay_start_failed');process.exitCode=1;});
