import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {maybeAutoSendReply} from './worker.mjs';
import {recoveryRuntimeConfig} from '../kakao-dom-bridge/recovery-hold-policy.mjs';

test('a live reply can finish during historical recovery, but old/backfill/operator-disabled replies cannot',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'live-recovery-reply-'));
 try{
  const cutoff='2026-10-24T02:00:00.000Z',reply='확인했습니다.',hash=createHash('sha256').update(reply).digest('hex');
  const config=recoveryRuntimeConfig({autoSendEnabled:true,autoSendLogPath:path.join(directory,'replies.ndjson'),
   fetchImpl:async()=>({ok:true,text:async()=>JSON.stringify({data:[['active']]})})},{freezeBefore:cutoff});
  const decision={classification:'simple_ack',confidence:'high',kill_switch_observed:'active',customer:{name:'테스트'},
   reply_decision:{replyMode:'auto_send',confidence:'high',text:reply,safetyClass:'simple_ack',grounding:'visible_conversation',requiresRag:false},
   safety_checks:{kakao_conversation_opened:true,did_not_classify_from_preview_only:true,latest_customer_message_after_last_staff_reply:true}};
  const job={id:'live',sourceEventKey:'live-event',room_key:'live-room',detectedAt:new Date().toISOString(),preview_text:'테스트 문의',unread_count:1,events:[{reason:'top_rows_backstop',unread_count:1}]};
  let sends=0;
  const dependencies={sendKakaoMessage:async()=>{sends++;return{sent:true,readback_confirmed:true,observed_reply_hash:hash}}};
  const result=await maybeAutoSendReply({config,decision,job,navigationContext:{},dependencies});
  assert.equal(sends,1);assert.equal(result.sent,true);assert.ok(result.readbackReceipt);
  assert.equal(config.autoSendEnabled,false,'restoring one live job must not mutate the shared hold');
  const blocked=[{...job,id:'old',detectedAt:cutoff},{...job,id:'backfill',events:[{reason:'top_rows_backstop',unread_count:1,recoveryOnly:true}]},
   {...job,id:'startup',events:[{reason:'startup_catchup',unread_count:1}]}];
  for(const candidate of blocked){
   const before=sends,attempt=await maybeAutoSendReply({config,decision,job:candidate,navigationContext:{},dependencies});
   assert.equal(attempt.sent,false);assert.equal(sends,before);
  }
  const disabled=await maybeAutoSendReply({config:{...config,recoveryLiveAutoSendEnabled:false},decision,job:{...job,id:'disabled'},navigationContext:{},dependencies});
  assert.equal(disabled.sent,false);assert.equal(sends,1);
 }finally{await fs.rm(directory,{recursive:true,force:true})}
});
