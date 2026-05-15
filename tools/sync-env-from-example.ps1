param(
  [string]$EnvPath = (Join-Path $PSScriptRoot "..\.env"),
  [string]$ExamplePath = (Join-Path $PSScriptRoot "..\.env.example"),
  [switch]$Write,
  [switch]$NoBackup
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Resolve-DisplayPath([string]$Path) {
  $resolved = Resolve-Path -LiteralPath $Path -ErrorAction SilentlyContinue
  if ($resolved) {
    return $resolved.Path
  }
  return [System.IO.Path]::GetFullPath($Path)
}

function Read-ActiveEnv([string]$Path) {
  $values = [ordered]@{}
  if (-not (Test-Path -LiteralPath $Path)) {
    return $values
  }

  foreach ($line in Get-Content -LiteralPath $Path) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith("#")) {
      continue
    }

    if ($trimmed -match "^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$") {
      $values[$Matches[1]] = $Matches[2]
    }
  }

  return $values
}

function Read-ExampleKeys([string]$Path) {
  $keys = [ordered]@{}
  foreach ($line in Get-Content -LiteralPath $Path) {
    $candidate = $line.TrimStart()
    if ($candidate.StartsWith("#")) {
      $candidate = ($candidate -replace "^#\s*", "")
    }

    if ($candidate -match "^([A-Za-z_][A-Za-z0-9_]*)\s*=") {
      $keys[$Matches[1]] = $true
    }
  }

  return $keys
}

function Build-SyncedEnv([string]$ExamplePath, [System.Collections.IDictionary]$CurrentValues) {
  $exampleKeys = Read-ExampleKeys $ExamplePath
  $output = New-Object System.Collections.Generic.List[string]

  foreach ($line in Get-Content -LiteralPath $ExamplePath) {
    $trimmed = $line.TrimStart()
    $candidate = $trimmed
    if ($candidate.StartsWith("#")) {
      $candidate = ($candidate -replace "^#\s*", "")
    }

    if ($candidate -match "^([A-Za-z_][A-Za-z0-9_]*)\s*=") {
      $key = $Matches[1]
      if ($CurrentValues.Contains($key)) {
        $output.Add("$key=$($CurrentValues[$key])")
      } else {
        $output.Add($line)
      }
    } else {
      $output.Add($line)
    }
  }

  $extraKeys = @($CurrentValues.Keys | Where-Object { -not $exampleKeys.Contains($_) } | Sort-Object)
  if ($extraKeys.Count -gt 0) {
    $output.Add("")
    $output.Add("# Local-only entries not present in .env.example. Review before moving between machines.")
    foreach ($key in $extraKeys) {
      $output.Add("$key=$($CurrentValues[$key])")
    }
  }

  return [string[]]$output
}

if (-not (Test-Path -LiteralPath $ExamplePath)) {
  throw "Example file not found: $(Resolve-DisplayPath $ExamplePath)"
}

$current = Read-ActiveEnv $EnvPath
$exampleKeys = Read-ExampleKeys $ExamplePath
$missing = @($exampleKeys.Keys | Where-Object { -not $current.Contains($_) })
$extra = @($current.Keys | Where-Object { -not $exampleKeys.Contains($_) })

Write-Output "env=$(Resolve-DisplayPath $EnvPath)"
Write-Output "example=$(Resolve-DisplayPath $ExamplePath)"
Write-Output "current_keys=$($current.Count) example_keys=$($exampleKeys.Count) missing_in_env=$($missing.Count) extra_local=$($extra.Count)"
Write-Output "Secret values are never printed."

if (-not $Write) {
  Write-Output "Dry run only. Re-run with -Write to rewrite .env using .env.example order."
  exit 0
}

$next = Build-SyncedEnv $ExamplePath $current

if ((Test-Path -LiteralPath $EnvPath) -and -not $NoBackup) {
  $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $backupPath = "$EnvPath.bak-$timestamp"
  Copy-Item -LiteralPath $EnvPath -Destination $backupPath
  Write-Output "backup=$(Resolve-DisplayPath $backupPath)"
}

Set-Content -LiteralPath $EnvPath -Value $next -Encoding UTF8
Write-Output "updated=$(Resolve-DisplayPath $EnvPath)"
