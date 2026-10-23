$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskMetaPath = Join-Path $env:LOCALAPPDATA 'RoasterDesktop\dev-web\server.json'
if (-not (Test-Path -LiteralPath $taskMetaPath)) { Write-Output 'No debug server running.'; exit 0 }
$taskMeta = Get-Content -LiteralPath $taskMetaPath -Raw | ConvertFrom-Json
$taskHealth = Invoke-RestMethod ($taskMeta.origin + '/__debug__/health') -TimeoutSec 2
if ($taskHealth.project -ne $taskRoot -or $taskHealth.mode -ne 'safe-simulator') { throw 'The service does not belong to this project.' }
Invoke-RestMethod ($taskMeta.origin + '/__debug__/shutdown') -Method Post -Headers @{ 'X-Roaster-Debug' = $taskMeta.shutdownToken } | Out-Null
Write-Output 'Debug server stopped.'
