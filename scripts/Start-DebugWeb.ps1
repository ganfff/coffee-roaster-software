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
            if ($taskHealth.mode -eq 'safe-simulator' -and $taskHealth.project -eq $taskRoot) { return $taskMeta }
        } catch { }
    }
    return $null
}
$taskHostInfo = Get-DebugHost
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
Write-Output 'Safe simulator. No serial ports or heaters. Refresh to load source changes.'
if (-not $NoBrowser) { Start-Process $taskHostInfo.origin }
