param(
  [int]$Port = 0,
  [switch]$Force
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Node = Get-Command node -ErrorAction SilentlyContinue

if (-not $Node) {
  throw "Node.js was not found. Please install Node.js 22+ or add node to PATH."
}

$ArgsList = @("launch")
if ($Port -gt 0) {
  $ArgsList += @("--port", "$Port")
}
if ($Force) {
  $ArgsList += "--force"
}

& $Node.Source (Join-Path $Root "bin\claude-cn.mjs") @ArgsList
