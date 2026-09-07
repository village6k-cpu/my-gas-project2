import test from 'node:test';
import assert from 'node:assert/strict';
import {createImmutableKakaoRoomSnapshot} from './worker.mjs';
import {validateCustomerInquiryEvidence} from './inquiry-lifecycle.mjs';

test('customer evidence binds exact Unicode snapshot and rejects role, text and revision drift',()=>{
  const roomSnapshot=createImmutableKakaoRoomSnapshot({job:{jobId:'job',roomKey:'ＴＥＳＴ',roomRevision:7},navigationContext:{conversation_evidence:{title:'ＴＥＳＴ',visible_static_text_tail:'고객: 바꿔주세요',messages:[{message_id:'customer-7',role:'customer',order:1,text:'１대로 바꿔주세요'}]}}});
  const source={customer_request:roomSnapshot.navigation.conversation_evidence.messages[0].text,conversation_revision:7,conversation_evidence_hash:roomSnapshot.evidenceHash,customer_message_ids:['customer-7']};
  assert.deepEqual(validateCustomerInquiryEvidence(source,{roomRevision:7,roomSnapshot}),[]);
  for(const [key,value] of [['customer_request','2대로 바꿔주세요'],['conversation_revision',8],['customer_message_ids',['staff-1']]])
    assert.ok(validateCustomerInquiryEvidence({...source,[key]:value},{roomRevision:7,roomSnapshot}).length,key);
  const changed=structuredClone(roomSnapshot); changed.navigation.conversation_evidence.messages[0].role='staff';
  assert.ok(validateCustomerInquiryEvidence(source,{roomRevision:7,roomSnapshot:changed}).length);
});
