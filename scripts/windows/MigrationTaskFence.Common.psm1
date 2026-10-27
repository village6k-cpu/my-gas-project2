Set-StrictMode -Version Latest

function Get-VillageMigrationTaskNames {
    @('HermesAllowlistReloadOnce','Hermes_Gateway','Hermes_Gateway_Kakaoworker',
      'Hermes_Gateway_Kakaoworker_Native','Hermes_Watch_Voice_Relay',
      'Hermes_Windows_Orphan_Git_Cleanup','Village Inventory Stock Alert Relay',
      'Village-Hermes-Gateway-Lineage-Watchdog','Village-Hermes-Gateway-Lineage-Watchdog-Fast',
      'Village-Hermes-Root-Liveness-Guard','Village-Kakao-Corrections-Nightly',
      'Village-Kakao-Production-Liveness-Guard','Village-Kakao-Production-Start',
      'Village-Kakao-Production-Watchdog','Village-Ops-Inventory-Brief',
      'Village-Ops-Ledger-Sheet-Sync','Village-Ops-Preflight','Village-Ops-Return-Issues',
      'Village-Ops-Setmaster-Reconcile','Village-Ops-Tax-Tracks-Sync','Village-Ops-Weekly-Brain-Card')
}

function Assert-VillageMigrationTaskInventory {
    param([Parameter(Mandatory)][object[]]$Original)
    $names=@(Get-VillageMigrationTaskNames)
    if($Original.Count -ne $names.Count -or @($Original.name | Select-Object -Unique).Count -ne $names.Count){throw 'Incomplete or duplicate task scope'}
    foreach($row in $Original){
        if(-not ($names -ccontains [string]$row.name) -or $row.path -cne '\' -or $row.enabled -isnot [bool]){throw 'Changed task scope or invalid enabled state'}
    }
}

function Get-VillageMigrationTaskDefinitionHash {
    param([Parameter(Mandatory)][string]$Xml)
    [xml]$document=$Xml
    $node=$document.SelectSingleNode("/*[local-name()='Task']/*[local-name()='Settings']/*[local-name()='Enabled']")
    $settings=$document.SelectSingleNode("/*[local-name()='Task']/*[local-name()='Settings']")
    if($null -eq $settings){throw 'Task settings are absent from the definition'}
    # Windows omits Enabled=true and inserts Enabled=false on disable. Remove
    # only this node; preserve action, principal, trigger and all other settings.
    if($null -ne $node){[void]$settings.RemoveChild($node)}
    $sha=[Security.Cryptography.SHA256]::Create()
    try{return [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($document.OuterXml))).Replace('-','').ToLowerInvariant()}
    finally{$sha.Dispose()}
}

function Invoke-VillageMigrationTaskFence {
    param([Parameter(Mandatory)][object[]]$Original,
          [Parameter(Mandatory)][scriptblock]$ReadEnabled,
          [Parameter(Mandatory)][scriptblock]$AssertDefinition,
          [Parameter(Mandatory)][scriptblock]$Disable,
          [Parameter(Mandatory)][scriptblock]$Enable)
    Assert-VillageMigrationTaskInventory $Original
    $attempted=[Collections.Generic.List[object]]::new()
    try{
        foreach($row in $Original){
            & $AssertDefinition $row.name
            $current=& $ReadEnabled $row.name
            if($current -isnot [bool] -or $current -ne $row.enabled){throw 'Source owner state changed before fence'}
        }
        foreach($row in $Original){
            if(-not $row.enabled){continue}
            & $AssertDefinition $row.name
            # Include a disable that mutates successfully but then throws.
            $attempted.Add($row)
            & $Disable $row.name $row.path | Out-Null
        }
        foreach($row in $Original){
            $current=& $ReadEnabled $row.name
            if($current -isnot [bool] -or $current){throw 'Source owner remains enabled after fence'}
        }
        return [pscustomobject]@{fenced=$true;disabledCount=$attempted.Count;original=$Original;processesStopped=$false}
    }catch{
        $restored=$true
        foreach($row in $attempted){
            try{& $AssertDefinition $row.name;& $Enable $row.name $row.path | Out-Null}catch{$restored=$false}
        }
        foreach($row in $Original){
            try{$current=& $ReadEnabled $row.name;if($current -isnot [bool] -or $current -ne $row.enabled){$restored=$false}}catch{$restored=$false}
        }
        throw "Task fence failed; original-state rollback verified: $restored"
    }
}

function Invoke-VillageMigrationTaskRestore {
    param([Parameter(Mandatory)][object[]]$Original,
          [Parameter(Mandatory)][scriptblock]$ReadEnabled,
          [Parameter(Mandatory)][scriptblock]$AssertDefinition,
          [Parameter(Mandatory)][scriptblock]$BeforeMutation,
          [Parameter(Mandatory)][scriptblock]$RestorationStarting,
          [Parameter(Mandatory)][scriptblock]$Disable,
          [Parameter(Mandatory)][scriptblock]$Enable)
    Assert-VillageMigrationTaskInventory $Original
    foreach($row in $Original){& $AssertDefinition $row.name}
    # Invalidate fence authority even when the first subsequent inspection fails.
    & $RestorationStarting
    foreach($row in $Original){
        $current=& $ReadEnabled $row.name
        if($current -isnot [bool]){throw 'Task enable state is unknown'}
        if($current -ne $row.enabled){
            & $BeforeMutation
            & $AssertDefinition $row.name
            if($row.enabled){& $Enable $row.name $row.path | Out-Null}
            else{& $Disable $row.name $row.path | Out-Null}
        }
    }
    foreach($row in $Original){
        & $AssertDefinition $row.name
        $current=& $ReadEnabled $row.name
        if($current -isnot [bool] -or $current -ne $row.enabled){throw 'Original owner state restoration readback failed'}
    }
}

function Get-VillageMigrationTaskReadback {
    param([Parameter(Mandatory)][object[]]$Original,[Parameter(Mandatory)][scriptblock]$ReadEnabled)
    $rows=@();$unknown=$false;$allDisabled=$true;$restored=$true
    foreach($row in $Original){
        $current=$null
        try{$current=& $ReadEnabled $row.name;if($current -isnot [bool]){throw 'Unknown task state'}}
        catch{$current=$null;$unknown=$true}
        if($null -eq $current -or $current){$allDisabled=$false}
        if($null -eq $current -or $current -ne $row.enabled){$restored=$false}
        $rows+=[pscustomobject]@{name=$row.name;enabled=$current}
    }
    $state=if($unknown){'unknown'}elseif($allDisabled){'fenced'}elseif($restored){'original'}else{'partial'}
    [pscustomobject]@{state=$state;allDisabled=$allDisabled;originalStatesRestored=$restored;tasks=$rows}
}

function Test-VillageMigrationLaunchdAbsence {
    param([bool]$DomainVerified,[int]$ExitCode,[string]$Diagnostic,[string]$Label,[int]$UserId)
    # launchctl on this pinned host returns 113 and this exact diagnostic for a
    # missing service. All other errors remain unknown, including domain errors.
    $expected='Bad request.'+"`n"+'Could not find service "'+$Label+'" in domain for user gui: '+$UserId
    return $DomainVerified -and $ExitCode -eq 113 -and $Diagnostic.Replace("`r`n","`n").Trim() -ceq $expected
}

Export-ModuleMember -Function Get-VillageMigrationTaskNames,Assert-VillageMigrationTaskInventory,Get-VillageMigrationTaskDefinitionHash,Invoke-VillageMigrationTaskFence,Invoke-VillageMigrationTaskRestore,Get-VillageMigrationTaskReadback,Test-VillageMigrationLaunchdAbsence
