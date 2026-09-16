import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

// Execute the actual startup validation block without starting/stopping services.
function validate(contract){
  const source=readFileSync(new URL('../scripts/windows/start-kakao-live.ps1',import.meta.url),'utf8');
  const start=source.indexOf('    $modelContractPath =');
  const end=source.indexOf('\n}\n\nfunction Get-KakaoWatcherRuntime',start);
  assert.ok(start>0&&end>start,'startup model validation block exists');
  const dir=mkdtempSync(path.join(tmpdir(),'kakao-model-recovery-'));
  writeFileSync(path.join(dir,'hermes-model-contract.json'),JSON.stringify({kakaoworker:contract}));
  const script=path.join(dir,'probe.ps1');
  writeFileSync(script,`$ErrorActionPreference='Stop'\ntry {\n${source.slice(start,end)}\n[Console]::Out.Write('accepted')\n} catch { [Console]::Out.Write($_.Exception.Message) }\n`);
  return execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',script],{encoding:'utf8',windowsHide:true}).trim();
}

test('capture recovery accepts the configured model instead of pinning a previous provider',()=>{
  for(const contract of [
    {provider:'openai-codex',model:'gpt-5.6-sol',reasoning_effort:'high',max_turns:90},
    {provider:'xai-oauth',model:'grok-4.5',reasoning_effort:'high',max_turns:90},
    {provider:'configured-provider',model:'configured-model',reasoning_effort:'medium',max_turns:60}
  ])assert.equal(validate(contract),'accepted');
});

test('startup still rejects incomplete model contracts and invalid turn budgets',()=>{
  const valid={provider:'configured-provider',model:'configured-model',reasoning_effort:'high',max_turns:90};
  for(const change of [{provider:''},{model:''},{reasoning_effort:''},{max_turns:0},{max_turns:-1},{max_turns:'not-a-number'},{max_turns:1.5}])
    assert.notEqual(validate({...valid,...change}),'accepted');
});
