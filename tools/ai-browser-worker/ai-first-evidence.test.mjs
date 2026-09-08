import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {buildKakaoConversationTextExpression, createImmutableKakaoRoomSnapshot} from './worker.mjs';
import {validateStaffConfirmedRegistrationEvidence} from './staff-confirmed-registration.mjs';
import {validateCustomerInquiryEvidence} from './inquiry-lifecycle.mjs';

function fixture(messages) {
  const roomSnapshot = createImmutableKakaoRoomSnapshot({
    job: {jobId:'evidence-test', roomKey:'chat:evidence-test', roomRevision:7},
    navigationContext: {conversation_evidence: {
      title:'검증 고객', hint_matched:true,
      visible_static_text_tail:messages.map(row=>row.text).join('\n'), messages
    }}
  });
  const source = {
    customer_request:messages[0].text, staff_confirmation:messages[1].text,
    conversation_revision:7, conversation_evidence_hash:roomSnapshot.evidenceHash,
    customer_message_ids:['c1'], staff_message_ids:['s1']
  };
  return {source, options:{roomRevision:7, roomSnapshot}};
}

test('long unclassified messages remain usable as verbatim AI-selected customer and staff evidence',()=>{
  const {source,options} = fixture([
    {message_id:'c1',role:'unknown',text:'예약신청합니다\n9월 11일 18:00부터 13일 18:00까지\nFX3 풀세트, GM 렌즈세트, 숄더리그 부탁드립니다.'},
    {message_id:'s1',role:'unknown',text:'네 잡아드리겠습니다'},
    {message_id:'c2',role:'unknown',text:'견적서 하나 부탁드립니다!'}
  ]);
  assert.deepEqual(validateStaffConfirmedRegistrationEvidence(source,options),[]);
  assert.deepEqual(validateCustomerInquiryEvidence(source,options),[]);
  for (const invalid of [
    {...source,customer_message_ids:['missing']},
    {...source,staff_message_ids:['c1'],staff_confirmation:source.customer_request},
    {...source,conversation_revision:6},
    {...source,customer_request:'예약을 지어낸 내용'},
    {...source,conversation_evidence_hash:'f'.repeat(64)}
  ]) assert.ok(validateStaffConfirmedRegistrationEvidence(invalid,options).length);
});

test('AI-confirmed authorization is not vetoed by a later quote request or staff administrative reply',()=>{
  for (const tail of [
    {message_id:'c2',role:'customer',text:'견적서 하나 부탁드립니다!'},
    {message_id:'s2',role:'staff',text:'입금 계좌는 기존과 같습니다.'},
    {message_id:'c2',role:'unknown',text:'감사합니다. 견적서 부탁드립니다.'}
  ]) {
    const {source,options}=fixture([
      {message_id:'c1',role:'customer',text:'FX3 1대 내일 10시부터 모레 10시까지 부탁드립니다.'},
      {message_id:'s1',role:'staff',text:'네 잡아드리겠습니다'},tail
    ]);
    assert.deepEqual(validateStaffConfirmedRegistrationEvidence(source,options),[]);
  }
});

test('known opposing sender roles cannot be cited as authorization or customer inquiry',()=>{
  const {source,options}=fixture([
    {message_id:'c1',role:'staff',text:'카메라 대여 안내입니다'},
    {message_id:'s1',role:'customer',text:'네 제가 승인합니다'}
  ]);
  assert.ok(validateStaffConfirmedRegistrationEvidence(source,options).length);
  assert.ok(validateCustomerInquiryEvidence(source,options).length);
});

test('DOM extraction supplies bubble positions without converting width or center into sender authority',()=>{
  const doc={title:'고객',documentElement:{clientWidth:800},defaultView:{getComputedStyle:()=>({})},body:{innerText:'대화'}};
  const candidates=[['incoming',30,120],['outgoing',680,780],['',30,710],['',10,160],['',630,780],['incoming outgoing',30,710]]
    .map(([className,left,right],i)=>({
      className,id:'',ownerDocument:doc,parentElement:null,getAttribute:()=>null,closest:()=>null,
      getBoundingClientRect:()=>({left:0,right:800,top:i*40,width:800,height:30}),
      querySelector:()=>({getBoundingClientRect:()=>({left,right,top:i*40,width:right-left,height:30})}),
      cloneNode:()=>({innerText:`message ${i}`,querySelectorAll:()=>[]})
    }));
  doc.querySelectorAll=selector=>selector.includes('[data-message-id]')?candidates:[];
  const result=vm.runInNewContext(buildKakaoConversationTextExpression(),{document:doc,location:{href:'https://fixture.invalid'}});
  assert.deepEqual(Array.from(result.messages,row=>row.role),['customer','staff','unknown','unknown','unknown','unknown']);
  const {options}=fixture(result.messages);
  const wide=options.roomSnapshot.navigation.conversation_evidence.messages[2];
  assert.deepEqual(wide.layout,{left:30,right:710,viewport_width:800});
});
