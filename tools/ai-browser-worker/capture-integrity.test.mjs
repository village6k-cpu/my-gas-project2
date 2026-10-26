import test from 'node:test';
import assert from 'node:assert/strict';
import {assessKakaoCaptureIntegrity} from './capture-integrity.mjs';
const evidence={visible_static_text_tail:['ready body'],messages:[{text:'latest confirmation'}]};
test('current trigger must be observed in actual bubbles rather than a stale preview or memo',()=>{
 assert.equal(assessKakaoCaptureIntegrity(evidence,{messagePreview:'latest confirmation'}).ok,true);
 assert.equal(assessKakaoCaptureIntegrity({...evidence,visible_static_text_tail:['missing trigger'],messages:[{text:'older bubble'}]},{messagePreview:'missing trigger'}).ok,false);
});
test('disconnected room remains blocked even when the matching latest message was rendered',()=>{
 assert.deepEqual(assessKakaoCaptureIntegrity({...evidence,visible_static_text_tail:['연결 끊김']},{messagePreview:'latest confirmation'}),{ok:false,reason:'conversation_disconnected'});
});
test('structured media trigger remains readable while disconnect protection is preserved',()=>{
 assert.equal(assessKakaoCaptureIntegrity(evidence,{messagePreview:'사진 2장'}).ok,true);
 assert.equal(assessKakaoCaptureIntegrity({...evidence,visible_static_text_tail:['대화가 불가능한 상태입니다']},{messagePreview:'사진 2장'}).ok,false);
});
test('stored failed capture proof cannot be reinterpreted as usable snapshot evidence',()=>{
 assert.equal(assessKakaoCaptureIntegrity({...evidence,capture_integrity:{ok:false,reason:'trigger_message_missing'}},{messagePreview:'latest confirmation'}).ok,false);
});
