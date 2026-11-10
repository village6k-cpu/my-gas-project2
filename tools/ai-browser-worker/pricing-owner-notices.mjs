import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {verifiedPricingFreshJob,verifiedPricingAudit,pricingDocumentUrl} from './verified-pricing.mjs';

const clean=value=>String(value || '').replace(/[\r\n<>]/g,' ').trim();
export function pricingOwnerNotice(config,job,finalized){
  if(!config.verifiedPricingAutoSendEnabled || !verifiedPricingFreshJob(config,job))return null;
  const decision=finalized.decision || {},result=finalized.autoReplyResult || {};
  const pricing=verifiedPricingAudit(result);
  const openWork=(decision.follow_up_items || []).some(item=>item.requiresHumanAction===true
    && !['completed','resolved','cancelled','dismissed'].includes(item.status)
    && (['price_review','quote_send'].includes(item.type) || (item.type==='contract_document' && /거래명세|statement/i.test([item.title,item.summary,item.taskKey].join(' ')))));
  const relevant=pricing || result.priceVerification || result.pricingDocumentReceipt || result.pricingDocumentFailure || openWork
    || (decision.owner_review_required===true && ['price','price_review','quote_send'].includes(decision.classification));
  if(!relevant)return null;
  const priceSent=result.sent===true && Boolean(result.readbackReceipt);
  const document=result.pricingDocumentReceipt,documentSent=document?.deliveryConfirmed===true;
  const confirmed=priceSent || documentSent;
  const customer=clean(decision.customer?.name || job.customerName).slice(0,80) || '고객 확인 필요';
  const label=document?.documentType==='statement' || decision.statement_request ? '거래명세서':'견적서';
  const lines=[confirmed?'자동 가격·서류 처리 알림':'자동 가격·서류 확인 필요',`고객: ${customer}`];
  if(document?.tradeId)lines.push('거래: '+clean(document.tradeId));
  if(pricing){lines.push(`금액: ${pricing.totalVatIncluded.toLocaleString('ko-KR')}원 (부가세 포함)`,`할인: ${clean(pricing.discountType)}`);
    lines.push('품목: '+pricing.items.map(item=>`${clean(item.name)} ×${item.qty}`).join(', ').slice(0,2400));}
  if(confirmed){lines.push(`안내 답변: ${priceSent?'전송 확인':'완료 미확인'}`,`${label}: ${documentSent?'발송 확인':(result.pricingDocumentFailure?'발송 결과 확인 필요':'이번 안내에서 발송하지 않음')}`);
    if(documentSent && pricingDocumentUrl(document.ownerDocumentUrl || document.pdfUrl))lines.push(label+': '+pricingDocumentUrl(document.ownerDocumentUrl || document.pdfUrl));
    if(priceSent)lines.push('보낸 안내: '+String(result.text || '').slice(0,1500));
    lines.push('확인된 완료 건은 승인 업무를 만들지 않습니다.');
  }else lines.push('확인 내용: '+clean(result.gate?.reason || decision.reason || '가격·할인 또는 발송 결과 불확실').slice(0,800));
  lines.push('헤이빌리 > 후속조치 > 자동처리: https://today-dashboard-ten.vercel.app/');
  const key=createHash('sha256').update(String(job.jobId || job.id)+':pricing-owner-notice').digest('hex');
  const uuid=key.slice(0,8)+'-'+key.slice(8,12)+'-4'+key.slice(13,16)+'-a'+key.slice(17,20)+'-'+key.slice(20,32);
  return {schema:'village-pricing-owner-notice/v1',key,clientMsgId:uuid,channel:config.pricingOwnerSlackUserId,text:lines.join('\n'),createdAt:new Date().toISOString(),state:'pending'};
}

export async function queuePricingOwnerNotice(directory,notice){
  if(!notice)return;
  await fs.mkdir(directory,{recursive:true});
  try{await fs.writeFile(path.join(directory,notice.key+'.json'),JSON.stringify(notice),{encoding:'utf8',flag:'wx',mode:0o600});}
  catch(error){if(error.code!=='EEXIST')throw error;}
}

export async function flushPricingOwnerNotices(directory,{token,fetchImpl=fetch,now=Date.now()}={}){
  if(!token)return {sent:0,pending:0};
  let files;try{files=await fs.readdir(directory)}catch(error){if(error.code==='ENOENT')return{sent:0,pending:0};throw error}
  let sent=0,pending=0;
  let attempted=0;
  for(const file of files.filter(file=>/^[a-f0-9]{64}\.json$/.test(file)).sort()){
    const target=path.join(directory,file),notice=JSON.parse(await fs.readFile(target,'utf8'));
    if(notice.state==='sent' || Number(notice.nextAttemptAt || 0)>now)continue;
    if(notice.schema!=='village-pricing-owner-notice/v1' || !/^[UCG][A-Z0-9]+$/.test(notice.channel))continue;
    if (notice.review && now - Date.parse(notice.createdAt) > 2 * 60 * 60 * 1000) {
      notice.state = 'suppressed';
      await fs.writeFile(target, JSON.stringify(notice), {mode: 0o600});
      continue;
    }
    const blocks = notice.approval ? [
      {type:'section',text:{type:'plain_text',text:notice.text.slice(0,2900)}},
      ...(notice.review?.doc?.url ? [{type:'section',text:{type:'mrkdwn',text:`<${notice.review.doc.url}|문서 미리보기 열기>`}}] : []),
      {type:'actions',elements:[{type:'button',style:'primary',
        text:{type:'plain_text',text:'승인 후 발송'},action_id:notice.approval.action,value:notice.approval.value}]}
    ] : undefined;
    if(attempted++>=100)break;
    try{
      const response=await fetchImpl('https://slack.com/api/chat.postMessage',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({channel:notice.channel,text:notice.text,client_msg_id:notice.clientMsgId,...(blocks ? {blocks} : {}),mrkdwn:false,unfurl_links:false,unfurl_media:false}),signal:AbortSignal.timeout(15000)});
      const result=await response.json();if(!response.ok || result.ok!==true || !result.ts)throw Error('slack_delivery_unconfirmed');
      notice.state='sent';notice.slackTs=result.ts;notice.slackChannel=result.channel || '';notice.sentAt=new Date(now).toISOString();sent++;
    }catch{notice.attempts=(notice.attempts || 0)+1;notice.nextAttemptAt=now+Math.min(3600000,30000*2**Math.min(notice.attempts,7));pending++;}
    const temporary=target+'.tmp';
    await fs.writeFile(temporary,JSON.stringify(notice));
    await fs.rename(temporary,target);
  }
  return{sent,pending};
}
