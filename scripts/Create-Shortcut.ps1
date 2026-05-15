param(
  [string]$ShortcutName = "Claude Desktop Ultra.lnk"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Desktop = [Environment]::GetFolderPath([Environment+SpecialFolder]::DesktopDirectory)
if ([string]::IsNullOrWhiteSpace($Desktop)) {
  $Desktop = [Environment]::GetFolderPath("Desktop")
}

$ExeLauncher = Join-Path $Root "dist\ClaudeCN.exe"
$ScriptLauncher = Join-Path $Root "scripts\Start-ClaudeCN.ps1"

if (Test-Path -LiteralPath $ExeLauncher) {
  $TargetPath = $ExeLauncher
  $Arguments = "launch"
  $WorkingDirectory = Split-Path -Parent $ExeLauncher
} else {
  $TargetPath = "powershell.exe"
  $Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$ScriptLauncher`""
  $WorkingDirectory = $Root
}

$Shell = New-Object -ComObject WScript.Shell
$KnownNames = @($ShortcutName, "Claude CN.lnk")
$ShortcutPath = $null

foreach ($Name in $KnownNames) {
  $Candidate = Join-Path $Desktop $Name
  if (Test-Path -LiteralPath $Candidate) {
    $ShortcutPath = $Candidate
    break
  }
}

if (-not $ShortcutPath) {
  $ShortcutPath = Join-Path $Desktop $ShortcutName
}

$RuntimeRoot = Join-Path $env:LOCALAPPDATA "ClaudeCNOverlay\runtime"
$RuntimeIcon = $null
if (Test-Path -LiteralPath $RuntimeRoot) {
  $RuntimeIcon = Get-ChildItem -LiteralPath $RuntimeRoot -Filter "ClaudeCNRuntime.ico" -Recurse -File -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
}

$Shortcut = $Shell.CreateShortcut($ShortcutPath)
$Shortcut.TargetPath = $TargetPath
$Shortcut.Arguments = $Arguments
$Shortcut.WorkingDirectory = $WorkingDirectory
if ($RuntimeIcon) {
  $Shortcut.IconLocation = $RuntimeIcon.FullName
} elseif (Test-Path -LiteralPath $ExeLauncher) {
  $Shortcut.IconLocation = "$ExeLauncher,0"
} else {
  $Shortcut.IconLocation = "shell32.dll,220"
}
$Shortcut.Description = "Claude Desktop Ultra - non-invasive Claude Desktop enhancer"
$Shortcut.Save()

Write-Host "Shortcut ready: $ShortcutPath"
