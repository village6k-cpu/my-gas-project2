[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$EnvFile,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$ChromePath,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$NodePath,

    [string]$HermesPath,

    [switch]$IncludeGateway,

    [switch]$EnableWrites
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$stopScriptPath = Join-Path $PSScriptRoot 'stop-kakao-staging.ps1'
$startScriptPath = Join-Path $PSScriptRoot 'start-kakao-staging.ps1'

if (-not $PSCmdlet.ShouldProcess('Windows Kakao staging runtime', 'Stop and start owned staging processes')) {
    return
}

& $stopScriptPath -Confirm:$false

$startParameters = @{
    EnvFile    = $EnvFile
    ChromePath = $ChromePath
    NodePath   = $NodePath
    Confirm    = $false
}
if ($IncludeGateway.IsPresent) {
    $startParameters['IncludeGateway'] = $true
}
if (-not [string]::IsNullOrWhiteSpace($HermesPath)) {
    $startParameters['HermesPath'] = $HermesPath
}
if ($PSBoundParameters.ContainsKey('EnableWrites')) {
    if ($EnableWrites.IsPresent) {
        $startParameters['EnableWrites'] = $true
    }
}

& $startScriptPath @startParameters
