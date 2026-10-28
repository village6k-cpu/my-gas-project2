// Only use with the already verified inspector session. No promises are awaited
// or resolved here, and neither PromiseResult nor user properties are emitted.
import {randomUUID} from 'node:crypto';

export async function censusPendingNativePromises(client,{maxObjects=4096}={}) {
  const report={schema:'village-native-promise-census/v1',complete:false,idle:false,
    reason:null,context_count:null,total_objects:null,inspected_objects:0,non_promise_inheritors:0,counts:{pending:null,fulfilled:null,rejected:null},stop_authorized:false};
  if(!Number.isSafeInteger(maxObjects)||maxObjects<1||maxObjects>16384)throw Error('Invalid native Promise census limit');
  const group='village-migration-census-'+randomUUID();
  const fail=reason=>({...report,reason});
  try {
    await client.command('Runtime.enable');
    report.context_count=client.contexts?.size ?? null;
    if(!(client.contexts instanceof Map)||client.contexts.size<1||!Number.isSafeInteger(client.contextRevision))return fail('execution_contexts_unavailable');
    const contextRevision=client.contextRevision;
    const contexts=[...client.contexts.keys()].sort((a,b)=>a-b);
    const counts={pending:0,fulfilled:0,rejected:0};report.total_objects=0;
    for(const contextId of contexts) {
    const prototype=await client.command('Runtime.evaluate',{expression:'Promise.prototype',contextId,
      returnByValue:false,throwOnSideEffect:true,objectGroup:group});
    if(prototype.exceptionDetails||!prototype.result?.objectId)return fail('promise_prototype_unavailable');
    const query=await client.command('Runtime.queryObjects',{prototypeObjectId:prototype.result.objectId,objectGroup:group});
    if(query.objects?.subtype!=='array'||!query.objects.objectId)return fail('promise_query_unavailable');
    const list=await client.command('Runtime.getProperties',{objectId:query.objects.objectId,ownProperties:true,generatePreview:false});
    const count=list.result?.find(p=>p.name==='length')?.value?.value;
    if(!Number.isSafeInteger(count)||count<0)return fail('promise_count_unavailable');
    report.total_objects+=count;
    if(report.total_objects>maxObjects)return fail('promise_object_limit');
    const objects=list.result.filter(p=>/^\d+$/.test(p.name)).sort((a,b)=>Number(a.name)-Number(b.name));
    if(objects.length!==count||objects.some((p,i)=>Number(p.name)!==i))return fail('promise_query_incomplete');
    for(const object of objects) {
      if(!object.value?.objectId)return fail('unclassified_promise_object');
      const details=await client.command('Runtime.getProperties',{objectId:object.value.objectId,ownProperties:true,generatePreview:false});
      const state=details.internalProperties?.find(p=>p.name==='[[PromiseState]]')?.value?.value;
      if(state===undefined && object.value.subtype!=='promise') {report.non_promise_inheritors++;report.inspected_objects++;continue;}
      if(!Object.hasOwn(counts,state))return fail('promise_state_unavailable');
      counts[state]++;report.inspected_objects++;
    }
    }
    if(client.contextRevision!==contextRevision||JSON.stringify([...client.contexts.keys()].sort((a,b)=>a-b))!==JSON.stringify(contexts))return fail('execution_contexts_changed');
    return {...report,complete:true,idle:counts.pending===0,counts};
  } catch {
    return fail('promise_census_failed');
  } finally {
    await client.command('Runtime.releaseObjectGroup',{objectGroup:group}).catch(()=>{});
  }
}
