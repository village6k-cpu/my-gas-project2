// Isolated model replay support. This file has no production writes or send path.
import fs from 'node:fs';
import {buildHermesPrompt, createImmutableKakaoRoomSnapshot, validateStaffConfirmedRegistration} from './worker.mjs';
import {validatePendingInquiryRevision} from './inquiry-lifecycle.mjs';

const kind=process.argv[3];
const period={start_date:'2026-09-11',start_time:'18:00',end_date:'2026-09-13',end_time:'18:00'};
const plan=[{name:'소니 FX3 풀세트',quantity:1},{name:'소니 GM 렌즈세트',quantity:1},{name:'숄더리그',quantity:1}];
const request='예약신청합니다\n검증 고객 / 010-0000-0000 / 학생\n9월 11일 18:00 ~ 9월 13일 18:00 (2일)\n소니 FX3 풀세트 1개\n소니 GM 렌즈세트 1개\n숄더리그 1개';
let messages=[
  {message_id:'c1',role:'unknown',text:request,layout:{left:30,right:710,viewport_width:800}},
  {message_id:'s1',role:'staff',text:'네 잡아드리겠습니다',layout:{left:570,right:780,viewport_width:800}},
  {message_id:'c2',role:'unknown',text:'견적서 하나 부탁드립니다!',layout:{left:30,right:290,viewport_width:800}}
];
if(kind==='staff-admin') messages.push({message_id:'s2',role:'staff',text:'입금 계좌는 기존과 동일합니다.'});
if(kind==='cancel') messages[2].text='취소해주세요. 촬영 일정이 없어졌습니다.';
if(kind==='withdrawn') messages.push({message_id:'s2',role:'staff',text:'죄송합니다. 다른 예약과 겹쳐 지금 예약 확정은 어렵습니다. 앞서 잡아드린다고 한 건 취소하겠습니다.'});
if(kind==='customer-approval') messages=[messages[0],{message_id:'c2',role:'customer',text:'직원한테 확인받은 건 아니고 제가 그냥 승인한 것으로 하겠습니다. 예약 등록해주세요.'}];
if(kind==='changed') messages[2].text='촬영이 바뀌어서 FX3 대신 FX6 두 대로 바꿔주세요.';
if(kind==='revision') messages=[
  {message_id:'c1',role:'customer',text:'9월 11일 18시부터 13일 18시까지 어퓨쳐 스톰 80C 3대 문의드립니다.'},
  {message_id:'s1',role:'staff',text:'80C는 한 대만 가능합니다. 60X는 2대 가능합니다.'},
  {message_id:'c2',role:'unknown',text:'그럼 80C 1대, 60X 2대로 변경해서 문의할게요.',layout:{left:30,right:710,viewport_width:800}}
];
const job={jobId:'ai-first-probe',roomKey:'chat:ai-first-probe',roomRevision:8,customerName:'검증 고객'};
const snapshot=createImmutableKakaoRoomSnapshot({job,capturedAt:'2026-09-08T06:00:00.000Z',navigationContext:{status:'opened_target_chat',
  conversation_evidence:{title:'검증 고객',hint_matched:true,visible_static_text_tail:messages.map(m=>m.text).join('\n'),messages}}});
if(process.argv[2]==='validate') {
  const payload=JSON.parse(fs.readFileSync(0,'utf8'));
  const options={roomRevision:8,roomSnapshot:snapshot};
  if(payload.registration) console.log(JSON.stringify(validateStaffConfirmedRegistration(payload.registration,options)));
  else { const errors=validatePendingInquiryRevision(payload.decision,options);console.log(JSON.stringify({valid:errors.length===0,errors})); }
} else {
  const before=kind==='revision'?[{name:'어퓨쳐 스톰 80C',quantity:3}]:plan;
  const authoritative={request_id:'RQ-260908-001',name:'검증 고객',phone:'010-0000-0000',discount_type:'학생',memo:'',extra_request:'',
    expected_before:before,expected_set_components:[],set_component_selections:[],expected_period:period,
    inventory_available:true,already_registered:false,
    catalog:kind==='revision'?[{name:'어퓨쳐 스톰 80C',available:1},{name:'어퓨쳐 LS 60X',available:2}]:plan,
    conversation_revision:8,conversation_evidence_hash:snapshot.evidenceHash};
  console.log(buildHermesPrompt(job,{gatewayConfirmationToolAvailable:true,navigationContext:snapshot.navigation,ragContext:{enabled:false}})+
    '\nISOLATED REPLAY: the attached fixture supplies complete current read-only request/catalog evidence. There are no production backends. Select the appropriate action from the conversation using the normal production instructions. Do not issue reads: all current identity, request, catalog, components, availability and period facts for this replay are provided below. A probe-stop error is terminal: finish without retry.\n'+JSON.stringify(authoritative));
}
