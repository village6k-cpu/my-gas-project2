"""Resume an exact freshly owned blank target before waiting for navigation."""
def patch(source):
 s=source.replace('\r\n','\n')
 if "stage='load';" not in s:
  s=patch_wait(s)
 if 'owned_capture_diagnostic' not in s:
  s=s.replace("  stage='read';\n  const read=await readEvidence(target);","  stage='read';\n  await callCdp(targetInfo,'Page.setWebLifecycleState',{state:'active'});\n  const read=await readEvidence(target);\n  if(!read.ready||read.dom?.href!==url)console.warn(JSON.stringify({type:'owned_capture_diagnostic',stage,attempts:read.attempts,hintMatched:read.evidence?.hint_matched===true,messageCount:read.evidence?.messages?.length||0,hrefMatches:read.dom?.href===url,integrity:read.evidence?.capture_integrity||null}));")
  s=s.replace("}catch(error){outcome={status:'owned_capture_evidence_unavailable'","}catch(error){console.warn(JSON.stringify({type:'owned_capture_diagnostic',stage,errorClass:String(error.message).replace(/https?:\/\/\S+/g,'[url]').slice(0,180)}));outcome={status:'owned_capture_evidence_unavailable'")
 return s

def patch_wait(s):
 a=s.index('  let target;\n');b=s.index("  if(!target||target.type!=='page'",a)
 s=s[:a]+'''  let target;
  stage='load';
  for(let attempt=0;attempt<100;attempt++){
   target=(await fetchJson(cdpBaseUrl,'/json/list')).find(t=>t.id===id);
   if(target?.type==='page'&&target.webSocketDebuggerUrl&&[url,'about:blank'].includes(target.url)){
    // Target.createTarget proved this ID is new; a different agent's tab is
    // never eligible, even when another CDP client paused navigation at blank.
    if(!owned.has(id)||knownTargets.some(t=>t.id===id))throw Error('Owned capture creation proof changed');
    await callCdp(target,'Runtime.runIfWaitingForDebugger',{});
   }
   if(target?.type==='page'&&target.url===url&&target.webSocketDebuggerUrl)break;
   if(target&&![url,'about:blank',''].includes(target.url))throw Error('Owned capture redirected away from the exact room');
   await (options.sleepImpl||((ms)=>new Promise(r=>setTimeout(r,ms))))(100);
  }
'''+s[b:]
 return s
