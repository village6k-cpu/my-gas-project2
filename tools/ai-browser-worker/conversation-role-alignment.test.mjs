import test from 'node:test';
import assert from 'node:assert/strict';
import * as roles from './conversation-role-alignment.mjs';
import vm from 'node:vm';
import * as worker from './worker.mjs';

test('wide customer and staff bubbles retain roles from independently known edge anchors',()=>{
  const rows=[{role:'customer',left:30,right:120},{role:'staff',left:680,right:780},
    {role:'unknown',left:30,right:710},{role:'unknown',left:100,right:780},
    {role:'unknown',left:220,right:540}];
  assert.deepEqual(roles.resolveAlignedMessageRoles(rows).map(row=>row.role),['customer','staff','customer','staff','unknown']);
  assert.equal(rows[2].role,'unknown');
});
test('conflicting edges, nonfinite positions, and unanchored messages stay unknown',()=>{
  const rows=[{role:'customer',left:30,right:120},{role:'staff',left:680,right:780},
    {role:'unknown',left:30,right:780},{role:'unknown',left:NaN,right:780}];
  assert.deepEqual(roles.resolveAlignedMessageRoles(rows).slice(2).map(row=>row.role),['unknown','unknown']);
  assert.equal(roles.resolveAlignedMessageRoles([{role:'unknown',left:30,right:120}])[0].role,'unknown');
});

test('capture expression aligns actual bubble edges when wrappers span the whole conversation',()=>{
  const doc={title:'고객',documentElement:{clientWidth:800},defaultView:{getComputedStyle:()=>({})},body:{innerText:'대화'}};
  const candidates=[['incoming',30,120],['outgoing',680,780],['',30,710]].map(([className,left,right],i)=>({
    className,id:'',ownerDocument:doc,parentElement:null,
    getAttribute:()=>null,closest:()=>null,
    getBoundingClientRect:()=>({left:0,right:800,top:i*40,width:800,height:30}),
    querySelector:()=>({getBoundingClientRect:()=>({left,right,top:i*40,width:right-left,height:30})}),
    cloneNode:()=>({innerText:`message ${i}`,querySelectorAll:()=>[]})
  }));
  doc.querySelectorAll=selector=>selector.includes('[data-message-id]')?candidates:[];
  assert.equal(typeof worker.buildKakaoConversationTextExpression,'function');
  const result=vm.runInNewContext(worker.buildKakaoConversationTextExpression(),{document:doc,location:{href:'https://fixture.invalid'}});
  assert.deepEqual(Array.from(result.messages,row=>row.role),['customer','staff','customer']);
});
