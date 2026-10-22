[CmdletBinding()]
param(
    [switch]$Apply,
    [switch]$Build,
    [switch]$OldPackages,
    [switch]$Dependencies,
    [string]$Report
)

$ErrorActionPreference = 'Stop'
$workspaceRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

$version = (Get-Content -LiteralPath (Join-Path $workspaceRoot 'desktop/package.json') -Raw | ConvertFrom-Json).version
$relativeTargets = [System.Collections.Generic.List[string]]::new()
foreach ($relative in @('.pytest_cache', 'roaster/.pytest_cache', '.codex/ai-native-qa')) {
    $relativeTargets.Add($relative)
}
foreach ($source in @('roaster/src', 'roaster/tests', 'desktop/tools')) {
    Get-ChildItem -LiteralPath (Join-Path $workspaceRoot $source) -Directory -Filter '__pycache__' -Recurse |
        ForEach-Object { $relativeTargets.Add([System.IO.Path]::GetRelativePath($workspaceRoot, $_.FullName)) }
}
if ($Build) {
    foreach ($relative in @('desktop/build', 'desktop/src-tauri/target/debug',
        'desktop/src-tauri/target/release/.fingerprint', 'desktop/src-tauri/target/release/build',
        'desktop/src-tauri/target/release/deps', 'desktop/src-tauri/target/release/incremental',
        'desktop/src-tauri/target/release/examples', 'desktop/src-tauri/target/release/nsis')) {
        $relativeTargets.Add($relative)
    }
}
if ($Dependencies) { $relativeTargets.Add('desktop/node_modules') }
if ($OldPackages) {
    foreach ($relative in @('dist', 'desktop/src-tauri/target/release/bundle/nsis')) {
        $directory = Join-Path $workspaceRoot $relative
        if (-not (Test-Path -LiteralPath $directory)) { continue }
        Get-ChildItem -LiteralPath $directory -File | ForEach-Object {
            if ($_.Name -match '^Roaster(?:AIHost|Desktop)_(?<Version>\d+\.\d+\.\d+)_') {
                if ($Matches.Version -ne $version) { $relativeTargets.Add([System.IO.Path]::GetRelativePath($workspaceRoot, $_.FullName)) }
            }
        }
    }
    foreach ($relative in @('dist/RoasterDesktop-v3.21-windows-x64', 'dist/github-upload')) {
        $relativeTargets.Add($relative)
    }
}

function Assert-WorkspacePath([string]$Path) {
    $absolute = [System.IO.Path]::GetFullPath((Join-Path $workspaceRoot $Path))
    if (-not $absolute.StartsWith($workspaceRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing path outside workspace: $absolute"
    }
    # Reject junctions and symlinks rather than following them during cleanup.
    $cursor = $absolute
    while ($cursor -ne $workspaceRoot) {
        if (Test-Path -LiteralPath $cursor) {
            if ((Get-Item -LiteralPath $cursor -Force).Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
                throw "Refusing linked path: $cursor"
            }
        }
        $cursor = Split-Path -Parent $cursor
    }
    return $absolute
}

$targets = foreach ($relative in ($relativeTargets | Sort-Object -Unique)) {
    $absolute = Assert-WorkspacePath $relative
    if (-not (Test-Path -LiteralPath $absolute)) { continue }
    $tracked = @(& git -C $workspaceRoot ls-files -- $relative)
    if ($LASTEXITCODE -ne 0 -or $tracked.Count -gt 0) { throw "Refusing tracked path: $relative" }
    $item = Get-Item -LiteralPath $absolute -Force
    $files = if ($item.PSIsContainer) { @(Get-ChildItem -LiteralPath $absolute -File -Recurse -Force) } else { @($item) }
    $links = if ($item.PSIsContainer) { @(Get-ChildItem -LiteralPath $absolute -Attributes ReparsePoint -Recurse -Force) } else { @() }
    foreach ($link in $links) {
        $linkedPath = [System.IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $link.FullName) $link.LinkTarget))
        if (-not $linkedPath.StartsWith($absolute + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Refusing link outside generated directory: $($link.FullName)"
        }
    }
    $bytes = ($files | Measure-Object -Property Length -Sum).Sum
    [pscustomobject]@{ Relative = $relative; Absolute = $absolute; Bytes = [long]$bytes; Links = @($links | ForEach-Object { $_.FullName }) }
}
$targets = @($targets)
$reportPath = if ($Report) { Assert-WorkspacePath $Report } else { $null }
foreach ($target in $targets) {
    Write-Output ('{0}: {1} ({2:N1} MiB)' -f $(if ($Apply) { 'Remove' } else { 'Preview' }), $target.Relative, ($target.Bytes / 1MB))
    if ($Apply) {
        foreach ($link in $target.Links) { Remove-Item -LiteralPath $link -Force }
        Remove-Item -LiteralPath $target.Absolute -Recurse -Force
    }
}
$total = [long](($targets | Measure-Object -Property Bytes -Sum).Sum)
Write-Output ('{0} paths; {1:N2} GiB; current version {2}' -f $targets.Count, ($total / 1GB), $version)
if (-not $Apply) { Write-Output 'Preview only. Add -Apply to remove these generated files.' }
if ($reportPath) {
    $payload = [ordered]@{ applied = [bool]$Apply; version = $version; removed_bytes = $(if ($Apply) { $total } else { 0 }); targets = @($targets | Select-Object Relative, Bytes) }
    New-Item -ItemType Directory -Path (Split-Path -Parent $reportPath) -Force | Out-Null
    $payload | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $reportPath -Encoding utf8
}
