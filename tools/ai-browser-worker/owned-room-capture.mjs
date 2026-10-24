// Only this module can authorize closure of a tab it created in this process.
const owned = new Map();
function exactListUrl(value) {
 const url=new URL(value);
 if(url.origin!=='https://business.kakao.com'||!/^\/space\/[A-Za-z0-9_-]+\/channel\/[A-Za-z0-9_-]+\/chats\/?$/.test(url.pathname))throw Error('Invalid owned capture list');
 return url;
}
function localCdp(value){
 const url=new URL(value);
 if(url.protocol!=='http:'||!['127.0.0.1','localhost'].includes(url.hostname)||url.username||url.password||url.search||url.hash||!['','/'].includes(url.pathname))throw Error('Invalid owned capture CDP');
 return url;
}
function sameBrowserSocket(value,base){
 const url=new URL(value);
 return url.protocol==='ws:'&&['127.0.0.1','localhost'].includes(url.hostname)&&url.port===base.port&&/^\/devtools\/browser\/[A-Za-z0-9-]+$/.test(url.pathname);
}
export async function closeOwnedKakaoRoom(targetInfo={},options={}){
 const proof=owned.get(targetInfo.id);
 if(!proof||targetInfo.url!==proof.url)return{status:'skipped_unowned_capture'};
 const {fetchJson,callCdp,inspectDraft}=options;
 try{
  const targets=await fetchJson(proof.base,'/json/list');const current=targets.find(t=>t.id===targetInfo.id);
  if(!current||!(current.url===proof.url||(proof.awaitingLoad&&current.url==='about:blank'))||(proof.socket&&current.webSocketDebuggerUrl!==proof.socket))return{status:'skipped_changed_owned_capture'};
  const state=await inspectDraft(current);
  if(state?.href!==current.url)return{status:'skipped_changed_owned_capture'};
  if(state.hasDraft!==false)return{status:'skipped_owned_capture_draft'};
  const latest=(await fetchJson(proof.base,'/json/list')).find(t=>t.id===targetInfo.id);
  if(!latest||latest.url!==current.url||latest.webSocketDebuggerUrl!==current.webSocketDebuggerUrl)return{status:'skipped_changed_owned_capture'};
  const result=await callCdp(proof.browser,'Target.closeTarget',{targetId:targetInfo.id});
  return{status:result?.success===true?'closed_owned_capture':'owned_capture_close_unknown',targetId:targetInfo.id};
 }catch{return{status:'owned_capture_close_unknown',targetId:targetInfo.id};}
 finally{owned.delete(targetInfo.id);}
}
export async function captureOwnedKakaoRoom(options={}){
 const {cdpBaseUrl,mainTarget,knownTargets=[],roomId,fetchJson,callCdp,readEvidence}=options;
 const base=localCdp(cdpBaseUrl);const list=exactListUrl(mainTarget?.url);
 if(!/^\d{6,24}$/.test(String(roomId))||!Array.isArray(knownTargets)||typeof readEvidence!=='function'||typeof options.inspectDraft!=='function')throw Error('Invalid owned capture identity');
 const url=list.origin+list.pathname.replace(/\/$/,'')+'/'+roomId;
 const version=await fetchJson(cdpBaseUrl,'/json/version');
 if(!sameBrowserSocket(version?.webSocketDebuggerUrl,base))throw Error('Invalid owned capture browser socket');
 const browser={webSocketDebuggerUrl:version.webSocketDebuggerUrl};
 const created=await callCdp(browser,'Target.createTarget',{url,background:true});
 const id=created?.targetId;
 if(typeof id!=='string'||!id||knownTargets.some(t=>t.id===id))throw Error('Owned capture create response is invalid or names an existing target');
 let targetInfo={id,url,owned_capture:true},success=false,outcome,stage='create';
 owned.set(id,{base:cdpBaseUrl,url,socket:null,browser,awaitingLoad:true});
 try{
  let target;
  for(let attempt=0;attempt<10;attempt++){
   target=(await fetchJson(cdpBaseUrl,'/json/list')).find(t=>t.id===id);
   if(target?.type==='page'&&target.url===url&&target.webSocketDebuggerUrl)break;
   await (options.sleepImpl||((ms)=>new Promise(r=>setTimeout(r,ms))))(100);
  }
  if(!target||target.type!=='page'||target.url!==url||!target.webSocketDebuggerUrl)throw Error('Created owned capture target unavailable');
  targetInfo={id,url,webSocketDebuggerUrl:target.webSocketDebuggerUrl,owned_capture:true};
  owned.set(id,{base:cdpBaseUrl,url,socket:target.webSocketDebuggerUrl,browser,awaitingLoad:false});
  // Other CDP clients can auto-attach new tabs paused. Resume only our verified target.
  const current=(await fetchJson(cdpBaseUrl,'/json/list')).find(t=>t.id===id);
  if(!owned.has(id)||!current||current.url!==url||current.webSocketDebuggerUrl!==targetInfo.webSocketDebuggerUrl)throw Error('Owned capture target changed before resume');
  stage='resume';
  await callCdp(targetInfo,'Runtime.runIfWaitingForDebugger',{});
  stage='read';
  const read=await readEvidence(target);
  if(!read.ready||read.dom?.href!==url)throw Error('Owned capture evidence did not establish the exact room');
  success=true;
  return{status:'opened_target_chat',via_devtools:true,owned_capture:true,opened_by_devtools_search:true,
   conversation_target:targetInfo,conversation_evidence:read.evidence,evidence_attempts:read.attempts};
 }catch(error){outcome={status:'owned_capture_evidence_unavailable',via_devtools:true,stage,owned_target:{id,url},error:String(error.message).slice(0,200)};return outcome;}
 finally{if(!success&&targetInfo){const cleanup=await closeOwnedKakaoRoom(targetInfo,options);if(outcome)outcome.cleanup=cleanup;}}
}

// Evaluate the real composer tree, including Kakao's open shadow roots and frames.
export function buildOwnedDraftInspectionExpression() {
  return `(${function inspectOwnedDraft() {
    const visited = new Set();
    let hasDraft = false, unknown = false;
    function visit(root) {
      if (!root || visited.has(root)) return;
      visited.add(root);
      try {
        for (const el of root.querySelectorAll('textarea,input[type="text"],[contenteditable="true"]')) {
          // Autosizing libraries use a noninteractive hidden textarea containing a probe character.
          const style = el.ownerDocument?.defaultView?.getComputedStyle(el);
          const measurement = String(el.tagName).toUpperCase() === 'TEXTAREA'
            && el.getAttribute?.('aria-hidden') === 'true' && el.getAttribute?.('tabindex') === '-1'
            && style?.visibility === 'hidden' && style?.position === 'absolute'
            && el.getBoundingClientRect?.().height === 0 && root.activeElement !== el;
          if (!measurement && String('value' in el ? el.value : el.textContent || '').trim()) hasDraft = true;
        }
        for (const el of root.querySelectorAll('*')) {
          if (el.shadowRoot) visit(el.shadowRoot);
          if (String(el.tagName).toUpperCase() === 'IFRAME') {
            try { if (el.contentDocument) visit(el.contentDocument); else unknown = true; }
            catch { unknown = true; }
          }
        }
      } catch { unknown = true; }
    }
    visit(document);
    return { href: location.href, hasDraft: hasDraft ? true : unknown ? null : false };
  }.toString()})()`;
}
