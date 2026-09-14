import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../tools/ai-browser-worker/worker.mjs',import.meta.url),'utf8');
function functionSource(name){const start=source.indexOf(`function ${name}(`);assert.ok(start>=0,name);const end=source.indexOf('\nfunction ',start+1);return source.slice(start,end);}
function load(){const c={text:x=>String(x??''),decisionReply:d=>d.reply_decision||{}};for(const name of ['registeredMutationInventoryFollowUps','forceRegisteredMutationSuccess'])if(source.includes(`function ${name}(`))vm.runInNewContext(functionSource(name),c);return c;}
test('successful registration keeps verified supply warnings as actionable followup without repeating customer reply',()=>{
 const c=load();const receipt={trade_id:'260914-021',receipt_id:'receipt-1',authoritative_result:{inventoryWarnings:[{stage:'add',equipment:'camera',message:'camera: need 2, available 1'}]}};
 const result=c.forceRegisteredMutationSuccess({customer:{name:'customer'},follow_up_items:[]},receipt);
 assert.equal(result.post_action_reconciled,true);assert.equal(result.reply_decision.replyMode,'no_reply');assert.equal(result.owner_review_required,true);
 assert.equal(result.follow_up_items.length,1);assert.equal(result.follow_up_items[0].actionFamily,'inventory_check');assert.equal(result.follow_up_items[0].businessKey,'trade:260914-021');assert.match(result.follow_up_items[0].summary,/need 2/);
});
test('successful registration with no verified issue does not create repeat approval noise',()=>{
 const result=load().forceRegisteredMutationSuccess({follow_up_items:[{type:'reservation_review',status:'open'}]},{trade_id:'260914-021',authoritative_result:{}});
 assert.equal(result.owner_review_required,false);assert.equal(result.follow_up_items.length,0);
});
