[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Import-Module (Join-Path $PSScriptRoot 'KakaoStaging.Common.psm1') -Force

if (-not $PSCmdlet.ShouldProcess('owned gateway, bridge, and Chrome processes', 'Stop Windows Kakao staging runtime')) {
    return
}

$refused = @()
foreach ($name in @('gateway', 'bridge', 'chrome')) {
    $record = Read-OwnedProcessRecord -Name $name
    if ($null -eq $record) {
        continue
    }

    try {
        Stop-OwnedProcess -Name $name -Confirm:$false | Out-Null
    }
    catch {
        Write-Warning "Owned process stop failed for '$name'; its ownership record was preserved."
        $refused += $name
    }
}

if ($refused.Count -gt 0) {
    throw 'One or more recorded processes failed ownership validation and were not stopped.'
}
