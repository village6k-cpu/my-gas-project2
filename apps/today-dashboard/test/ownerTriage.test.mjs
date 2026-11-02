import test from 'node:test';
import assert from 'node:assert/strict';
import {isArchived,isCritical,parseRestore,triageItem,groupCritical} from '../lib/followups/triage.mjs';
const id='029942b7-7bc8-4a26-91a5-dbdc9f340668';
test('unknown or invalid amounts remain unknown',()=>{
 for(const value of [null,undefined,'',-1,'unknown',Infinity]) assert.equal(triageItem({payload:{owner_triage_balance:value}}).balance,null);
 assert.equal(triageItem({payload:{owner_triage_balance:'0'}}).balance,0);
 assert.equal(triageItem({payload:{owner_triage_balance:'500000'}}).balance,500000);
});
test('bank receipts and balances stay separate; duplicate cards are not summed',()=>{
 const a=triageItem({id,room_key:'a',title:'고객 확인',payload:{owner_triage_balance:'500000',owner_triage_unallocated:'600000'}});
 const groups=groupCritical([a,{...a,id:'other'}]);
 assert.equal(groups.length,1);assert.equal(groups[0].items.length,2);assert.equal(groups[0].items[0].balance,500000);assert.equal(groups[0].items[0].unallocated,600000);assert.equal(groups[0].balance,undefined);
});
test('only cleanup archives are restorable and closed cards are not active risks',()=>{
 assert.equal(isArchived({state:'dismissed',resolution_kind:'owner_archived_reset'}),true);
 assert.equal(isArchived({state:'dismissed',resolution_kind:'owner_completed'}),false);
 assert.equal(isCritical({state:'resolved',payload:{owner_triage:'critical'}}),false);
 assert.equal(isCritical({state:'open',payload:{owner_triage:'critical'}}),true);
});
test('restoration requires a valid identity and version and rejects state overrides',()=>{
 assert.deepEqual(parseRestore({id,expectedVersion:2}),{id,expectedVersion:2});
 for(const body of [{id,expectedVersion:0},{id,expectedVersion:'2'},{id:'bad',expectedVersion:2},{id,expectedVersion:2,state:'resolved'}]) assert.throws(()=>parseRestore(body));
});
test('malformed evidence never invents a trade reference',()=>{
 assert.deepEqual(triageItem({payload:{owner_triage_accounts:'bad'}}).accounts,[]);
 const item=triageItem({payload:{owner_triage_accounts:JSON.stringify([{tradeId:'not-a-trade'},{tradeId:'261029-011',balance:1000,paid:2000}])}});
 assert.equal(item.accounts.length,1);assert.equal(item.accounts[0].balance,1000);
});
