import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../../checkAvailability.js',import.meta.url),'utf8');
const context=vm.createContext({});vm.runInContext(source,context);
const names=['소니 GM 70-200mm','소니 GM 70-200mm II'];
const groups=[{name:'70-200',candidates:names}];

test('GAS accepts AI catalog family candidates before writing and rejects invented or selected models',()=>{
  assert.equal(context._normalizeAiModelCandidates_(groups,[{이름:'70-200',수량:2}],names)[0].name,'70-200');
  for(const invalid of [
    [{name:'unknown row',candidates:names}], [{name:names[0],candidates:names}],
    [{name:'70-200',candidates:[names[0],'없는 렌즈']}], [{name:'70-200',candidates:[names[0],names[0]]}]
  ]) assert.throws(()=>context._normalizeAiModelCandidates_(invalid,[{이름:'70-200',수량:2}],names));
});

test('AI model choices persist through recheck but expire after selecting a model or catalog removal',()=>{
  const cells={};const sheet={getRange(row,col){const key=row+':'+col;return {
    setValue(value){cells[key]=value;return this;},setBackground(){return this;},setNote(note){cells[key+':note']=note;return this;}
  };}};
  context._setModelSelectionPrompt_(sheet,2,'70-200',names,'');
  assert.equal(cells['2:9'],'⚠️ 모델 선택 필요');
  assert.ok(cells['2:10'].includes(names[1]));
  const note=cells['2:6:note'];
  assert.deepEqual(Array.from(context._modelCandidatesFromPromptNote_(note,'70-200',names)),names);
  assert.equal(context._modelCandidatesFromPromptNote_(note,names[0],names).length,0);
  assert.equal(context._modelCandidatesFromPromptNote_(note,'70-200',[names[0]]).length,0);
});

test('candidate presentation does not change another request or a registered booking',()=>{
  const row=(id,name,status='',trade='')=>[id,'','','','',name,'','','','','','','','',status,trade,'',''];
  const rows=[row('RQ-1','70-200'),row('RQ-2','70-200'),row('RQ-1','70-200','등록완료','260908-011')];
  const touched=[];
  const sheet={getLastRow:()=>4,getRange(row,col,count,cols){return{
    getDisplayValues:()=>rows,setValue(){touched.push([row,col]);return this;},setBackground(){return this;},setNote(){return this;}
  };}};
  context._applyAiModelCandidatePrompts_(sheet,'RQ-1',groups);
  assert.deepEqual(touched,[[2,9],[2,10]]);
});
