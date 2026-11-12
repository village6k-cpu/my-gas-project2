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
