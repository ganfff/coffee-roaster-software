[CmdletBinding()]
param(
    [switch]$Apply
)

$ErrorActionPreference = 'Stop'
$workspaceRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

$relativeTargets = @(
    'desktop\node_modules',
    'desktop\src-tauri\target',
    'flutter_app\.dart_tool',
    'flutter_app\.idea',
    'flutter_app\build',
    'flutter_app\windows\flutter\ephemeral',
    'roaster\src\__pycache__',
    'roaster\src\core\__pycache__',
    'roaster\src\hardware\__pycache__',
    'roaster\src\services\__pycache__',
    'roaster\src\web\__pycache__'
)

$existingTargets = foreach ($relativeTarget in $relativeTargets) {
    $absoluteTarget = [System.IO.Path]::GetFullPath((Join-Path $workspaceRoot $relativeTarget))
    $insideWorkspace = $absoluteTarget.StartsWith(
        $workspaceRoot + [System.IO.Path]::DirectorySeparatorChar,
        [System.StringComparison]::OrdinalIgnoreCase
    )
    if (-not $insideWorkspace) {
        throw "Refusing target outside workspace: $absoluteTarget"
    }
    if (Test-Path -LiteralPath $absoluteTarget) {
        [pscustomobject]@{ Relative = $relativeTarget; Absolute = $absoluteTarget }
    }
}

if (-not $existingTargets) {
    Write-Output 'Workspace is already clean.'
    exit 0
}

Write-Output 'Generated paths:'
$existingTargets | ForEach-Object { Write-Output ("- {0}" -f $_.Relative) }

if (-not $Apply) {
    Write-Output 'Preview only. Re-run with -Apply to remove these reproducible files.'
    exit 0
}

foreach ($target in $existingTargets) {
    Remove-Item -LiteralPath $target.Absolute -Recurse -Force
    Write-Output ("Removed {0}" -f $target.Relative)
}
