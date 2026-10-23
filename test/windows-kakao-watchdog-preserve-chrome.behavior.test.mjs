import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const source=path.join(root,'scripts/windows/watch-kakao-production.ps1');
const windowsOnly={skip:process.platform!=='win32'};
function check(chromeHealthy,unhealthy) {
 const script=`$ErrorActionPreference='Stop'
 $tokens=$null; $errors=$null
 $ast=[System.Management.Automation.Language.Parser]::ParseFile('${source.replaceAll("'","''")}',[ref]$tokens,[ref]$errors)
 $fn=$ast.Find({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Assert-KakaoBroadRestartSafe'},$true)
 if($null -eq $fn){throw 'missing safety boundary'}
 Invoke-Expression $fn.Extent.Text
 function Get-UnhealthyComponents { param($Names) if(${chromeHealthy?'$false':'$true'}) {'chrome:process_gone_or_mismatch'} }
 function Write-WatchdogLog {param($Message)}
 try {Assert-KakaoBroadRestartSafe -UnhealthyComponents @(${unhealthy.map(x=>"'"+x+"'").join(',')}); 'allowed'} catch {'blocked:'+ $_.Exception.Message}
 `;
 return execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8'}).trim();
}
for(const failure of ['bridge:no_record','bridge:process_gone_or_mismatch','bridge:port_8787_closed']) {
 test('preserves healthy owned Chrome for '+failure,windowsOnly,()=>assert.match(check(true,[failure]),/^blocked:Healthy owned Chrome preserved/));
}
test('freshly recovered Chrome also blocks stale all-dead snapshot',windowsOnly,()=>assert.match(check(true,['chrome:process_gone_or_mismatch','bridge:no_record']),/^blocked:/));
test('all-dead runtime can still reach existing ownership-verified recovery',windowsOnly,()=>assert.equal(check(false,['chrome:no_record','bridge:no_record']),'allowed'));
test('guard executes before broad stop and does not launch bridge recovery',()=>{
 const s=fs.readFileSync(source,'utf8');const guard=s.indexOf('Assert-KakaoBroadRestartSafe -UnhealthyComponents $unhealthy');const stop=s.indexOf('& $stopScriptPath -Confirm:$false');assert.ok(guard>=0&&guard<stop);assert.ok(!s.includes('& $bridgeRecoveryScript'));
});
