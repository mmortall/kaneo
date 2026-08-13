param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$hostRoot = (Resolve-Path (Join-Path $repoRoot "..\..")).Path
$python = Join-Path $hostRoot ".conda-env\python.exe"

if (-not (Test-Path -LiteralPath $python)) {
    throw "Host Global Knowledge Platform Miniconda environment is missing: $python"
}

& $python -m knowledge_router.kaneo_cli --repo-root $repoRoot @Arguments
exit $LASTEXITCODE
