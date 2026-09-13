'use strict';

// Owner visibility must survive failures before Kakao creates a job or GAS RQ.
// This path reads no booking ledger and does not depend on GAS or the AI worker.
const fs=require('node:fs');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const {stockAlertSlackText_}=require('../../stockAlertReceipt');

const reasons={
  plugin_validation_failed:'워커 설치 상태 검증 실패',
  gateway_unavailable:'워커 실행·처리 상태 확인 실패',
  capture_unavailable:'카카오 대화 수집 중단',
  recovery_incomplete:'자동 복구 후 정상 수집을 확인하지 못함',
  runtime_validation_failed:'자동등록 실행 환경 확인 실패'
};

async function findIncidentReceipt(slack,incident) {
  const args={channel:incident.channel,oldest:incident.ts || String((incident.createdAt-60000)/1000),inclusive:true,limit:100,include_all_metadata:true};
  if(incident.ts)args.latest=incident.ts;
  for(let page=0;page<3;page++) {
    const r=await slack('conversations.history',args);
    const match=(r.messages || []).find(m=>m.metadata?.event_type==='kakao_runtime_incident' &&
      m.metadata?.event_payload?.id===incident.id && stockAlertSlackText_(m.text)===stockAlertSlackText_(incident.text) &&
      (!incident.ts || m.ts===incident.ts));
    if(match)return {found:true,ts:match.ts};
    const cursor=r.response_metadata?.next_cursor;
    if(!cursor && !r.has_more)return {found:false,complete:true};
    if(!cursor)break;args.cursor=cursor;
  }
  return {found:false,complete:false};
}

async function reportIncident({healthy,reason,channel,load,save,slack,now=Date.now}) {
  const state=load();state.checkedAt=now();
  if(healthy===true) {
    if(state.incident && !state.incident.closedAt)state.incident.closedAt=now();
    state.healthy=true;save(state);return {status:'healthy'};
  }
  if(healthy!==false || !reasons[reason] || !/^[CG][A-Z0-9]{8,}$/.test(channel || ''))throw Error('incident_invalid_input');
  if(!state.incident || state.incident.closedAt)state.incident={id:randomUUID(),createdAt:now(),channel,
    text:'🚨 *카카오 자동등록 점검 필요*\n'+reasons[reason]+'\n새 문의의 자동등록·재고 경고가 누락될 수 있습니다.\n👉 복구와 미처리 대화 확인이 필요합니다.'};
  const incident=state.incident;state.healthy=false;state.reason=reason;save(state);
  if(incident.receipt)return {status:'already_sent',receipt:incident.receipt};
  let receipt=await findIncidentReceipt(slack,incident);
  if(!receipt.found) {
    if(!receipt.complete || incident.ts || incident.attemptedAt && now()-incident.attemptedAt<60000)return {status:'pending'};
    incident.attemptedAt=now();save(state);
    const posted=await slack('chat.postMessage',{channel:incident.channel,text:incident.text,client_msg_id:incident.id,
      unfurl_links:false,unfurl_media:false,metadata:{event_type:'kakao_runtime_incident',event_payload:{id:incident.id}}});
    if(!posted.ts || posted.channel && posted.channel!==incident.channel)throw Error('incident_receipt_mismatch');
    incident.ts=posted.ts;save(state);receipt=await findIncidentReceipt(slack,incident);
    if(!receipt.found)return {status:'pending'};
  }
  incident.receipt={id:incident.id,channel:incident.channel,ts:receipt.ts,at:now()};save(state);
  return {status:'sent',receipt:incident.receipt};
}

function createSlackClient({token,fetchImpl=fetch}) {
  return async(method,payload)=>{
    if(!['conversations.history','conversations.info','chat.postMessage'].includes(method))throw Error('incident_method_not_allowed');
    const post=method==='chat.postMessage',url=new URL('https://slack.com/api/'+method);
    if(!post)for(const [k,v] of Object.entries(payload))url.searchParams.set(k,String(v));
    const r=await fetchImpl(url,{method:post?'POST':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json; charset=utf-8'},
      body:post?JSON.stringify(payload):undefined,signal:AbortSignal.timeout(15000)});
    const body=await r.json();if(!r.ok || !body.ok)throw Error('incident_slack_unavailable');return body;
  };
}

async function main(argv=process.argv.slice(2)) {
  const root=path.join(process.env.LOCALAPPDATA,'Village','kakao-staging');
  const statePath=path.join(root,'watchdog-incident.json'),lockPath=statePath+'.lock';
  fs.mkdirSync(root,{recursive:true});
  let lock;
  try {lock=fs.openSync(lockPath,'wx');}
  catch(error) {
    if(error.code!=='EEXIST')throw error;
    const owner=JSON.parse(fs.readFileSync(lockPath,'utf8') || '{}');let live=Number.isInteger(owner.pid) && owner.pid>0;
    if(live)try{process.kill(owner.pid,0);}catch(e){if(e.code==='ESRCH')live=false;}
    if(live || Date.now()-(owner.at || fs.statSync(lockPath).mtimeMs)<180000)return {status:'busy'};
    fs.unlinkSync(lockPath);lock=fs.openSync(lockPath,'wx');
  }
  fs.writeFileSync(lock,JSON.stringify({pid:process.pid,at:Date.now()}));
  try {
    const load=()=>fs.existsSync(statePath)?JSON.parse(fs.readFileSync(statePath,'utf8')):{};
    const save=state=>{const tmp=statePath+'.'+process.pid+'.tmp';fs.writeFileSync(tmp,JSON.stringify(state,null,2));fs.renameSync(tmp,statePath);};
    if(argv.length===1 && argv[0]==='--healthy')return reportIncident({healthy:true,load,save});
    const configPath=process.env.VILLAGE_STOCK_ALERT_CONFIG || 'C:\\Village\\runtime\\inventory-stock-alerts\\config.json';
    const cfg=JSON.parse(fs.readFileSync(configPath,'utf8'));
    const token=/^SLACK_BOT_TOKEN\s*=\s*(.+)$/m.exec(fs.readFileSync(path.join(process.env.LOCALAPPDATA,'hermes','.env'),'utf8'))?.[1]?.trim().replace(/^['"]|['"]$/g,'');
    if(!token || !/^[CG][A-Z0-9]{8,}$/.test(cfg.channel || ''))throw Error('incident_connection_missing');
    const slack=createSlackClient({token});
    if(argv.length===1 && argv[0]==='--verify-connection') {
      const r=await slack('conversations.info',{channel:cfg.channel});
      if(r.channel?.id!==cfg.channel || !r.channel.is_member || r.channel.is_archived)throw Error('incident_channel_unavailable');
      await slack('conversations.history',{channel:cfg.channel,limit:1,include_all_metadata:true});
      return {status:'verified',channel:cfg.channel};
    }
    if(argv.length!==2 || argv[0]!=='--failure')throw Error('incident_invalid_input');
    return await reportIncident({healthy:false,reason:argv[1],channel:cfg.channel,load,save,slack});
  } finally {fs.closeSync(lock);fs.unlinkSync(lockPath);}
}

module.exports={reportIncident,findIncidentReceipt,createSlackClient,main};
if(require.main===module)main().then(r=>console.log(JSON.stringify(r))).catch(()=>{console.error('incident_notice_failed');process.exitCode=1;});
