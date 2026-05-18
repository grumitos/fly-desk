$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$script:ProjectRoot = if ($env:FLY_DESK_INSTALL_ROOT) {
  [System.IO.Path]::GetFullPath($env:FLY_DESK_INSTALL_ROOT)
} else {
  Split-Path -Parent $PSScriptRoot
}
$script:RuntimeDir = Join-Path $script:ProjectRoot ".launcher"
$script:LogsDir = Join-Path $script:RuntimeDir "logs"
$script:UpdaterLog = Join-Path $script:LogsDir "updater.log"

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

function Ensure-Directory {
  param([string]$Path)

  if (-not (Test-Path -LiteralPath $Path)) {
    New-Item -ItemType Directory -Path $Path | Out-Null
  }
}

function Ensure-UpdaterDirs {
  Ensure-Directory -Path $script:RuntimeDir
  Ensure-Directory -Path $script:LogsDir
  Ensure-Directory -Path (Join-Path $script:RuntimeDir "downloads")
  Ensure-Directory -Path (Join-Path $script:RuntimeDir "staging")
  Ensure-Directory -Path (Join-Path $script:ProjectRoot "app\releases")
}

function Write-UpdaterLog {
  param([string]$Message)

  Ensure-UpdaterDirs
  $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  Add-Content -LiteralPath $script:UpdaterLog -Value "[$timestamp] $Message"
}

function Read-JsonFile {
  param([string]$Path)

  try {
    return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
  } catch {
    throw "Invalid JSON at ${Path}: $($_.Exception.Message)"
  }
}

function Write-JsonFile {
  param(
    [string]$Path,
    $Value
  )

  $parent = Split-Path -Parent $Path
  if ($parent) {
    Ensure-Directory -Path $parent
  }

  $json = $Value | ConvertTo-Json
  $encoding = New-Object System.Text.UTF8Encoding -ArgumentList $false
  [System.IO.File]::WriteAllText($Path, $json, $encoding)
}

function Validate-StagedRelease {
  param(
    [string]$Version,
    [string]$StagedReleaseDir
  )

  $releaseDir = [System.IO.Path]::GetFullPath($StagedReleaseDir)
  $releaseJsonPath = Join-Path $releaseDir "release.json"
  $executablePath = Join-Path $releaseDir "bin\fly-desk.exe"
  $indexPath = Join-Path $releaseDir "frontend\dist\index.html"

  if (-not (Test-Path -LiteralPath $releaseJsonPath)) {
    throw "Staged release is missing release.json: $releaseJsonPath"
  }

  if (-not (Test-Path -LiteralPath $executablePath)) {
    throw "Staged release is missing executable: $executablePath"
  }

  if (-not (Test-Path -LiteralPath $indexPath)) {
    throw "Staged release is missing frontend index: $indexPath"
  }

  $release = Read-JsonFile -Path $releaseJsonPath
  if ([int]$release.schemaVersion -ne 1) {
    throw "Unsupported release.json schemaVersion: $($release.schemaVersion)"
  }

  if ([string]$release.appId -ne "fly-desk") {
    throw "Unexpected release appId: $($release.appId)"
  }

  if ([string]$release.version -ne $Version) {
    throw "release.json version $($release.version) does not match staged version $Version"
  }

  return [pscustomobject]@{
    version = $Version
    stagedReleaseDir = $releaseDir
    executablePath = $executablePath
    publicDir = Split-Path -Parent $indexPath
  }
}

function Write-CurrentRelease {
  param(
    [string]$Version,
    [string]$ReleaseDir
  )

  $appDir = Join-Path $script:ProjectRoot "app"
  Ensure-Directory -Path $appDir
  Write-JsonFile -Path (Join-Path $appDir "current.json") -Value ([pscustomobject]@{
    version = $Version
    releaseDir = $ReleaseDir
    activatedAt = (Get-Date).ToUniversalTime().ToString("o")
  })
}

function Get-LastKnownGoodFilePath {
  return Join-Path $script:RuntimeDir "last-known-good.json"
}

function Read-LastKnownGood {
  $lastKnownGoodPath = Get-LastKnownGoodFilePath
  if (-not (Test-Path -LiteralPath $lastKnownGoodPath)) {
    throw "Missing last-known-good.json."
  }

  $good = Read-JsonFile -Path $lastKnownGoodPath
  $version = ([string]$good.version).Trim()
  $releaseDir = ([string]$good.releaseDir).Trim()
  if (-not $version -or -not $releaseDir) {
    throw "last-known-good.json is missing version or releaseDir."
  }

  $releaseDir = [System.IO.Path]::GetFullPath($releaseDir)
  if (-not (Test-Path -LiteralPath (Join-Path $releaseDir "release.json"))) {
    throw "Last known good release is missing release.json: $releaseDir"
  }

  if (-not (Test-Path -LiteralPath (Join-Path $releaseDir "bin\fly-desk.exe"))) {
    throw "Last known good release is missing executable: $releaseDir"
  }

  if (-not (Test-Path -LiteralPath (Join-Path $releaseDir "frontend\dist\index.html"))) {
    throw "Last known good release is missing frontend index: $releaseDir"
  }

  return [pscustomobject]@{
    version = $version
    releaseDir = $releaseDir
  }
}

function Rollback-ToLastKnownGood {
  Ensure-UpdaterDirs
  $good = Read-LastKnownGood
  Write-CurrentRelease -Version $good.version -ReleaseDir $good.releaseDir
  Write-UpdaterLog "Rolled back current release pointer to $($good.version) at $($good.releaseDir)."

  return $good
}

function Activate-StagedRelease {
  param(
    [string]$Version,
    [string]$StagedReleaseDir
  )

  Ensure-UpdaterDirs
  $validated = Validate-StagedRelease -Version $Version -StagedReleaseDir $StagedReleaseDir
  $releaseDir = Join-Path $script:ProjectRoot "app\releases\$Version"
  $releaseDir = [System.IO.Path]::GetFullPath($releaseDir)

  if (Test-Path -LiteralPath $releaseDir) {
    throw "Release already exists: $releaseDir"
  }

  Ensure-Directory -Path (Split-Path -Parent $releaseDir)
  Move-Item -LiteralPath $validated.stagedReleaseDir -Destination $releaseDir
  Write-CurrentRelease -Version $Version -ReleaseDir $releaseDir
  Write-UpdaterLog "Activated release $Version at $releaseDir."

  return [pscustomobject]@{
    version = $Version
    releaseDir = $releaseDir
  }
}

function Invoke-FlyDeskUpdate {
  Ensure-UpdaterDirs

  if (Test-EnabledFlag -Value $env:FLY_DESK_SKIP_SELF_UPDATE) {
    Write-UpdaterLog "Self-update skipped by FLY_DESK_SKIP_SELF_UPDATE."
    return
  }

  $clientConfigPath = Join-Path $script:RuntimeDir "update-client.json"
  if (-not (Test-Path -LiteralPath $clientConfigPath)) {
    Write-UpdaterLog "No update-client.json found; remote update check skipped for this phase."
    return
  }

  Write-UpdaterLog "Remote update checks are not enabled in this phase; local release remains unchanged."
}

if ($MyInvocation.InvocationName -ne "." -and -not (Test-EnabledFlag -Value $env:FLY_DESK_UPDATER_IMPORT_ONLY)) {
  Invoke-FlyDeskUpdate
}
