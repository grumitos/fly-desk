$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$projectRoot = Split-Path -Parent $PSScriptRoot
$runtimeDir = Join-Path $projectRoot ".launcher"
$stateFile = Join-Path $runtimeDir "state.json"

function Get-ListeningProcessIdsForPort {
  param([int]$Port)

  $pattern = "^\s*TCP\s+\S+:$Port\s+\S+\s+LISTENING\s+(?<pid>\d+)\s*$"
  $lines = & netstat -ano -p tcp 2>$null
  $processIds = @()

  foreach ($line in $lines) {
    if ($line -match $pattern) {
      $processIds += [int]$Matches["pid"]
    }
  }

  return $processIds | Sort-Object -Unique
}

function Stop-PortsInRange {
  foreach ($port in 3000..3010) {
    $processIds = Get-ListeningProcessIdsForPort -Port $port
    foreach ($processId in $processIds) {
      if ($processId -le 0) {
        continue
      }

      try {
        Stop-Process -Id $processId -Force -ErrorAction Stop
      } catch {
      }
    }
  }
}

function Show-InfoPopup {
  param(
    [string]$Message,
    [int]$Icon = 64
  )

  try {
    $shell = New-Object -ComObject WScript.Shell
    [void]$shell.Popup($Message, 0, "Fly Desk", $Icon)
  } catch {
  }
}

if (-not (Test-Path -LiteralPath $stateFile)) {
  Stop-PortsInRange
  Show-InfoPopup "Fly Desk no tiene una instancia registrada en ejecucion."
  exit 0
}

try {
  $state = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
} catch {
  Remove-Item -LiteralPath $stateFile -Force -ErrorAction SilentlyContinue
  Show-InfoPopup "El estado del launcher estaba dañado y fue limpiado."
  exit 0
}

$serverPid = 0
if ($state.pid) {
  $serverPid = [int]$state.pid
}

if ($serverPid -gt 0) {
  try {
    Stop-Process -Id $serverPid -Force -ErrorAction Stop
  } catch {
  }
}

Stop-PortsInRange

Remove-Item -LiteralPath $stateFile -Force -ErrorAction SilentlyContinue
Show-InfoPopup "Fly Desk fue detenido."
