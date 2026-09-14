'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const assert=require('node:assert/strict'),test=require('node:test');
const clone=x=>JSON.parse(JSON.stringify(x));
function validation(allowInvalid,values) {
  return {allowInvalid,values,copy(){let next=allowInvalid;return{setAllowInvalid(v){next=v;return this;},build(){return validation(next,values);}};}};
}
function row(name,qty=1,note='',id='RQ-260914-011') {
  const cells=Array(18).fill('');cells[0]=id;cells[5]=name;cells[6]=qty;cells[16]=note;return cells;
}
function harness(options={}) {
  const first=row('FX3');Object.assign(first,{1:'2026-09-20',2:'07:00',3:'2026-09-21',4:'22:00',8:'세트',10:'테스트',11:'01000000000',12:'일반',17:'수동 메모'});
  const original=[first,row('캡 / 배터리',1,'[세트]FX3')];
  const other=row('LVM',1,'다른 고객 메모','RQ-other');
  const cells=[['header'],...clone(original),other];const rules=new Map(),events=[];
  let failedWrite=false,afterWriteCalled=false;
  const defaultF=validation(false,['FX3','LVM']),defaultM=validation(false,['일반','학생']);
  const ruleAt=(r,c)=>rules.has(r+':'+c)?rules.get(r+':'+c):c===6?defaultF:c===13?defaultM:null;
  const sheet={
    getLastRow(){for(let i=cells.length-1;i>=0;i--)if(cells[i]?.some(v=>v!==''&&v!==null&&v!==undefined))return i+1;return 0;},
    getRange(r,c,n=1,w=1){
      const values=()=>Array.from({length:n},(_,i)=>Array.from({length:w},(_,j)=>cells[r+i-1]?.[c+j-1]??''));
      const each=fn=>{for(let i=0;i<n;i++)for(let j=0;j<w;j++)fn(r+i,c+j,i,j);};
      const range={getValues:values,getDisplayValues:()=>values().map(x=>x.map(String)),getValue:()=>values()[0][0],
        getDataValidations:()=>Array.from({length:n},(_,i)=>Array.from({length:w},(_,j)=>ruleAt(r+i,c+j))),
        setDataValidations(v){events.push(['validation',r,c,n,w]);if(options.validationError)throw new Error('synthetic validation setup failure');each((rr,cc,i,j)=>rules.set(rr+':'+cc,v[i][j]));return this;},
        setValues(v){events.push(['write',r,c,n,w]);let written=0;each((rr,cc,i,j)=>{const dv=ruleAt(rr,cc),value=v[i][j];
          if(dv?.allowInvalid===false && value!=='' && !dv.values.includes(String(value)))throw new Error('strict validation rejected '+rr+':'+cc);
          cells[rr-1]??=[];cells[rr-1][cc-1]=value;written++;
          if(options.partialWriteFailure&&!failedWrite&&w===18&&written===19){failedWrite=true;throw new Error('synthetic partial write');}
        });if(w===18&&!afterWriteCalled){afterWriteCalled=true;if(options.afterWrite)options.afterWrite(cells);}return this;},
        setValue(v){return this.setValues([[v]]);},clearContent(){events.push(['clear',r,c,n,w]);each((rr,cc)=>{cells[rr-1]??=[];cells[rr-1][cc-1]='';});return this;},
        setNumberFormat(){return this;},setFontWeight(){return this;},setBackground(){return this;}
      };return range;
    },
    deleteRows(r,n){events.push(['delete',r,n]);cells.splice(r-1,n);const entries=[...rules];rules.clear();for(const[k,v]of entries){let[rr,cc]=k.split(':').map(Number);if(rr>=r&&rr<r+n)continue;if(rr>=r+n)rr-=n;rules.set(rr+':'+cc,v);}if(options.deleteThrowsAfterApply)throw new Error('synthetic cutover response failure');},
    deleteRow(r){this.deleteRows(r,1);}
  };
  const ctx={Date,console,Logger:{log(){}},Utilities:{formatDate:d=>d.toISOString().slice(0,10)},SpreadsheetApp:{getActiveSpreadsheet:()=>({getSheetByName:name=>name==='확인요청'?sheet:null}),flush(){events.push(['flush']);}}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../checkAvailability.js'),'utf8'),ctx);
  const equipment=[{이름:'FX3',수량:1,결과:'세트',비고:''},{이름:'캡 / 배터리',수량:1,비고:'[세트]FX3'}];
  return {ctx,cells,events,ruleAt,original,other,request:{reqID:'RQ-260914-011',장비:equipment,skipCheck:true},
    run(req){return ctx._updateRequestUnderLock_(req);}, current(){return clone(cells.filter(r=>r[0]==='RQ-260914-011'));}};
}

test('in-place update saves uncatalogued original included components and preserves every non-F validation',()=>{
  const h=harness(),req=clone(h.request);req.장비[0].수량=2;req.장비[1].수량=2;
  const result=h.run(req);assert.equal(result.inPlace,true);assert.equal(h.current()[1][5],'캡 / 배터리');assert.equal(h.current()[1][6],2);
  assert.deepEqual(h.events.filter(e=>e[0]==='validation'),[['validation',2,6,2,1]]);
  assert.equal(h.ruleAt(2,6).allowInvalid,true);assert.deepEqual(h.ruleAt(2,6).values,['FX3','LVM']);
  assert.equal(h.ruleAt(2,13).allowInvalid,false);assert.equal(h.ruleAt(4,6).allowInvalid,false);assert.ok(!h.events.some(e=>e[0]==='delete'));
});

test('replacement stages all raw requested names before deleting old rows and requests later availability review',()=>{
  const h=harness(),req=clone(h.request);req.skipCheck=false;req.장비.push({이름:'H&Y 스텝업링 67-82',수량:1,비고:''});
  const result=h.run(req);assert.equal(result.recheck,true);assert.deepEqual(h.current().map(r=>r[5]),['FX3','캡 / 배터리','H&Y 스텝업링 67-82']);
  assert.deepEqual(h.cells.find(r=>r[0]==='RQ-other'),h.other);
  const write=h.events.findIndex(e=>e[0]==='write'&&e[2]===1&&e[4]===18),del=h.events.findIndex(e=>e[0]==='delete');
  assert.ok(write>=0&&del>write,'old rows must survive until replacement setValues and readback');
  assert.deepEqual(h.events.filter(e=>e[0]==='validation'),[['validation',5,6,3,1]]);
  assert.equal(h.ruleAt(3,6).allowInvalid,true);assert.equal(h.ruleAt(3,13).allowInvalid,false);
});

test('validation setup or partial staged write failure leaves the complete old request and no partial replacement',()=>{
  for(const options of [{validationError:true},{partialWriteFailure:true}]) {
    const h=harness(options),req=clone(h.request);req.장비.push({이름:'H&Y 스텝업링 67-82',수량:1,비고:''});
    assert.throws(()=>h.run(req),/synthetic/);assert.deepEqual(h.current(),h.original);assert.ok(!h.events.some(e=>e[0]==='delete'));assert.deepEqual(h.cells.find(r=>r[0]==='RQ-other'),h.other);
  }
});

test('invalid replacement time is rejected before deleting or writing the original request',()=>{
  const h=harness(),req=clone(h.request);req.장비.push({이름:'LVM',수량:1});req.반출시간='99:00';
  assert.throws(()=>h.run(req));assert.deepEqual(h.current(),h.original);assert.ok(!h.events.some(e=>e[0]==='delete'||e[0]==='write'));
});

test('other-column validation remains strict and a failed staged discount never removes original rows',()=>{
  const h=harness(),req=clone(h.request);req.장비.push({이름:'LVM',수량:1});req.할인유형='미승인 할인';
  assert.throws(()=>h.run(req),/strict validation/);assert.deepEqual(h.current(),h.original);assert.ok(!h.events.some(e=>e[0]==='delete'));
});

test('manual original-row changes during staging abort cutover without losing the manual change',()=>{
  const h=harness({afterWrite(cells){cells[1][17]='동시 직원 수정';}}),req=clone(h.request);req.장비.push({이름:'LVM',수량:1});
  assert.throws(()=>h.run(req),/changed|변경/);h.original[0][17]='동시 직원 수정';assert.deepEqual(h.current(),h.original);assert.ok(!h.events.some(e=>e[0]==='delete'));
});


test('staged readback mismatch cleans only the staged copy and retains the complete original',()=>{
  const h=harness({afterWrite(cells){cells[4][6]=99;}}),req=clone(h.request);req.장비.push({이름:'LVM',수량:1});
  assert.throws(()=>h.run(req),/readback/);assert.deepEqual(h.current(),h.original);assert.ok(!h.events.some(e=>e[0]==='delete'));
});

test('an ambiguous old-row deletion preserves the complete staged replacement for readback',()=>{
  const h=harness({deleteThrowsAfterApply:true}),req=clone(h.request);req.장비.push({이름:'H&Y 스텝업링 67-82',수량:1});
  let error;try{h.run(req);}catch(caught){error=caught;}
  assert.match(error?.message||'',/synthetic cutover/);assert.equal(error.outcomeUnknown,true);assert.equal(error.effectiveRequestId,req.reqID);
  assert.deepEqual(h.current().map(r=>r[5]),['FX3','캡 / 배터리','H&Y 스텝업링 67-82']);assert.ok(!h.events.some(e=>e[0]==='clear'));
});

test('noncontiguous original rows are cut over without touching the intervening request',()=>{
  const h=harness(),req=clone(h.request);h.cells.splice(2,0,h.cells.splice(3,1)[0]);req.장비.push({이름:'H&Y 스텝업링 67-82',수량:1});req.skipCheck=false;
  const result=h.run(req);assert.equal(result.recheck,true);assert.deepEqual(h.current().map(r=>r[5]),['FX3','캡 / 배터리','H&Y 스텝업링 67-82']);
  assert.deepEqual(h.cells.find(r=>r[0]==='RQ-other'),h.other);assert.equal(h.current()[0][7],'확인');
});
