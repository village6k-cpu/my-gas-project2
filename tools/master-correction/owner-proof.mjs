import {resolveContextualPrice} from './contextual-price.mjs';
import {createHash,createHmac} from 'node:crypto';
export function payload(r){return {correctionId:r.correctionId||r.operationId,kind:r.kind,target:r.target,scope:r.scope,unit:r.unit??null,price:r.price??null,components:r.components??null,replace:r.replace??null,expectedRevision:r.expectedRevision,source:r.source};}
export const correctionIdForSource=s=>'mc-'+createHash('sha256').update(s.channel+'|'+s.ts).digest('hex').slice(0,32);
export const digest=r=>createHash('sha256').update(JSON.stringify(payload(r))).digest('hex');
// Intentionally conservative complete statements. Customer/thread exceptions never qualify.
export function parseStandingPrice(text){
 if(typeof text!=='string'||text.length>300||/[\r\n"'“”‘’<>`]/u.test(text))throw Error('needs_review: quoted or complex source');
 const t=text.trim().replace(/[.!。]$/u,'');
 const patterns=[/^(?:앞으로|상시|기본)\s+(.+?)\s+(?:단가(?:는|를)?\s*)?(?:하루|1일|일일)\s*([\d,]+)\s*원(?:으로)?(?:\s*(?:해|해줘|적용해|등록해|수정해|이야))?$/u,/^(.+?)\s+(?:상시|기본)\s*단가(?:는|를)?\s*([\d,]+)\s*원\s*\/\s*일(?:로)?(?:\s*(?:등록해|수정해|해줘))?$/u];
 let m;for(const p of patterns){m=t.match(p);if(m)break;}
 if(!m||/(이번|거래|고객|손님|무료로 해드|할인|취소|말고|아니|견적|문의|전달|라고|라면|할까|하면)/u.test(t))throw Error('needs_review: not an explicit standing daily price');
 if(!/^(?:\d+|[1-9]\d{0,2}(?:,\d{3})+)$/.test(m[2]))throw Error('needs_review: malformed amount');
 const target=m[1].trim(),price=Number(m[2].replaceAll(',',''));
 if(!target||!Number.isSafeInteger(price)||price<0)throw Error('needs_review: invalid price');
 return {kind:'price',scope:'standing',target,price,unit:'KRW/day'};
}
export async function issueProof({request,config,fetchImpl=fetch,now=Date.now()}){
 if(!config.ownerId||!config.teamId||!config.slackToken||!config.signingKey||config.signingKey.length<32)throw Error('issuer not configured');
 const src=request.source;
 if(src?.platform!=='slack'||!/^([CDG])[A-Z0-9]+$/.test(src.channel||'')||!/^\d{10}\.\d{6}$/.test(src.ts||''))throw Error('exact source required');
 const sourceMs=Number(src.ts)*1000;
 if(sourceMs>now+60000||now-sourceMs>3600000)throw Error('needs_review: source is old or future dated');
 if(request.correctionId!==correctionIdForSource(src))throw Error('source must use its stable correction ID');
 async function slack(method,params={}){const u=new URL('https://slack.com/api/'+method);for(const [k,v]of Object.entries(params))u.searchParams.set(k,v);const res=await fetchImpl(u,{headers:{Authorization:'Bearer '+config.slackToken},signal:AbortSignal.timeout(15000)});if(!res.ok)throw Error('Slack unavailable');const body=await res.json();if(!body.ok)throw Error('Slack rejected source lookup');return body;}
 const auth=await slack('auth.test');
 if(auth.team_id!==config.teamId)throw Error('workspace mismatch');
 if(src.threadTs&&!/^\d{10}\.\d{6}$/.test(src.threadTs))throw Error('invalid thread reference');
 const query={channel:src.channel,oldest:src.ts,latest:src.ts,inclusive:'true',limit:'100'};
 if(src.threadTs)query.ts=src.threadTs;
 const body=await slack(src.threadTs?'conversations.replies':'conversations.history',query);
 const m=body.messages?.find(x=>x.ts===src.ts);
 if(!m||m.user!==config.ownerId||m.bot_id||m.app_id||m.subtype||m.edited||m.files?.length||m.attachments?.length)throw Error('untrusted owner source');
 let parsed,question;
 const threadRoot=m.thread_ts||(m.reply_count>0?m.ts:src.threadTs);
 try{parsed=parseStandingPrice(m.text);}catch(error){
  if(!threadRoot)throw error;
  const thread=await slack('conversations.replies',{channel:src.channel,ts:threadRoot,limit:'100'});
  if(thread.has_more)throw Error('needs_review: incomplete question context');
  const result=resolveContextualPrice({messages:thread.messages,questionTs:src.questionTs,answerTs:src.ts,ownerId:config.ownerId,botId:config.questionBotId||auth.bot_id,threadTs:threadRoot});
  parsed=result;const original=thread.messages.find(x=>x.ts===result.questionTs);question={ts:original.ts,text:original.text,botId:original.bot_id};
 }
 const laterQueries=[{method:'conversations.history',query:{channel:src.channel,oldest:src.ts,inclusive:'false',limit:'100'},thread:false}];
 if(threadRoot)laterQueries.push({method:'conversations.replies',query:{channel:src.channel,ts:threadRoot,oldest:src.ts,inclusive:'false',limit:'100'},thread:true});
 for(const item of laterQueries){
  const newer=await slack(item.method,item.query);
  if(newer.has_more)throw Error('needs_review: incomplete later-message context');
  if((newer.messages||[]).some(x=>Number(x.ts)>Number(src.ts)&&x.user===config.ownerId&&(item.thread||String(x.text||'').includes(parsed.target)||/(취소|아니|말고|정정)/u.test(x.text||''))))throw Error('needs_review: later owner message may supersede correction');
 }
 for(const k of ['kind','scope','target','price','unit'])if(parsed[k]!==request[k])throw Error('source correction mismatch');
 if(request.replace)throw Error('needs_review: existing price replacement requires specific reviewed authorization');
 const source={...(question?{questionTs:question.ts,contextQuestion:question}:{}),platform:'slack',channel:src.channel,ts:src.ts,...(threadRoot?{threadTs:threadRoot}:{}),ref:'slack:'+src.channel+':'+src.ts,quote:m.text,verifiedOwner:true,ownerId:config.ownerId,teamId:config.teamId};
 const verified={...request,source};
 const claims={v:1,aud:'village-master-correction',digest:digest(verified),ownerId:config.ownerId,teamId:config.teamId,issuedAt:now,expiresAt:now+120000};
 const encoded=Buffer.from(JSON.stringify(claims)).toString('base64');
 const signature=createHmac('sha256',config.signingKey).update(encoded).digest('hex');
 return {...verified,ownerProof:{claims:encoded,signature}};
}
