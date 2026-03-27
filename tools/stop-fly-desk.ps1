$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$projectRoot = Split-Path -Parent $PSScriptRoot
$runtimeDir = Join-Path $projectRoot ".launcher"
$stateFile = Join-Path $runtimeDir "state.json"
$launcherPort = if ($env:FLY_DESK_LAUNCHER_PORT) { [int]$env:FLY_DESK_LAUNCHER_PORT } else { 32123 }
$silentMode = $false

function Test-EnabledFlag {
  param([string]$Value)

  if (-not $Value) {
    return $false
  }

  switch ($Value.Trim().ToLowerInvariant()) {
    "1" { return $true }
    "true" { return $true }
    "yes" { return $true }
    "on" { return $true }
    default { return $false }
  }
}

$silentMode = Test-EnabledFlag -Value $env:FLY_DESK_SILENT

function Show-InfoPopup {
  param(
    [string]$Message,
    [int]$Icon = 64
  )

  if ($silentMode) {
    return
  }

  try {
    $shell = New-Object -ComObject WScript.Shell
    [void]$shell.Popup($Message, 0, "Fly Desk", $Icon)
  } catch {
  }
}

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

function Stop-ProcessTree {
  param([int]$ProcessId)

  if ($ProcessId -le 0) {
    return
  }

  try {
    & taskkill /PID $ProcessId /T /F | Out-Null
  } catch {
  }
}

$stopped = $false

if (Test-Path -LiteralPath $stateFile) {
  try {
    $state = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
    if ($state.pid) {
      Stop-ProcessTree -ProcessId ([int]$state.pid)
      $stopped = $true
    }
  } catch {
  }
}

foreach ($processId in (Get-ListeningProcessIdsForPort -Port $launcherPort)) {
  Stop-ProcessTree -ProcessId $processId
  $stopped = $true
}

Remove-Item -LiteralPath $stateFile -Force -ErrorAction SilentlyContinue

if ($stopped) {
  Show-InfoPopup "Fly Desk fue detenido."
} else {
  Show-InfoPopup "Fly Desk no tenia una instancia activa del acceso directo."
}
