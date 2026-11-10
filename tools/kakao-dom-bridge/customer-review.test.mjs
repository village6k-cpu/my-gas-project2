import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {approveCustomerReview, queueCustomerReview, recordCustomerCompletion, queueCustomerCompletionDigest} from './customer-review.mjs';
import {flushPricingOwnerNotices} from '../ai-browser-worker/pricing-owner-notices.mjs';

async function setup(t) {
  const queueDir = await fs.mkdtemp(path.join(os.tmpdir(), 'village-review-test-'));
  t.after(() => fs.rm(queueDir, {recursive: true, force: true}));
  const now = Date.parse('2026-11-10T03:30:00Z');
  const config = {queueDir, pricingOwnerSlackUserId:'UOWNER', customerReportSlackChannelId:'CREPORT'};
  const job = {id:'job1', detectedAt:new Date(now - 5000).toISOString(),
    events:[{reason:'top_row_changed'}]};
  const decision = {customer:{name:'테스트 고객'},
    reply_decision:{replyMode:'draft_only',text:'감독님, 희망하시는 반납 시간을 알려주세요.'},
    follow_up_items:[{type:'reply_needed',requiresHumanAction:true}]};
  const snapshot = {roomKey:'chat:123',roomRevision:4,navigation:{conversation_evidence:{
    capture_integrity:{ok:true},hint_matched:true,messages:[{role:'customer'}]
  }}};
  return {now,config,job,prepared:{decision,snapshot},applied:{autoReplyResult:{}}};
}

test('only the owner can approve the exact posted draft, and a repeat cannot send again', async t => {
  const fixture = await setup(t);
  assert.equal(await queueCustomerReview(fixture), true);
  const dir = path.join(fixture.config.queueDir, 'pricing-owner-notices');
  let request;
  await flushPricingOwnerNotices(dir, {now:fixture.now,token:'fixture',
    fetchImpl:async (_url,opts)=>{
      request = JSON.parse(opts.body);
      return new Response(JSON.stringify({ok:true,channel:'CREPORT',ts:'1.000001'}));
    }});
  assert.equal(request.channel,'CREPORT');
  const button = request.blocks.at(-1).elements[0];
  const approved = {value:button.value, user_id:'UOWNER', channel_id:'CREPORT', message_ts:'1.000001'};
  let calls = 0;
  const apply = async ({prepared}) => {
    calls += 1;
    assert.equal(prepared.decision.reply_decision.text, fixture.prepared.decision.reply_decision.text);
    return {autoReplyResult:{sent:true}};
  };
  assert.equal((await approveCustomerReview(fixture.config,{...approved,user_id:'UOTHER'},fixture.now,apply)).state,'unavailable');
  assert.equal((await approveCustomerReview(fixture.config,{...approved,channel_id:'COTHER'},fixture.now,apply)).state,'expired');
  assert.equal((await approveCustomerReview(fixture.config,{...approved,message_ts:'2.000001'},fixture.now,apply)).state,'expired');
  assert.equal((await approveCustomerReview(fixture.config,approved,fixture.now,apply)).state,'sent');
  assert.equal((await approveCustomerReview(fixture.config,approved,fixture.now,apply)).state,'expired');
  assert.equal(calls,1);
});

test('missing requested PDF produces a review without a send button, and recovery is excluded', async t => {
  const f = await setup(t);
  f.prepared.decision.follow_up_items[0].type = 'quote_send';
  assert.equal(await queueCustomerReview({...f,job:{...f.job,replayedFromSupabase:true}}),false);
  assert.equal(await queueCustomerReview(f),true);
  const dir = path.join(f.config.queueDir,'pricing-owner-notices');
  const [file] = await fs.readdir(dir);
  const saved = JSON.parse(await fs.readFile(path.join(dir,file),'utf8'));
  assert.match(saved.text,/요청한 문서의 대상·품목·금액/);
  assert.equal(saved.approval,undefined);
});

test('success digest counts only readback and confirmed document delivery and deduplicates', async t => {
  const f = await setup(t);
  await recordCustomerCompletion(f.config,{...f.job,customerName:'테스트 고객'},{autoReplyResult:{sent:true,readbackReceipt:{id:'proof'},
    pricingDocumentReceipt:{documentType:'statement',deliveryConfirmed:true}}},f.now);
  await recordCustomerCompletion(f.config,{...f.job,id:'unconfirmed'},{autoReplyResult:{sent:true}},f.now);
  await queueCustomerCompletionDigest(f.config,f.now+3600000);
  await queueCustomerCompletionDigest(f.config,f.now+3600000);
  const dir = path.join(f.config.queueDir,'pricing-owner-notices');
  const [file,...others] = await fs.readdir(dir);
  assert.equal(others.length,0);
  const notice = await fs.readFile(path.join(dir,file),'utf8');
  assert.equal(JSON.parse(notice).channel,'CREPORT');
  assert.match(notice,/답변 1건 · 견적서 0건 · 거래명세서 1건/);
  assert.match(notice,/테스트 고객 · 답변 \/ 거래명세서/);
});

test('an exact matched inquiry with unknown speaker gets a draft card without send approval', async t => {
  const f = await setup(t);
  const evidence = f.prepared.snapshot.navigation.conversation_evidence;
  evidence.messages[0].role = 'unknown';
  assert.equal(await queueCustomerReview(f), false);
  evidence.capture_integrity.reason = 'trigger_message_observed';
  assert.equal(await queueCustomerReview(f), true);
  const dir = path.join(f.config.queueDir, 'pricing-owner-notices');
  const [file] = await fs.readdir(dir);
  const saved = JSON.parse(await fs.readFile(path.join(dir,file),'utf8'));
  assert.match(saved.text,/검토용 초안/);
  assert.match(saved.text,/발신자 구분을 확인/);
  assert.equal(saved.approval,undefined);
});
