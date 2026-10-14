const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../sheetAPI.js'),'utf8');
const from=source.indexOf('function getConfirmationRequestSchema_(');
const fn=source.slice(from,source.indexOf('\nfunction ',from+1));
test('advertised request contract does not reintroduce a catalog prerequisite for accepted raw demand',()=>{
 const ctx={};vm.runInNewContext(fn,ctx);const s=ctx.getConfirmationRequestSchema_();
 assert.doesNotMatch(s.formats.장비,/목록 시트의 정확한 장비명/);
 assert.match(s.formats.장비,/원문/);assert.match(s.notes,/장비명원문보존/);
 assert.match(s.notes,/단가/);assert.match(s.notes,/무료/);
 assert.ok(s.optional.includes('장비명원문보존'));
 assert.deepEqual(Array.from(s.required),['예약자명','장비']);
});
