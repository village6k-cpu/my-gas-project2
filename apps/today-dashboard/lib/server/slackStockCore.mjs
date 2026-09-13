import {createHash} from 'node:crypto';
export const stockNameKey=value=>String(value || '').normalize('NFKC').toLowerCase().replace(/[^0-9a-z가-힣]/g,'');
export function stockThreadHash(messages){return createHash('sha256').update(JSON.stringify(messages.map(m=>({ts:m.ts,user:m.user || '',bot:m.bot_id || '',text:m.text || ''})))).digest('hex');}
export function validateStockConfirmation(plan,{report,ownerIds,messages,catalog,equipment}) {
 if(!plan || !report || !Array.isArray(ownerIds) || !ownerIds.length)throw Error('소유자 재고 확인 설정이 없습니다');
 if(plan.sourceHash!==stockThreadHash(messages))throw Error('Slack 답변이 바뀌었습니다. 다시 조회해 주세요');
 const message=messages.find(m=>m.ts===plan.sourceMessageTs && m.ts!==report.ts && !m.bot_id && ownerIds.includes(m.user));
 if(!message || !message.text || message.text!==plan.quote)throw Error('대표님 답변 전체 원문이 필요합니다');
 const item=catalog.find(c=>c.name===plan.catalogName);
 if(!item || !report.names.includes(item.name))throw Error('해당 보고의 카탈로그 장비가 아닙니다');
 if(equipment.some(e=>[e.name,...(e.aliases || [])].some(n=>stockNameKey(n)===stockNameKey(item.name))))throw Error('이미 장비마스터에 있습니다. 기존 재고를 덮어쓰지 않습니다');
 if(!Number.isInteger(plan.stockTotal)||plan.stockTotal<0||plan.stockTotal>9999||!Number.isInteger(plan.stockMaintenance)||plan.stockMaintenance<0||plan.stockMaintenance>plan.stockTotal)throw Error('보유·정비 수량 오류');
 for(const field of ['category','major'])if(typeof plan[field]!=='string'||!plan[field].trim()||plan[field].length>100)throw Error('장비 분류를 선택해 주세요');
 return {...plan,ownerId:message.user,sourceKey:report.channel+':'+report.ts+':'+message.ts+':'+createHash('sha256').update(item.name).digest('hex').slice(0,16)};
}

export function stockGasRequest(gasUrl,gasKey,action,body={}){
 const url=new URL(gasUrl);url.searchParams.set('action',action);
 if(action==='read'){url.searchParams.set('key',gasKey);for(const [k,v] of Object.entries(body))url.searchParams.set(k,String(v));return {url,options:{method:'GET'}};}
 return {url,options:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action,key:gasKey,...body})}};
}
export function stockQuestionBatch(reports,now=Date.now(),size=8){
 const ordered=[...reports].sort((a,b)=>a.id.localeCompare(b.id));const pages=Math.ceil(ordered.length/size);
 if(!pages)return [];const page=Math.floor(now/600000)%pages;return ordered.slice(page*size,(page+1)*size);
}
