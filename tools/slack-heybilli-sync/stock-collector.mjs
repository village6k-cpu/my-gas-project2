/** Collect Slack only on the existing authenticated local runtime. Never accept AI transcripts. */
export async function collectStockThread(report,slack,signal){
 if(!report || typeof report.id!=='string' || !/^[CG][A-Z0-9]+$/.test(report.channel||'') || !/^\d+\.\d+$/.test(report.ts||''))throw Error('잘못된 재고 보고 참조');
 const messages=[];let cursor='';const cursors=new Set();
 do {const data=await slack('conversations.replies',{channel:report.channel,ts:report.ts,limit:100,include_all_metadata:true,cursor},{signal});
 if(data.ok===false||!Array.isArray(data.messages))throw Error('Slack 재고 원문 조회 실패');messages.push(...data.messages);
 cursor=String(data.response_metadata?.next_cursor||'');if(data.has_more&&!cursor || messages.length>500 || cursor&&cursors.has(cursor))throw Error('Slack 재고 스레드 전체 조회 실패');if(cursor)cursors.add(cursor);
 }while(cursor);
 const root=messages[0];if(root?.ts!==report.ts||!root.bot_id||!['preregistration_stock_alert','inventory_risk_alert'].includes(root.metadata?.event_type)||root.metadata?.event_payload?.id!==report.id)throw Error('재고 보고 영수증 불일치');
 return {reportId:report.id,channel:report.channel,ts:report.ts,complete:true,messages};
}
async function boundedRead(action,signal){
 signal.throwIfAborted();let onAbort;
 const aborted=new Promise((_,reject)=>{onAbort=()=>reject(Error('재고 댓글 조회 시간 초과; 다음 실행에서 재시도'));signal.addEventListener('abort',onAbort,{once:true});});
 try{return await Promise.race([action(),aborted]);}finally{signal.removeEventListener('abort',onAbort);}
}
export async function scanStockWithLocalCollector(api,slack,{timeoutMs=25000}={}){
 const signal=AbortSignal.timeout(timeoutMs),rawApi=api,rawSlack=slack;
 api=body=>boundedRead(()=>rawApi(body,{signal}),signal);
 slack=(method,args)=>boundedRead(()=>rawSlack(method,args,{signal}),signal);
 const {reports}=await api({mode:'stock_reports'});if(!Array.isArray(reports)||reports.length>8)throw Error('재고 보고 조회 범위 오류');
 const collected=await Promise.all(reports.map(async report=>{try{return {thread:await collectStockThread(report,slack)};}catch(error){return {error:{reportId:report.id,error:error.message}};}}));
 const result=await api({mode:'stock_scan',threads:collected.filter(r=>r.thread).map(r=>r.thread)});
 return {...result,errors:[...(result.errors||[]),...collected.filter(r=>r.error).map(r=>r.error)]};
}
export async function confirmStockWithLocalCollector(body,execute,api,slack){
 const {reports}=await api({mode:'stock_reports',reportId:body.reportId});if(!Array.isArray(reports)||reports.length!==1||reports[0].id!==body.reportId)throw Error('현재 재고 보고 확인 필요');
 const threadEvidence=await collectStockThread(reports[0],slack);
 return api({mode:'stock_confirm',execute,reportId:reports[0].id,confirmation:body.confirmation,threadEvidence});
}