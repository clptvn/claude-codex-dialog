param(
    [switch]$Claude,
    [switch]$Codex,
    [switch]$Both
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$InstallArgs = @()

if ($Claude) {
    $InstallArgs += "--claude"
} elseif ($Codex) {
    $InstallArgs += "--codex"
} elseif ($Both) {
    $InstallArgs += "--both"
}

& node (Join-Path $ScriptDir "scripts/install.mjs") @InstallArgs
exit $LASTEXITCODE
