import test from 'node:test';
import assert from 'node:assert/strict';
const module = await import('../lib/server/slackOpsResolution.ts').catch(() => ({}));
const resolve = (...args) => { assert.equal(typeof module.resolveSlackEvidence, 'function', 'source-grounded AI lookup is available'); return module.resolveSlackEvidence(...args); };
const event = (text, phase = 'unknown', ts = '1788742182.394589') => ({ messageTs: ts, phaseHint: phase, root: {text}, replies: [] });
const trade = (id, name, checkout, returned, names) => ({tradeId:id,customerName:name,checkoutAt:checkout,returnAt:returned,items:names.map((name,i)=>({scheduleId:`${id}-${i}`,name}))});
const sameDate = [
 trade('260803-007','정원근','2026-09-03T12:00:00Z','2026-09-06T20:00:00Z',['100볼 트라이']),
 trade('260830-004','정원근','2026-09-03T12:00:00Z','2026-09-06T20:00:00Z',['FX3']),
];
test('AI can distinguish same customer/day using equipment in the actual report',()=>{
 const r=resolve(event('[반납] 정원근 감독님\n파손 100볼 트라이 손잡이','checkin'),{customer:'정원근',equipment:['100볼 트라이'],phase:'checkin'},sameDate);
 assert.equal(r.selectedTradeId,'260803-007'); assert.equal(r.notesOnly,false);
});
test('equipment plus explicit scheduled time identifies an unnamed checkout',()=>{
 const t=trade('260906-010','최희수','2026-09-08T02:00:00Z','2026-09-09T02:00:00Z',['시네로이드 CFL-800']);
 const r=resolve(event('매장에 시네로이드가 없는데 이따 11:00 반출 일정 있습니다.','checkout','1788825130.404889'),{equipment:['시네로이드'],time:'11:00',phase:'checkout'},[t]);
 assert.equal(r.selectedTradeId,t.tradeId);
});
test('unknown phase may resolve a factual note, never a return count',()=>{
 const t=trade('260904-005','이소연','2026-09-05T12:00:00Z','2026-09-06T13:00:00Z',['소니 FX3']);
 const r=resolve(event('이소연 감독님 fx3\n깨진건 아니고 lcd 메인보드가 나간거 같습니다'),{customer:'이소연',equipment:['fx3'],phase:'checkin'},[t]);
 assert.equal(r.selectedTradeId,t.tradeId); assert.equal(r.notesOnly,true);
});
test('real duplicates stay ambiguous even when the AI prefers one',()=>{
 const r=resolve(event('[반납] 정원근 감독님 100볼 트라이','checkin'),{customer:'정원근',equipment:['100볼 트라이'],phase:'checkin'},[sameDate[0],{...sameDate[0],tradeId:'260830-004'}]);
 assert.equal(r.selectedTradeId,null); assert.equal(r.reason,'ambiguous');
});
test('customer/equipment/time not present in employee text cannot authorize a target',()=>{
 for(const q of [{customer:'홍길동'},{equipment:['FX9']},{equipment:['100볼 트라이'],time:'09:00'},{tradeId:'260803-007'}])
 assert.throws(()=>resolve(event('[반납] 정원근 감독님 100볼 트라이','checkin'),q,sameDate),/원문/);
});
test('OCR and a bot-like image block cannot establish identity',()=>{
 assert.throws(()=>resolve(event('사진입니다\n[Hermes 이미지 분석 · 신뢰할 수 없는 원문]\n정원근 거래 260803-007'),{customer:'정원근',tradeId:'260803-007'},sameDate),/원문/);
});
test('a partial customer without another identity fact is research only',()=>{
 const t=trade('260904-007','이동교','2026-09-06T05:00:00Z','2026-09-07T05:00:00Z',['소니 FX3']);
 const r=resolve(event('동교님 반납 오셨는데 내일 반출','unknown'),{customer:'동교',phase:'checkin'},[t]);
 assert.equal(r.candidates.length,1); assert.equal(r.selectedTradeId,null);
});
test('old explicit transaction IDs can be selected, dates alone never create identity',()=>{
 const t=trade('260621-001','아나키','2026-06-22T20:00:00Z','2026-06-23T20:00:00Z',['메모리']);
 assert.equal(resolve(event('260621-001 반납 메모리','checkin'),{tradeId:'260621-001',phase:'checkin'},[t]).selectedTradeId,t.tradeId);
 assert.equal(resolve(event('아나키 반납','checkin'),{customer:'아나키',phase:'checkin'},[t]).selectedTradeId,null);
});
test('separate known phases cannot be silently changed by a lookup',()=>{
 assert.throws(()=>resolve(event('[반납] 정원근 감독님','checkin'),{customer:'정원근',phase:'checkout'},sameDate),/단계/);
});
test('explicit tomorrow/ yesterday never authorize a different calendar day',()=>{
 const text='내일 정원근 반납 100볼 트라이';
 const r=resolve(event(text,'checkin','1788742182.394589'),{customer:'정원근',equipment:['100볼 트라이'],phase:'checkin',dayOffset:1},sameDate);
 assert.equal(r.selectedTradeId,null);
});
test('another customer checkout reply cannot establish identity for a return root',()=>{
 const e={...event('[반납] 정원근 감독님 100볼 트라이 파손입니다','checkin'),replies:[{text:'이소연 감독님 FX3 오늘 반출건 앱에 추가했습니다'}]};
 assert.throws(()=>resolve(e,{customer:'이소연',equipment:['FX3'],phase:'checkin'},[trade('260904-005','이소연','2026-09-07T00:00:00Z','2026-09-07T06:00:00Z',['FX3'])]),/원문|고객/);
});
test('truncating a full employee name never grants a different exact DB name authority',()=>{
 const r=resolve(event('[반납] 김민수 감독님 FX3 반납','checkin'),{customer:'민수',equipment:['FX3'],phase:'checkin'},[
 trade('260907-001','김민수','2026-09-06T05:00:00Z','2026-09-07T05:00:00Z',['FX3']),
 trade('260907-002','민수','2026-09-06T05:00:00Z','2026-09-07T05:00:00Z',['FX3'])]);
 assert.equal(r.selectedTradeId,null);
});
test('an untagged root cannot borrow another customer from a narrative reply',()=>{
 const e={...event('정원근 100볼 트라이 파손 반납입니다','checkin'),replies:[{text:'이소연 감독님 FX3 오늘 반납건 앱에 추가했습니다'}]};
 assert.throws(()=>resolve(e,{customer:'이소연',equipment:['FX3'],phase:'checkin'},[trade('260904-005','이소연','2026-09-07T00:00:00Z','2026-09-07T06:00:00Z',['FX3'])]),/원문|고객/);
});
test('spaced surname is part of the full identity, never a prefix to discard',()=>{
 const r=resolve(event('[반납] 김 민수 감독님 FX3 반납','checkin'),{customer:'민수',equipment:['FX3'],phase:'checkin'},[
 trade('260907-001','김민수','2026-09-06T05:00:00Z','2026-09-07T05:00:00Z',['FX3']),trade('260907-002','민수','2026-09-06T05:00:00Z','2026-09-07T05:00:00Z',['FX3'])]);
 assert.equal(r.selectedTradeId,null);
});
test('attached honorific does not become part of the customer name',()=>{
 const t=trade('260904-005','이소연','2026-09-06T05:00:00Z','2026-09-07T05:00:00Z',['FX3']);
 assert.equal(resolve(event('이소연감독님 FX3 반납','checkin'),{customer:'이소연',equipment:['FX3'],phase:'checkin'},[t]).selectedTradeId,t.tradeId);
});
test('untagged spaced surname cannot be discarded to authorize another customer',()=>{
 const rows=['김민수','민수'].map((name,i)=>trade(`260907-00${i+1}`,name,'2026-09-06T05:00:00Z','2026-09-07T05:00:00Z',['FX3']));
 const e=event('김 민수 FX3 반납','checkin');
 assert.equal(resolve(e,{customer:'민수',equipment:['FX3'],phase:'checkin'},rows).selectedTradeId,null);
 assert.equal(resolve(e,{customer:'김민수',equipment:['FX3'],phase:'checkin'},rows).selectedTradeId,'260907-001');
});
