$ErrorActionPreference='Stop'
Import-Module (Join-Path $PSScriptRoot '../scripts/windows/MigrationTaskFence.Common.psm1') -Force
function Assert-True($Value,$Message){if(-not $Value){throw $Message}}
function New-Fixture {
    $state=@{};$rows=@(Get-VillageMigrationTaskNames | ForEach-Object {
        $enabled=$_ -cne 'Village-Hermes-Gateway-Lineage-Watchdog-Fast';$state[$_]=$enabled
        [pscustomobject]@{name=$_;path='\';enabled=$enabled}
    })
    @{state=$state;rows=$rows;changed=@{};disableCalls=[Collections.Generic.List[string]]::new();enableCalls=[Collections.Generic.List[string]]::new()}
}
$definition={param($Name)if($fixture.changed[$Name]){throw 'definition changed'}}
$fixture=New-Fixture
$read={param($Name)$fixture.state[$Name]}.GetNewClosure()
$disable={param($Name,$TaskPath)$fixture.disableCalls.Add($Name);$fixture.state[$Name]=$false}.GetNewClosure()
$enable={param($Name,$TaskPath)$fixture.enableCalls.Add($Name);$fixture.state[$Name]=$true}.GetNewClosure()
$result=Invoke-VillageMigrationTaskFence -Original $fixture.rows -ReadEnabled $read -AssertDefinition $definition -Disable $disable -Enable $enable
Assert-True ($result.fenced -and $result.disabledCount -eq 20) 'All original enabled owners must be fenced'
Assert-True ($fixture.disableCalls.Count -eq 20 -and $fixture.enableCalls.Count -eq 0) 'Never enable or execute an owner while fencing'
Assert-True (-not $fixture.state['Village-Hermes-Gateway-Lineage-Watchdog-Fast']) 'Original disabled owner must stay disabled'

$fixture=New-Fixture
$read={param($Name)$fixture.state[$Name]}.GetNewClosure()
$disable={param($Name,$TaskPath)$fixture.disableCalls.Add($Name);$fixture.state[$Name]=$false;if($fixture.disableCalls.Count -eq 2){throw 'injected post-write failure'}}.GetNewClosure()
$enable={param($Name,$TaskPath)$fixture.enableCalls.Add($Name);$fixture.state[$Name]=$true}.GetNewClosure()
$failed=$false
try{Invoke-VillageMigrationTaskFence -Original $fixture.rows -ReadEnabled $read -AssertDefinition $definition -Disable $disable -Enable $enable | Out-Null}catch{$failed=$true}
Assert-True $failed 'A partially failed fence must not be reported successful'
Assert-True ($fixture.enableCalls.Count -eq 2) 'Include the uncertain last attempted disable in rollback'
foreach($row in $fixture.rows){Assert-True ($fixture.state[$row.name] -eq $row.enabled) 'Restore exact original enable states'}

$fixture=New-Fixture
$read={param($Name)$fixture.state[$Name]}.GetNewClosure()
$disable={param($Name,$TaskPath)$fixture.disableCalls.Add($Name)}.GetNewClosure()
$enable={param($Name,$TaskPath)$fixture.enableCalls.Add($Name);$fixture.state[$Name]=$true}.GetNewClosure()
$failed=$false
try{Invoke-VillageMigrationTaskFence -Original $fixture.rows -ReadEnabled $read -AssertDefinition $definition -Disable $disable -Enable $enable | Out-Null}catch{$failed=$true}
Assert-True $failed 'A disable acknowledgment is insufficient without independent readback'

$fixture=New-Fixture;$fixture.rows[0].name='UnexpectedTask'
$read={param($Name)$fixture.state[$Name]}.GetNewClosure()
$disable={param($Name,$TaskPath)$fixture.disableCalls.Add($Name)}.GetNewClosure()
$enable={param($Name,$TaskPath)$fixture.enableCalls.Add($Name)}.GetNewClosure()
$failed=$false
try{Invoke-VillageMigrationTaskFence -Original $fixture.rows -ReadEnabled $read -AssertDefinition $definition -Disable $disable -Enable $enable | Out-Null}catch{$failed=$true}
Assert-True ($failed -and $fixture.disableCalls.Count -eq 0) 'Reject changed task scope before any mutation'
$xml='<Task xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers><Settings><Enabled>true</Enabled></Settings></Task>'
$settingsChanged=$xml.Replace('<Settings><Enabled>true','<Settings><Enabled>false')
$triggerChanged=$xml.Replace('<LogonTrigger><Enabled>true','<LogonTrigger><Enabled>false')
Assert-True ((Get-VillageMigrationTaskDefinitionHash $xml) -eq (Get-VillageMigrationTaskDefinitionHash $settingsChanged)) 'Task enabled state is verified separately'
Assert-True ((Get-VillageMigrationTaskDefinitionHash $xml) -ne (Get-VillageMigrationTaskDefinitionHash $triggerChanged)) 'Never ignore a changed trigger definition'
$enabledOmitted=$xml.Replace('<Settings><Enabled>true</Enabled></Settings>','<Settings></Settings>')
Assert-True ((Get-VillageMigrationTaskDefinitionHash $xml) -eq (Get-VillageMigrationTaskDefinitionHash $enabledOmitted)) 'Task Scheduler omits the default enabled setting'
$fixture=New-Fixture
foreach($row in $fixture.rows){$fixture.state[$row.name]=$false}
$fixture.changed[$fixture.rows[1].name]=$true
$read={param($Name)$fixture.state[$Name]}.GetNewClosure()
$enable={param($Name,$TaskPath)$fixture.enableCalls.Add($Name);$fixture.state[$Name]=$true}.GetNewClosure()
$disable={param($Name,$TaskPath)$fixture.disableCalls.Add($Name);$fixture.state[$Name]=$false}.GetNewClosure()
$failed=$false
try{Invoke-VillageMigrationTaskRestore -Original $fixture.rows -ReadEnabled $read -AssertDefinition $definition -BeforeMutation {} -RestorationStarting {} -Disable $disable -Enable $enable | Out-Null}catch{$failed=$true}
Assert-True ($failed -and $fixture.enableCalls.Count -eq 0) 'A changed definition must block all restoration before the first enable'

$fixture=New-Fixture
foreach($row in $fixture.rows){$fixture.state[$row.name]=$false}
$read={param($Name)$fixture.state[$Name]}.GetNewClosure()
$enable={param($Name,$TaskPath)$fixture.enableCalls.Add($Name);$fixture.state[$Name]=$true}.GetNewClosure()
$disable={param($Name,$TaskPath)$fixture.disableCalls.Add($Name);$fixture.state[$Name]=$false}.GetNewClosure()
$checks=@{count=0;invalidated=$false}
$before={ $checks.count++;if($checks.count -eq 2){throw 'native inspection unavailable'} }.GetNewClosure()
$invalidate={$checks.invalidated=$true}.GetNewClosure()
$failed=$false
try{Invoke-VillageMigrationTaskRestore -Original $fixture.rows -ReadEnabled $read -AssertDefinition $definition -BeforeMutation $before -RestorationStarting $invalidate -Disable $disable -Enable $enable | Out-Null}catch{$failed=$true}
$actual=Get-VillageMigrationTaskReadback -Original $fixture.rows -ReadEnabled $read
Assert-True ($failed -and $checks.invalidated -and $fixture.enableCalls.Count -eq 1) 'Invalidate fence authority before partial restoration'
Assert-True ($actual.state -eq 'partial' -and -not $actual.allDisabled -and -not $actual.originalStatesRestored) 'Partial restoration must never claim fenced or restored'

$fixture=New-Fixture
$read={param($Name)if($Name -eq $fixture.rows[0].name){throw 'task inspection unavailable'};$fixture.state[$Name]}.GetNewClosure()
$actual=Get-VillageMigrationTaskReadback -Original $fixture.rows -ReadEnabled $read
Assert-True ($actual.state -eq 'unknown' -and -not $actual.allDisabled -and -not $actual.originalStatesRestored) 'Inspection failure is unknown'

$label='com.village.migrated.root'
$missing='Bad request.'+"`n"+'Could not find service "'+$label+'" in domain for user gui: 501'
Assert-True (Test-VillageMigrationLaunchdAbsence -DomainVerified $true -ExitCode 113 -Diagnostic $missing -Label $label -UserId 501) 'Confirm actual native exit 113 and exact missing-service diagnostic in a verified domain'
Assert-True (-not (Test-VillageMigrationLaunchdAbsence -DomainVerified $false -ExitCode 1 -Diagnostic $missing -Label $label -UserId 501)) 'Unknown domain is not absence'
Assert-True (-not (Test-VillageMigrationLaunchdAbsence -DomainVerified $true -ExitCode 1 -Diagnostic 'Operation not permitted' -Label $label -UserId 501)) 'Permission error is not absence'

$fixture=New-Fixture
$read={param($Name)$fixture.state[$Name]}.GetNewClosure()
$disable={param($Name,$TaskPath)$fixture.disableCalls.Add($Name);$fixture.state[$Name]=$false;if($fixture.disableCalls.Count -eq 2){$fixture.changed[$Name]=$true;throw 'post-write definition change'}}.GetNewClosure()
$enable={param($Name,$TaskPath)$fixture.enableCalls.Add($Name);$fixture.state[$Name]=$true}.GetNewClosure()
$failed=$false
try{Invoke-VillageMigrationTaskFence -Original $fixture.rows -ReadEnabled $read -AssertDefinition $definition -Disable $disable -Enable $enable | Out-Null}catch{$failed=$true}
Assert-True ($failed -and $fixture.enableCalls.Count -eq 1 -and -not $fixture.state[$fixture.rows[1].name]) 'Failure rollback must never enable a changed definition'
$brokerPath=Join-Path $PSScriptRoot '../scripts/windows/fence-village-migration-tasks.ps1'
$parseErrors=$null;$parseTokens=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($brokerPath,[ref]$parseTokens,[ref]$parseErrors)
Assert-True ($parseErrors.Count -eq 0) 'Broker syntax must parse'
$sourceFunction=$ast.Find({param($node)$node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Assert-SourceGatewaysRunning'},$true)
. ([scriptblock]::Create($sourceFunction.Extent.Text))
$sourceCalls=@{count=0}
function Get-Content {param($LiteralPath,[switch]$Raw)
    $sourceCalls.count++
    $ownerPid=if($LiteralPath -match 'kakaoworker'){200}else{100}
    @{kind='hermes-gateway';gateway_state='running';hermes_home=[IO.Path]::GetDirectoryName($LiteralPath);pid=$ownerPid;start_time=179000000000}|ConvertTo-Json
}
function Get-CimInstance {param($ClassName,$Filter,$ErrorAction)
    $cmd=if($Filter -eq 'ProcessId=200'){'python.exe -m hermes_cli.main --profile kakaoworker gateway run'}else{'python.exe -m hermes_cli.main gateway run'}
    [pscustomobject]@{CommandLine=$cmd;CreationDate=[DateTimeOffset]::FromUnixTimeMilliseconds(1790000000000).UtcDateTime}
}
Assert-SourceGatewaysRunning
Assert-True ($sourceCalls.count -eq 2) 'Both running gateway identities are checked without touching a service'
Remove-Item Function:Get-Content,Function:Get-CimInstance
@{passed=11;liveTaskCalls=0;liveProcessesStopped=0}|ConvertTo-Json -Compress
