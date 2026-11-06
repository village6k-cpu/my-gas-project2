import test from 'node:test';
import assert from 'node:assert/strict';
import {applyPlan} from './slack-heybilli-sync.mjs';

test('successful live sync persists through the API and makes no Slack announcement', async () => {
  const savedFetch=globalThis.fetch,calls=[];
  globalThis.fetch=async(url,request)=>{
    calls.push({url:String(url),body:JSON.parse(request.body)});
    assert.equal(String(url),'https://internal.test/slack-ops');
    return {ok:true,json:async()=>({ok:true,changed:true,duplicate:false,receipt:{id:'stored'}})};
  };
  try {
    const result=await applyPlan({channelId:'C0B6ZJZ2XU3',channelIds:['C0B6ZJZ2XU3'],apiUrl:'https://internal.test/slack-ops',apiToken:'fixture',writeEnabled:true},
      {channelId:'C0B6ZJZ2XU3',messageTs:'1.2',tradeId:'261106-001',actions:[]},new Set(['--write']));
    assert.equal(result.receipt.id,'stored');assert.equal(calls.length,1);
    assert.equal(calls[0].body.execute,true);
  } finally {globalThis.fetch=savedFetch;}
});

test('disabled writes stay blocked instead of announcing success', async () => {
  await assert.rejects(applyPlan({channelId:'C0B6ZJZ2XU3',channelIds:['C0B6ZJZ2XU3'],writeEnabled:false},
    {channelId:'C0B6ZJZ2XU3'},new Set(['--write'])),/live 쓰기를 차단/);
});
