param([int]$Port = 18180, [switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskData = Join-Path $env:LOCALAPPDATA 'RoasterDesktop\dev-web'
$taskMetaPath = Join-Path $taskData 'server.json'
function Get-DebugHost {
    if (Test-Path -LiteralPath $taskMetaPath) {
        try {
            $taskMeta = Get-Content -LiteralPath $taskMetaPath -Raw | ConvertFrom-Json
            $taskHealth = Invoke-RestMethod ($taskMeta.origin + '/__debug__/health') -TimeoutSec 2
            if ($taskHealth.mode -in @('device','safe-simulator') -and $taskHealth.project -eq $taskRoot) { $taskMeta | Add-Member -NotePropertyName mode -NotePropertyValue $taskHealth.mode -Force; return $taskMeta }
        } catch { }
    }
    return $null
}
$taskHostInfo = Get-DebugHost
if ($taskHostInfo -and $taskHostInfo.mode -eq 'safe-simulator') {
    $taskState = Invoke-RestMethod ($taskHostInfo.origin + '/api/v1/status') -TimeoutSec 2
    if ($taskState.state -ne 'IDLE') { throw 'End and save/discard the simulated pot before upgrading the debug service.' }
    Invoke-RestMethod ($taskHostInfo.origin + '/__debug__/shutdown') -Method Post -Headers @{ 'X-Roaster-Debug' = $taskHostInfo.shutdownToken } | Out-Null
    for ($taskWait = 0; $taskWait -lt 30; $taskWait++) {
        Start-Sleep -Milliseconds 100
        if (-not (Get-DebugHost)) { break }
    }
    $taskHostInfo = $null
}
if (-not $taskHostInfo) {
    if (-not (Test-Path -LiteralPath (Join-Path $taskRoot 'desktop\node_modules\ws'))) {
        throw 'Development dependencies missing. Run npm ci in desktop first.'
    }
    $taskNode = Join-Path $taskRoot 'desktop\runtime\ai-node-x86_64-pc-windows-msvc.exe'
    if (-not (Test-Path -LiteralPath $taskNode)) { $taskNode = (Get-Command node -ErrorAction Stop).Source }
    New-Item -ItemType Directory -Path $taskData -Force | Out-Null
    $taskScript = Join-Path $taskRoot 'desktop\tools\dev-server.mjs'
    $taskProcess = Start-Process -FilePath $taskNode -ArgumentList @(('"' + $taskScript + '"'), ('--port=' + $Port)) -WorkingDirectory $taskRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $taskData 'server.log') -RedirectStandardError (Join-Path $taskData 'server-error.log') -PassThru
    for ($taskAttempt = 0; $taskAttempt -lt 80; $taskAttempt++) {
        Start-Sleep -Milliseconds 250
        $taskHostInfo = Get-DebugHost
        if ($taskHostInfo) { break }
        if ($taskProcess.HasExited) { break }
    }
    if (-not $taskHostInfo) { throw ('Debug server did not start. See ' + (Join-Path $taskData 'server-error.log')) }
}
Write-Output ('Debug page: ' + $taskHostInfo.origin)
Write-Output 'Device service ready. Configure the serial port in Settings > Device.'
if (-not $NoBrowser) { Start-Process $taskHostInfo.origin }
