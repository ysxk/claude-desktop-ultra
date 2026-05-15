param(
  [string]$ShortcutPath = "$([Environment]::GetFolderPath('Desktop'))\Claude CN.lnk"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Launcher = Join-Path $Root "scripts\Start-ClaudeCN.ps1"

$Shell = New-Object -ComObject WScript.Shell
$Shortcut = $Shell.CreateShortcut($ShortcutPath)
$Shortcut.TargetPath = "powershell.exe"
$Shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$Launcher`""
$Shortcut.WorkingDirectory = $Root
$Shortcut.IconLocation = "shell32.dll,220"
$Shortcut.Description = "Launch Claude Desktop with the non-invasive zh-CN overlay"
$Shortcut.Save()

Write-Host "Shortcut created: $ShortcutPath"
