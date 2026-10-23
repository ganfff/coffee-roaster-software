$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path -LiteralPath (Join-Path $taskRoot 'desktop\node_modules\@tauri-apps\cli'))) {
    throw 'Desktop dependencies missing. Run npm ci in desktop first.'
}
$taskCargo = Join-Path $env:USERPROFILE '.cargo\bin'
if (-not (Get-Command cargo -ErrorAction SilentlyContinue) -and (Test-Path -LiteralPath (Join-Path $taskCargo 'cargo.exe'))) {
    $env:PATH = $taskCargo + ';' + $env:PATH
}
if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    throw 'Rust toolchain missing. Install Rust with rustup, then reopen this launcher.'
}
$taskNode = Join-Path $taskRoot 'desktop\runtime\ai-node-x86_64-pc-windows-msvc.exe'
if (-not (Test-Path -LiteralPath $taskNode)) { $taskNode = (Get-Command node -ErrorAction Stop).Source }
# Both launchers reuse a stable loopback host and the same protected AI vault.
& (Join-Path $PSScriptRoot 'Start-DebugWeb.ps1') -NoBrowser
Push-Location (Join-Path $taskRoot 'desktop')
try { & $taskNode (Join-Path $taskRoot 'desktop\tools\dev-sim.mjs') @args; exit $LASTEXITCODE }
finally { Pop-Location }
