$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskNode = Join-Path $taskRoot 'desktop\runtime\ai-node-x86_64-pc-windows-msvc.exe'
if (-not (Test-Path -LiteralPath $taskNode)) { $taskNode = (Get-Command node -ErrorAction Stop).Source }
Push-Location (Join-Path $taskRoot 'desktop')
try { & $taskNode (Join-Path $taskRoot 'desktop\tools\dev-sim.mjs') @args; exit $LASTEXITCODE }
finally { Pop-Location }
