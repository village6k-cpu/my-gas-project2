[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$ManifestPath,
    [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{64}$')][string]$ManifestSha256,
    [Parameter(Mandatory)][string]$ControlDirectory,
    [switch]$ValidateOnly,
    [switch]$Run
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
if($ValidateOnly.IsPresent -eq $Run.IsPresent){throw 'Select exactly one explicit mode'}
$stage=[IO.Path]::GetFullPath('C:/Village/migration-staging/studio-20260930/resume-20261027')
$control=[IO.Path]::GetFullPath($ControlDirectory)
if($control -ine (Join-Path $stage 'scheduler-fence-v2')){throw 'Unexpected control directory'}
$manifestFile=[IO.Path]::GetFullPath($ManifestPath)
if($manifestFile -ine (Join-Path $stage 'scheduler-fence-manifest-v7.json')){throw 'Unexpected manifest location'}
if((Get-FileHash -LiteralPath $manifestFile -Algorithm SHA256).Hash -ine $ManifestSha256){throw 'Manifest hash changed'}
$manifest=Get-Content -LiteralPath $manifestFile -Raw | ConvertFrom-Json
if($manifest.schema -cne 'village-scheduler-fence/v1'){throw 'Unexpected scheduler manifest'}
$module=Join-Path $PSScriptRoot 'MigrationTaskFence.Common.psm1'
if((Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash -ine $manifest.brokerSha256 -or
   (Get-FileHash -LiteralPath $module -Algorithm SHA256).Hash -ine $manifest.moduleSha256){throw 'Reviewed controller code changed'}
Import-Module $module -Force
Assert-VillageMigrationTaskInventory @($manifest.tasks)

function Assert-TaskDefinition($Name){
    $expected=@($manifest.tasks | Where-Object {$_.name -ceq $Name})
    $xml=Export-ScheduledTask -TaskName $Name -TaskPath '\'
    if($expected.Count -ne 1 -or (Get-VillageMigrationTaskDefinitionHash $xml) -cne $expected[0].definitionSha256){throw 'Source task definition changed'}
}
function Assert-RecoveryBindings {
    $incident='C:/Village/task-artifacts/20261022-reservation-incident/audit/incident-startup-fences-20261024'
    $runtime='C:/Village/runtimes/my-gas-project2-production'
    $required=@("$incident/guarded-runtime.ps1","$incident/guarded-lifecycle.psm1","$incident/lifecycle-config.json",
        "$runtime/scripts/windows/KakaoStaging.Common.psm1","$runtime/scripts/windows/KakaoLive.Common.psm1")
    if(@($manifest.recoveryFiles).Count -lt $required.Count){throw 'Incomplete guarded recovery bindings'}
    foreach($path in $required){
        $matches=@($manifest.recoveryFiles | Where-Object {[IO.Path]::GetFullPath($_.path) -ieq [IO.Path]::GetFullPath($path)})
        if($matches.Count -ne 1){throw 'Missing or duplicate guarded recovery dependency'}
    }
    foreach($binding in $manifest.recoveryFiles){
        if($binding.sha256 -cnotmatch '^[a-f0-9]{64}$' -or (Get-FileHash -LiteralPath $binding.path -Algorithm SHA256).Hash -ine $binding.sha256){throw 'Guarded recovery dependency changed'}
    }
}
Assert-RecoveryBindings

function Read-TaskSnapshot {
    $rows=@()
    foreach($name in Get-VillageMigrationTaskNames){
        $task=Get-ScheduledTask -TaskName $name -TaskPath '\'
        $xml=Export-ScheduledTask -TaskName $name -TaskPath '\'
        $expected=@($manifest.tasks | Where-Object {$_.name -ceq $name})
        if($expected.Count -ne 1 -or (Get-VillageMigrationTaskDefinitionHash $xml) -cne $expected[0].definitionSha256){throw 'Source task definition changed'}
        $rows+=[pscustomobject]@{name=$name;path='\';enabled=[bool]$task.Settings.Enabled;state=[string]$task.State;xml=$xml}
    }
    return $rows
}
function Assert-NativeInactive {
    # Fixed read-only command on the already verified destination. No shell input
    # from a broker request, no remote mutation, and no credential in argv/output.
    $probe=@'
import json,os,pathlib,subprocess
p=pathlib.Path('/Users/choijaehyeong/VillageMigration/20260930-windows/candidate')
names=['root','worker','bridge','voice','relay','chrome','watcher','inventory-brief','ledger-sheet-sync','preflight','return-issues','setmaster-reconcile','tax-tracks-sync','weekly-brain-card','corrections-nightly','inventory-stock-relay']
uid=os.getuid();domain='gui/'+str(uid)
domain_check=subprocess.run(['launchctl','print',domain],stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,text=True,timeout=10)
services=[]
if domain_check.returncode==0:
 for name in names:
  label='com.village.migrated.'+name
  result=subprocess.run(['launchctl','print',domain+'/'+label],stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,text=True,timeout=10)
  services.append({'label':label,'exitCode':result.returncode,'diagnostic':result.stderr})
print(json.dumps({'inactive':(p/'MIGRATION-INACTIVE').is_file() and not (p/'ACTIVATION.json').exists(),'domainVerified':domain_check.returncode==0,'uid':uid,'services':services}))
'@
    $ssh=Join-Path $env:SYSTEMROOT 'System32/OpenSSH/ssh.exe'
    # Send the fixed ASCII program over stdin; PowerShell 5.1 strips nested
    # command quotes when forwarding a python -c argument through native SSH.
    $output=$probe | & $ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=8 -o ServerAliveInterval=5 -o ServerAliveCountMax=2 -i 'C:/Users/ssper/.ssh/village_macmini_migration' 'choijaehyeong@100.103.83.1' '/usr/bin/python3 -'
    if($LASTEXITCODE -ne 0){throw 'Fresh native inactivity could not be verified'}
    $proof=$output | ConvertFrom-Json
    if($proof.inactive -ne $true -or $proof.domainVerified -ne $true -or $proof.uid -ne 501 -or @($proof.services).Count -ne 16){throw 'Native inactivity inspection is incomplete; source unfence forbidden'}
    $names=@('root','worker','bridge','voice','relay','chrome','watcher','inventory-brief','ledger-sheet-sync','preflight','return-issues','setmaster-reconcile','tax-tracks-sync','weekly-brain-card','corrections-nightly','inventory-stock-relay')
    foreach($name in $names){
        $label='com.village.migrated.'+$name
        $rows=@($proof.services | Where-Object {$_.label -ceq $label})
        if($rows.Count -ne 1 -or -not (Test-VillageMigrationLaunchdAbsence -DomainVerified $proof.domainVerified -ExitCode $rows[0].exitCode -Diagnostic $rows[0].diagnostic -Label $label -UserId $proof.uid)){throw 'Native service absence is not proven; source unfence forbidden'}
    }
}
function Assert-SourceGatewaysRunning {
    foreach($profileHome in @('C:/Users/ssper/AppData/Local/hermes','C:/Users/ssper/AppData/Local/hermes/profiles/kakaoworker')){
        $state=Get-Content -LiteralPath (Join-Path $profileHome 'gateway_state.json') -Raw | ConvertFrom-Json
        if($state.kind -cne 'hermes-gateway' -or $state.gateway_state -cne 'running' -or
           [IO.Path]::GetFullPath([string]$state.hermes_home) -ine [IO.Path]::GetFullPath($profileHome)){throw 'Source profile is not running'}
        $process=Get-CimInstance Win32_Process -Filter "ProcessId=$($state.pid)" -ErrorAction Stop
        if($null -eq $process -or $process.CommandLine -notmatch '(?i)(?:^|\s)"?-m"?\s+"?hermes_cli\.main"?\s+(?:"?--profile"?\s+"?kakaoworker"?\s+)?"?gateway"?\s+"?run"?(?:\s|$)'){throw 'Source gateway process identity unavailable'}
        $start=[Math]::Round((([DateTimeOffset]$process.CreationDate).ToUnixTimeMilliseconds())/10.0)
        if([Math]::Abs($start-[double]$state.start_time) -gt 1){throw 'Source gateway PID was reused'}
    }
}
function Assert-RecoveredSource {
    $proofPath=Join-Path $control 'SOURCE-RECOVERED.json'
    $stopPath=Join-Path $control 'source-stop-receipt.json'
    $proof=Get-Content -LiteralPath $proofPath -Raw | ConvertFrom-Json
    if($proof.schema -cne 'village-source-recovery/v1' -or $proof.nonce -cne $nonce -or
       $proof.stopReceiptSha256 -cne (Get-FileHash -LiteralPath $stopPath -Algorithm SHA256).Hash.ToLowerInvariant() -or
       $proof.destinationEverActivated -ne $false){throw 'Source recovery is not bound to this stop'}
    $roles=@('root','worker','bridge','voice','relay')
    if(@($proof.profiles).Count -ne 5 -or @($proof.profiles.role | Select-Object -Unique).Count -ne 5){throw 'Incomplete source recovery owner proof'}
    foreach($row in $proof.profiles){
        $expected=@($manifest.sourceRoles | Where-Object {$_.role -ceq $row.role})
        if(-not ($roles -ccontains [string]$row.role) -or $expected.Count -ne 1 -or $row.state -cne 'running'){throw 'Unexpected recovery owner'}
        $process=Get-CimInstance Win32_Process -Filter "ProcessId=$($row.pid)" -ErrorAction Stop
        if($null -eq $process -or [IO.Path]::GetFullPath($process.ExecutablePath) -ine [IO.Path]::GetFullPath($expected[0].exe) -or
           -not $process.CommandLine.Replace('\','/').Contains([string]$expected[0].argvMarker)){throw 'Recovered process identity changed'}
        $start=[Math]::Round((([DateTimeOffset]$process.CreationDate).ToUnixTimeMilliseconds())/10.0)
        if([Math]::Abs($start-[double]$row.start_time) -gt 1){throw 'Recovered PID was reused'}
        if($row.role -in @('bridge','voice')){
            $port=if($row.role -eq 'bridge'){8787}else{8788}
            $owners=@(Get-NetTCPConnection -State Listen -LocalPort $port | Select-Object -ExpandProperty OwningProcess -Unique)
            if($owners.Count -ne 1 -or $owners[0] -ne $row.pid){throw 'Recovered listener ownership changed'}
        }
    }
    Assert-RecoveryBindings
    $guard='C:/Village/task-artifacts/20261022-reservation-incident/audit/incident-startup-fences-20261024/guarded-runtime.ps1'
    $shell=Join-Path $env:SYSTEMROOT 'System32/WindowsPowerShell/v1.0/powershell.exe'
    $result=& $shell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $guard -CheckHealthy
    if($LASTEXITCODE -ne 0){throw 'Current guarded source did not pass read-only recovery readback'}
    $result=$result | ConvertFrom-Json
    if($result.healthy -ne $true -or $result.mutated -ne $false){throw 'Guarded recovery readiness was not proven'}
    $voice=Invoke-RestMethod -Uri 'http://127.0.0.1:8788/health' -TimeoutSec 5
    if($voice.status -cne 'ok'){throw 'Recovered voice is not responding'}
}
$original=@(Read-TaskSnapshot)
if($ValidateOnly){
    Assert-NativeInactive
    Assert-SourceGatewaysRunning
    [pscustomobject]@{validated=$true;taskCount=$original.Count;enabledCount=@($original | Where-Object enabled).Count;taskChanges=$false;processesStopped=$false}|ConvertTo-Json -Compress
    return
}
$principal=[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if(-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Real Windows administrator consent is required'}
if(Test-Path -LiteralPath $control){throw 'Existing controller state must be inspected; do not rerun a broker'}
[void](New-Item -ItemType Directory -Path $control)
$nonce=[guid]::NewGuid().ToString();$sequence=0;$fenced=$false;$finished=$false;$attemptedFence=$false
function Save-State($Name,$Value){
    $target=Join-Path $control $Name;$temporary=$target+'.tmp'
    [IO.File]::WriteAllText($temporary,($Value | ConvertTo-Json -Depth 12),[Text.UTF8Encoding]::new($false))
    $file=[IO.File]::Open($temporary,'Open','ReadWrite','None');try{$file.Flush($true)}finally{$file.Dispose()}
    if(Test-Path -LiteralPath $target){[IO.File]::Replace($temporary,$target,[NullString]::Value)}else{[IO.File]::Move($temporary,$target)}
}
function Restore-OriginalTasks {
    Assert-NativeInactive
    Assert-SourceGatewaysRunning
    Invoke-VillageMigrationTaskRestore -Original $original -ReadEnabled {param($Name)[bool](Get-ScheduledTask -TaskName $Name -TaskPath '\').Settings.Enabled} -AssertDefinition {param($Name)Assert-TaskDefinition $Name} -BeforeMutation {Assert-NativeInactive;Assert-SourceGatewaysRunning} -RestorationStarting {
        $script:fenced=$false
        Save-State 'SCHEDULER-FENCED.json' @{nonce=$nonce;manifestSha256=$ManifestSha256;valid=$false;state='restoration-started';at=[DateTime]::UtcNow.ToString('o')}
    } -Disable {param($Name,$TaskPath)Disable-ScheduledTask -TaskName $Name -TaskPath $TaskPath | Out-Null} -Enable {param($Name,$TaskPath)Enable-ScheduledTask -TaskName $Name -TaskPath $TaskPath | Out-Null}
}
function Read-ActualTaskStates {
    Get-VillageMigrationTaskReadback -Original $original -ReadEnabled {param($Name)[bool](Get-ScheduledTask -TaskName $Name -TaskPath '\').Settings.Enabled}
}
try{
    Save-State 'original-task-states.json' @($original | Select-Object name,path,enabled,state)
    foreach($row in $original){[IO.File]::WriteAllText((Join-Path $control ($row.name.Replace(' ','_')+'.xml')),$row.xml,[Text.UTF8Encoding]::new($false))}
    Save-State 'ADMIN-READY.json' @{nonce=$nonce;manifestSha256=$ManifestSha256;pid=$PID;scope='only-21-named-scheduler-owners';taskChanges=$false;processesStopped=$false;at=[DateTime]::UtcNow.ToString('o')}
    $timer=[Diagnostics.Stopwatch]::StartNew();$heartbeatAt=-10
    while($timer.Elapsed.TotalHours -lt 2 -and -not $finished){
        if($timer.Elapsed.TotalSeconds-$heartbeatAt -ge 5){
            Save-State 'BROKER-STATE.json' @{nonce=$nonce;manifestSha256=$ManifestSha256;pid=$PID;sequence=$sequence;active=$true;fenced=$fenced;leaseRemainingSeconds=[Math]::Max(0,7200-[int]$timer.Elapsed.TotalSeconds);at=[DateTime]::UtcNow.ToString('o')}
            $heartbeatAt=$timer.Elapsed.TotalSeconds
        }
        $requestFile=Join-Path $control 'request.json'
        if(-not (Test-Path -LiteralPath $requestFile)){Start-Sleep -Milliseconds 500;continue}
        $request=Get-Content -LiteralPath $requestFile -Raw | ConvertFrom-Json
        if($request.nonce -cne $nonce -or $request.manifestSha256 -cne $ManifestSha256){throw 'Controller request binding changed'}
        if([int]$request.sequence -le $sequence){Start-Sleep -Milliseconds 500;continue}
        $sequence=[int]$request.sequence
        try{switch([string]$request.action){
            'fence' {
                Assert-NativeInactive
                if(-not $fenced){
                    $current=@(Read-TaskSnapshot)
                    foreach($row in $original){if(($current | Where-Object {$_.name -ceq $row.name}).enabled -ne $row.enabled){throw 'Original source owner enable state changed'}}
                    $attemptedFence=$true
                    $result=Invoke-VillageMigrationTaskFence -Original @($original | Select-Object name,path,enabled) -ReadEnabled {param($Name)[bool](Get-ScheduledTask -TaskName $Name -TaskPath '\').Settings.Enabled} -AssertDefinition {param($Name)Assert-TaskDefinition $Name} -Disable {param($Name,$TaskPath)Disable-ScheduledTask -TaskName $Name -TaskPath $TaskPath | Out-Null} -Enable {param($Name,$TaskPath)Enable-ScheduledTask -TaskName $Name -TaskPath $TaskPath | Out-Null}
                    $fenced=$true
                }
                $actual=Read-ActualTaskStates
                $checked=@(Read-TaskSnapshot)
                if(-not $actual.allDisabled -or @($checked | Where-Object enabled).Count -ne 0){throw 'Fresh scheduler fence readback failed'}
                Save-State 'SCHEDULER-FENCED.json' @{nonce=$nonce;manifestSha256=$ManifestSha256;valid=$true;disabledCount=@($original | Where-Object enabled).Count;all21Disabled=$true;processesStopped=$false;at=[DateTime]::UtcNow.ToString('o')}
            }
            'restore-before-source-stop' {
                if((Test-Path -LiteralPath (Join-Path $control 'SOURCE_STOP_REQUESTED')) -or (Test-Path -LiteralPath (Join-Path $control 'MAC_EVER_ACTIVATED'))){throw 'Post-stop source restoration requires the separate verified recovery procedure'}
                if(Test-Path -LiteralPath (Join-Path $control 'WATCHER-PAUSED.json')){throw 'Resume and verify the owned source watcher before requesting scheduler restoration'}
                Restore-OriginalTasks;$fenced=$false;$finished=$true
                Save-State 'RESTORED.json' @{nonce=$nonce;originalStatesRestored=$true;processesStopped=$false;at=[DateTime]::UtcNow.ToString('o')}
            }
            'commit-fenced' {
                if(-not $fenced -or -not (Test-Path -LiteralPath (Join-Path $control 'SOURCE_STOP_REQUESTED')) -or -not (Test-Path -LiteralPath (Join-Path $control 'MAC_EVER_ACTIVATED'))){throw 'Commit requires explicit closed-source and destination-activation receipts'}
                [void](Read-TaskSnapshot)
                foreach($row in $original){if((Get-ScheduledTask -TaskName $row.name -TaskPath $row.path).Settings.Enabled){throw 'A source restart owner is enabled'}}
                Save-State 'COMMITTED.json' @{nonce=$nonce;sourceTasksRemainDisabled=$true;at=[DateTime]::UtcNow.ToString('o')};$finished=$true
            }
            'restore-after-source-recovery' {
                if(-not (Test-Path -LiteralPath (Join-Path $control 'SOURCE_STOP_REQUESTED')) -or (Test-Path -LiteralPath (Join-Path $control 'MAC_EVER_ACTIVATED'))){throw 'Only never-activated source recovery is supported'}
                Assert-NativeInactive;Assert-RecoveredSource
                Restore-OriginalTasks;$fenced=$false;$finished=$true
                Save-State 'RECOVERED-AND-RESTORED.json' @{nonce=$nonce;sourceRecovered=$true;originalStatesRestored=$true;at=[DateTime]::UtcNow.ToString('o')}
            }
            default {throw 'Unsupported controller action; arbitrary execution is forbidden'}
        }}catch{
            $actual=Read-ActualTaskStates
            $fenced=$actual.allDisabled
            Save-State 'REQUEST-REJECTED.json' @{nonce=$nonce;sequence=$sequence;error=$_.Exception.Message;actualTaskStates=$actual;at=[DateTime]::UtcNow.ToString('o')}
            Save-State 'SCHEDULER-FENCED.json' @{nonce=$nonce;manifestSha256=$ManifestSha256;valid=$false;state='request-rejected-requires-fresh-fence';actualTaskStates=$actual;at=[DateTime]::UtcNow.ToString('o')}
        }
    }
    if(-not $finished){throw 'Scheduler controller lease elapsed'}
}catch{
    Save-State 'ERROR.json' @{nonce=$nonce;error=$_.Exception.Message;fenced=$fenced;processesStoppedByBroker=$false;at=[DateTime]::UtcNow.ToString('o')}
    throw
}finally{
    Save-State 'BROKER-STATE.json' @{nonce=$nonce;manifestSha256=$ManifestSha256;pid=$PID;sequence=$sequence;active=$false;at=[DateTime]::UtcNow.ToString('o')}
    # Fail closed after any stop/activation. Before that, restore only if neither
    # ingress nor gateway drain was engaged, and fresh destination checks pass.
    if($attemptedFence -and -not $finished -and -not (Test-Path -LiteralPath (Join-Path $control 'SOURCE_STOP_REQUESTED')) -and
       -not (Test-Path -LiteralPath (Join-Path $control 'MAC_EVER_ACTIVATED')) -and
       -not (Test-Path -LiteralPath (Join-Path $control 'WATCHER-PAUSED.json'))){
        try{Restore-OriginalTasks;Save-State 'RESTORED-ON-EXIT.json' @{originalStatesRestored=$true;at=[DateTime]::UtcNow.ToString('o')}}
        catch{Save-State 'RECOVERY-REQUIRED.json' @{taskStatesRestored=$false;reason='Restoration is incomplete; inspect independent task states';actualTaskStates=(Read-ActualTaskStates);at=[DateTime]::UtcNow.ToString('o')}}
    }
}
