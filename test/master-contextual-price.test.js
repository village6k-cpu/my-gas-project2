const test = require('node:test');
const assert = require('node:assert/strict');
const modulePromise = import('../tools/master-correction/contextual-price.mjs');
const qts = '1794448800.000001', ats = '1794448810.000002';
const base = () => ({ownerId:'UOWNER',botId:'BBILLY',threadTs:qts,questionTs:qts,answerTs:ats,messages:[{ts:qts,bot_id:'BBILLY',subtype:'bot_message',text:'폴리 1개 하루 기본 단가 얼마로 등록할까요?'},{ts:ats,thread_ts:qts,user:'UOWNER',text:'5000원'}]});
async function resolve(data) { return (await modulePromise).resolveContextualPrice(data); }
test('natural short answer resolves exact standing question without a new command',async()=>{
  assert.deepEqual(await resolve(base()),{kind:'price',scope:'standing',target:'폴리',price:5000,unit:'KRW/day',questionTs:qts,answerTs:ats,threadTs:qts});
});
test('comma amount, canonical model and daily basis retained',async()=>{
  const x=base();x.messages[0].text='Aputure 600D Pro 1개 1일 기본단가를 얼마로 등록할까요?';x.messages[1].text='15,000원.';
  assert.equal((await resolve(x)).price,15000);assert.equal((await resolve(x)).target,'Aputure 600D Pro');
});
const cases = {
 'different thread': x=>x.messages[1].thread_ts='1794448799.000001',
 'non-owner': x=>x.messages[1].user='USTAFF',
 'bot masquerading as owner': x=>x.messages[1].bot_id='BOTHER',
 'wrong question bot': x=>x.messages[0].bot_id='BOTHER',
 'edited answer': x=>x.messages[1].edited={ts:ats},
 'edited question': x=>x.messages[0].edited={ts:ats},
 'unit omitted': x=>x.messages[0].text='폴리 기본 단가 얼마로 등록할까요?',
 'multiple items': x=>x.messages[0].text='폴리, 매직암 1개 하루 기본 단가 얼마로 등록할까요?',
 'joined multiple items': x=>x.messages[0].text='폴리와 매직암 1개 하루 기본 단가 얼마로 등록할까요?',
 'intervening staff question': x=>x.messages.push({ts:'1794448805.000003',thread_ts:qts,user:'USTAFF',text:'매직암은요?'}),
 'this transaction question': x=>x.messages[0].text='이번 거래 폴리 1개 하루 기본 단가 얼마로 등록할까요?',
 'transaction exception answer': x=>x.messages[1].text='이번 건만 5000원',
 'free exception': x=>x.messages[1].text='무료',
 'malformed commas': x=>x.messages[1].text='5,00원',
 'unsafe integer': x=>x.messages[1].text='999999999999999999원',
 'cancelled answer': x=>x.messages[1].text='아니 취소',
 'later correction': x=>x.messages.push({ts:'1794448820.000003',thread_ts:qts,user:'UOWNER',text:'아니 6000원'}),
 'intervening question': x=>x.messages.push({ts:'1794448805.000003',thread_ts:qts,bot_id:'BBILLY',text:'매직암은요?'}),
 'intervening owner answer': x=>x.messages.push({ts:'1794448805.000003',thread_ts:qts,user:'UOWNER',text:'잠깐'}),
 'duplicate source': x=>x.messages.push({...x.messages[1]}),
 'missing question': x=>x.messages.shift(),
 'attachment answer': x=>x.messages[1].attachments=[{text:'5000원'}],
 'quotation embedded in answer': x=>x.messages[1].text='"5000원"',
 'future question pointer': x=>{x.questionTs=ats;x.answerTs=qts;},
};
for(const [name,mutate] of Object.entries(cases))test('reject: '+name,async()=>{const x=base();mutate(x);await assert.rejects(resolve(x),/needs_review:/);});
test('another thread cannot cancel this answer',async()=>{const x=base();x.messages.push({ts:'1794448820.000003',thread_ts:'1794448799.000001',user:'UOWNER',text:'취소'});assert.equal((await resolve(x)).price,5000);});
test('pure resolver leaves trusted input unchanged',async()=>{const x=base();const before=JSON.stringify(x);await resolve(x);assert.equal(JSON.stringify(x),before);});

test('without pointer discovers immediate preceding question',async()=>{const x=base();delete x.questionTs;assert.equal((await resolve(x)).questionTs,qts);});
test('without pointer does not skip intervening messages to find old question',async()=>{const x=base();delete x.questionTs;x.messages.push({ts:'1794448805.000003',thread_ts:qts,user:'USTAFF',text:'매직암은요?'});await assert.rejects(resolve(x),/needs_review:/);});

test('explicit zero standing amount is distinct from missing price',async()=>{const x=base();x.messages[1].text='0원';assert.equal((await resolve(x)).price,0);});

const createQuestion='폴리 세트마스터에 새 품목으로 등록하겠습니다. 구성은 폴리 1개입니다. 1개 하루 기본 단가 얼마로 등록할까요?';
const stockQuestion='폴리 세트마스터에 새 품목으로 등록하겠습니다. 구성은 폴리 1개입니다. 신규 재고는 폴리(대분류 기타, 카테고리 기타, 총보유 2개, 정비중 0개)입니다. 1개 하루 기본 단가 얼마로 등록할까요?';
test('ordinary price answer authorizes the named new catalog product and exact composition',async()=>{
 const x=base();x.messages[0].text=createQuestion;x.messages[1].text='5,000원';
 const r=await (await modulePromise).resolveContextualCreate(x);
 assert.equal(r.kind,'create');assert.equal(r.target,'폴리');assert.equal(r.price,5000);assert.deepEqual(r.components,[{name:'폴리',qty:1}]);
});
test('new physical inventory counts and classifications are bound to the same owner answer',async()=>{
 const x=base();x.messages[0].text=stockQuestion;
 const r=await (await modulePromise).resolveContextualCreate(x);
 assert.deepEqual(r.newEquipment,[{name:'폴리',major:'기타',category:'기타',stockTotal:2,stockMaintenance:0}]);
});
test('multiple known kit components retain their individual quantities',async()=>{
 const x=base();x.messages[0].text='인터뷰 세트 세트마스터에 새 품목으로 등록하겠습니다. 구성은 소니 A7S3 1개, NP-FZ100 3개입니다. 1개 하루 기본 단가 얼마로 등록할까요?';
 const r=await (await modulePromise).resolveContextualCreate(x);assert.deepEqual(r.components,[{name:'소니 A7S3',qty:1},{name:'NP-FZ100',qty:3}]);
});
test('canonical component names preserve model parentheses and slash spellings',async()=>{
 const x=base();x.messages[0].text='카메라/메모리 세트 세트마스터에 새 품목으로 등록하겠습니다. 구성은 레드 코모도 6K 바디(케이지) 1개, 소니 CFA/SD 리더기 1개입니다. 1개 하루 기본 단가 얼마로 등록할까요?';
 const r=await (await modulePromise).resolveContextualCreate(x);assert.equal(r.target,'카메라/메모리 세트');assert.equal(r.components[0].name,'레드 코모도 6K 바디(케이지)');
});
for(const [name,mutate] of Object.entries({
 'missing composition':x=>x.messages[0].text=createQuestion.replace('구성은 폴리 1개입니다. ',''),
 'trade exception':x=>x.messages[1].text='이번 고객만 무료',
 'non-owner':x=>x.messages[1].user='USTAFF',
 'edited plan':x=>x.messages[0].edited={ts:qts},
 'duplicate component':x=>x.messages[0].text=createQuestion.replace('폴리 1개입니다','폴리 1개, 폴리 2개입니다'),
 'invalid inventory count':x=>x.messages[0].text=stockQuestion.replace('총보유 2개','총보유 0개').replace('정비중 0개','정비중 1개'),
 'unrelated new inventory':x=>x.messages[0].text=stockQuestion.replace('재고는 폴리(','재고는 매직암('),
 'intervening question':x=>x.messages.push({ts:'1794448805.000003',thread_ts:qts,bot_id:'BBILLY',text:'다른 질문'})
}))test('new catalog rejects '+name,async()=>{const x=base();x.messages[0].text=createQuestion;mutate(x);await assert.rejects(Promise.resolve().then(async()=> (await modulePromise).resolveContextualCreate(x)),/needs_review:/);});
