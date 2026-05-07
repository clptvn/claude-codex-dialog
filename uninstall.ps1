param(
    [switch]$Claude,
    [switch]$Codex,
    [switch]$Both
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$UninstallArgs = @()

if ($Claude) {
    $UninstallArgs += "--claude"
} elseif ($Codex) {
    $UninstallArgs += "--codex"
} elseif ($Both) {
    $UninstallArgs += "--both"
}

& node (Join-Path $ScriptDir "scripts/uninstall.mjs") @UninstallArgs
exit $LASTEXITCODE
