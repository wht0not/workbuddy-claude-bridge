#requires -Version 5.1
<#
.SYNOPSIS
  WorkBuddy to Claude environment doctor
.DESCRIPTION
  Read-only check. Prints OK/X for each prerequisite.

  Detection is footprint-based, not path-guess-based:
  the probe looks for several known install shapes (process name, Appx package,
  install directory) AND mirrors the same relative path on non-system drives,
  because some machines keep %LOCALAPPDATA% on D: while the env var still says C:.
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File doctor.ps1
#>
$ErrorActionPreference = 'SilentlyContinue'

function Test-Item($desc, $ok, $hint = '') {
  $mark = if ($ok) { '[OK]' } else { '[X]' }
  $line = "  $mark  $desc"
  if (-not $ok -and $hint) { $line += "  ->  $hint" }
  $line
}

# Same relative path mirrored onto the other drives (C:\Users\x\... -> D:\Users\x\...).
# Guards against the "env var says C:, client data actually lives on D:" case.
function Get-MirrorPaths([string]$absPath) {
  $out = @()
  try {
    $drive = [System.IO.Path]::GetPathRoot($absPath)
    if ($drive) {
      $rest = $absPath.Substring($drive.Length)
      foreach ($d in (Get-PSDrive -PSProvider FileSystem).Name) {
        $cand = $d + ':\' + $rest
        if ($cand -ne $absPath) { $out += $cand }
      }
    }
  } catch {}
  $out
}

Write-Host ''
Write-Host '=== WorkBuddy -> Claude  Environment Doctor ===' -ForegroundColor Cyan
Write-Host ''

$wbProc = Get-Process -Name 'WorkBuddy' -ErrorAction SilentlyContinue
$wbInstalled = $false
foreach ($root in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
                    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
                    'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*')) {
  if (Get-ItemProperty $root -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -match 'WorkBuddy|CodeBuddy' }) { $wbInstalled = $true; break }
}
Test-Item 'WorkBuddy desktop installed & logged in' ([bool]($wbProc -or $wbInstalled)) 'Install and log in WorkBuddy desktop first'

$nodeVer = $null
try { $nodeVer = (& node --version 2>$null) } catch {}
$nodeRunsTs = $false
if ($nodeVer) {
  $probe = Join-Path $env:TEMP ("gw-ts-probe-" + [guid]::NewGuid().ToString("N") + ".ts")
  try {
    Set-Content -Path $probe -Value 'const n: number = 1' -Encoding ASCII
    & node $probe 2>&1 | Out-Null
    $nodeRunsTs = ($LASTEXITCODE -eq 0)
  } catch {} finally { Remove-Item $probe -Force -ErrorAction SilentlyContinue }
}
$nodeDesc = 'Node runs .ts directly' + $(if ($nodeVer) { " ($nodeVer)" } else { '' })
Test-Item $nodeDesc $nodeRunsTs 'Install the current LTS from nodejs.org'

# --- credentials -------------------------------------------------------------
# The gateway accepts ANY *.info file whose accessToken is a bare string.
# workbuddy-desktop.info from desktop 5.6+ wraps it in $wbEncrypted -> skipped.
# So count *usable* plaintext files, not just files named workbuddy-pool-*.
$authDirs = @(
  "$env:APPDATA\CodeBuddyExtension\Data\Public\auth",
  "$env:LOCALAPPDATA\CodeBuddyExtension\Data\Public\auth"
)
foreach ($a in @($authDirs)) { $authDirs += (Get-MirrorPaths $a) }
$authDirs = $authDirs | Select-Object -Unique

$plain = @(); $wrapped = @()
foreach ($d in $authDirs) {
  if (-not (Test-Path $d)) { continue }
  foreach ($f in (Get-ChildItem $d -Filter '*.info' -File -ErrorAction SilentlyContinue)) {
    $txt = Get-Content $f.FullName -Raw -ErrorAction SilentlyContinue
    if (-not $txt) { continue }
    $txt = $txt.TrimStart([char]0xFEFF)
    $usable = $false
    try {
      $j = $txt | ConvertFrom-Json
      $tok = $null
      if ($j.auth -and $j.auth.accessToken) { $tok = $j.auth.accessToken }
      elseif ($j.accessToken) { $tok = $j.accessToken }
      if (($tok -is [string]) -and ($tok.Trim() -ne '')) { $usable = $true }
    } catch {}
    if ($usable -and ($txt -notmatch 'wbEncrypted')) { $plain += $f.Name } else { $wrapped += $f.Name }
  }
}
$plain = $plain | Select-Object -Unique
$wrapped = $wrapped | Select-Object -Unique
Test-Item ("Plaintext credential usable by gateway (found $($plain.Count))") ($plain.Count -gt 0) 'Log in via workbuddy-switch (credentials land in ~/.wb-switch/accounts.json), or add account via xdpool scan'
if ($plain.Count -gt 0) { Write-Host ("        usable : " + ($plain -join ', ')) -ForegroundColor DarkGray }
if ($wrapped.Count -gt 0) { Write-Host ("        skipped: " + ($wrapped -join ', ') + "  (encrypted-wrapped, gateway ignores)") -ForegroundColor DarkYellow }

# --- credential source A: xdpool plugin --------------------------------------
$xdCand = @("$env:USERPROFILE\.deepseek-harness\.workbuddy-xdpool")
if ($env:DSH_HOME) { $xdCand += "$env:DSH_HOME\.workbuddy-xdpool" }
foreach ($c in @($xdCand)) { $xdCand += (Get-MirrorPaths $c) }
$xdpoolOk = $false
foreach ($d in ($xdCand | Select-Object -Unique)) { if (Test-Path $d) { $xdpoolOk = $true; break } }
Test-Item 'xdpool plugin installed (optional, route A)' $xdpoolOk 'Search workbuddy-xdpool in DSH plugin market (or use route B)'

# --- credential source B: workbuddy-switch app -------------------------------
# Known real-world shapes:
#   process  wb-switch-rust.exe  (installer name differs from the "wbswitch" guess)
#   dir      %LOCALAPPDATA%\workbuddy-switch   (NOT under \Programs, and may be on D:)
#   legacy   Appx package com.wbswitch.app
$wbSwitchCand = @(
  "$env:LOCALAPPDATA\workbuddy-switch",
  "$env:LOCALAPPDATA\Programs\workbuddy-switch",
  "$env:LOCALAPPDATA\Programs\com.wbswitch.app"
)
foreach ($c in @($wbSwitchCand)) { $wbSwitchCand += (Get-MirrorPaths $c) }

$wbSwitchOk = $false
$wbSwitchHow = ''
$swProc = Get-Process -ErrorAction SilentlyContinue | Where-Object {
  $_.ProcessName -match '^wb-?switch' -or ($_.Path -and $_.Path -match 'workbuddy-switch')
}
if ($swProc) { $wbSwitchOk = $true; $wbSwitchHow = "running: $($swProc[0].ProcessName)" }
if (-not $wbSwitchOk) {
  $swAppx = Get-AppxPackage -ErrorAction SilentlyContinue | Where-Object { $_.Name -match 'wbswitch' }
  if ($swAppx) { $wbSwitchOk = $true; $wbSwitchHow = "appx: $($swAppx[0].Name)" }
}
if (-not $wbSwitchOk) {
  foreach ($d in ($wbSwitchCand | Select-Object -Unique)) {
    if (Test-Path $d) { $wbSwitchOk = $true; $wbSwitchHow = $d; break }
  }
}
$swDesc = 'workbuddy-switch APP installed (optional, route B)'
if ($wbSwitchOk -and $wbSwitchHow) { $swDesc += "  [$wbSwitchHow]" }
Test-Item $swDesc $wbSwitchOk 'Install .msix by double-click (or use route A)'

# --- gateway -----------------------------------------------------------------
$gw = Get-NetTCPConnection -State Listen -LocalPort 8789 -ErrorAction SilentlyContinue
Test-Item 'Gateway running (port 8789)' ($gw -ne $null) 'Run setup-gateway.ps1 or start.bat'

$task = Get-ScheduledTask -TaskName 'WorkBuddyGateway' -ErrorAction SilentlyContinue
Test-Item 'Auto-start scheduled task registered' ($task -ne $null) 'setup-gateway.ps1 registers it automatically'

Write-Host ''
Write-Host '=== Doctor done ===' -ForegroundColor Cyan
Write-Host 'Fix any [X], then run scripts\setup-gateway.ps1'
Write-Host ''
