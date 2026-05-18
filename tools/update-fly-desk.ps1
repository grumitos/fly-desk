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
$script:BootstrapVersion = "1.0.0"

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

function Get-CurrentReleaseVersion {
  $currentPath = Join-Path $script:ProjectRoot "app\current.json"
  if (-not (Test-Path -LiteralPath $currentPath)) {
    return "0.0.0"
  }

  try {
    $current = Read-JsonFile -Path $currentPath
    $version = ([string]$current.version).Trim()
    if ($version) {
      return $version
    }
  } catch {
  }

  return "0.0.0"
}

function Compare-SemVer {
  param(
    [string]$Left,
    [string]$Right
  )

  $leftMain = ([string]$Left).Split("-", 2)[0]
  $rightMain = ([string]$Right).Split("-", 2)[0]
  $leftParts = @($leftMain.Split(".") | ForEach-Object { [int]$_ })
  $rightParts = @($rightMain.Split(".") | ForEach-Object { [int]$_ })
  $length = [Math]::Max($leftParts.Count, $rightParts.Count)

  for ($index = 0; $index -lt $length; $index += 1) {
    $leftValue = if ($index -lt $leftParts.Count) { $leftParts[$index] } else { 0 }
    $rightValue = if ($index -lt $rightParts.Count) { $rightParts[$index] } else { 0 }
    if ($leftValue -lt $rightValue) {
      return -1
    }
    if ($leftValue -gt $rightValue) {
      return 1
    }
  }

  return 0
}

function Assert-Manifest {
  param(
    $Manifest,
    [string]$LocalVersion = (Get-CurrentReleaseVersion)
  )

  if ([int]$Manifest.schemaVersion -ne 1) {
    throw "manifest_invalid_schema"
  }

  if ([string]$Manifest.appId -ne "fly-desk") {
    throw "manifest_invalid_app"
  }

  $version = ([string]$Manifest.version).Trim()
  if (-not $version) {
    throw "manifest_missing_version"
  }

  if ((Compare-SemVer -Left $version -Right $LocalVersion) -le 0) {
    throw "manifest_no_newer_version"
  }

  $minimumBootstrapVersion = ([string]$Manifest.minimumBootstrapVersion).Trim()
  if ($minimumBootstrapVersion -and (Compare-SemVer -Left $minimumBootstrapVersion -Right $script:BootstrapVersion) -gt 0) {
    throw "manifest_requires_newer_bootstrap"
  }

  if ([string]$Manifest.package.platform -ne "windows-x64") {
    throw "manifest_invalid_platform"
  }

  if (-not ([string]$Manifest.package.url).Trim()) {
    throw "manifest_missing_package_url"
  }

  $sha256 = ([string]$Manifest.package.sha256).Trim()
  if ($sha256 -notmatch "^[a-f0-9]{64}$") {
    throw "manifest_invalid_package_hash"
  }

  return $true
}

function Get-UpdateClientConfig {
  $configPath = Join-Path $script:RuntimeDir "update-client.json"
  $config = if (Test-Path -LiteralPath $configPath) {
    Read-JsonFile -Path $configPath
  } else {
    [pscustomobject]@{}
  }

  $propertyNames = @($config.PSObject.Properties | ForEach-Object { $_.Name })
  $baseUrlValue = if ($propertyNames -contains "baseUrl") { [string]$config.baseUrl } else { "" }
  $channelValue = if ($propertyNames -contains "channel") { [string]$config.channel } else { "" }
  $tokenValue = if ($propertyNames -contains "token") { [string]$config.token } else { "" }
  $baseUrl = if ($env:FLY_DESK_UPDATE_BASE_URL) { $env:FLY_DESK_UPDATE_BASE_URL } else { $baseUrlValue }
  $channel = if ($env:FLY_DESK_UPDATE_CHANNEL) { $env:FLY_DESK_UPDATE_CHANNEL } else { $channelValue }
  $token = if ($env:FLY_DESK_UPDATE_TOKEN) { $env:FLY_DESK_UPDATE_TOKEN } else { $tokenValue }

  return [pscustomobject]@{
    baseUrl = $baseUrl.TrimEnd("/")
    channel = if ($channel) { $channel } else { "stable" }
    token = $token
  }
}

function New-UpdateHeaders {
  param($ClientConfig)

  if (-not $ClientConfig -or -not [string]$ClientConfig.token) {
    return @{}
  }

  return @{
    "X-FlyDesk-Update-Token" = [string]$ClientConfig.token
  }
}

function Read-Manifest {
  param($ClientConfig = (Get-UpdateClientConfig))

  if (-not $ClientConfig.baseUrl) {
    throw "manifest_unavailable"
  }

  $manifestUrl = "$($ClientConfig.baseUrl)/latest.json"
  return Invoke-RestMethod -Uri $manifestUrl -Headers (New-UpdateHeaders -ClientConfig $ClientConfig)
}

function Download-Package {
  param(
    $Manifest,
    $ClientConfig = (Get-UpdateClientConfig)
  )

  Ensure-UpdaterDirs
  $version = [string]$Manifest.version
  $downloadPath = Join-Path $script:RuntimeDir "downloads\fly-desk-windows-x64-v$version.zip"
  Remove-Item -LiteralPath $downloadPath -Force -ErrorAction SilentlyContinue

  $url = ([string]$Manifest.package.url).Trim()
  if ($url -match "^https?://") {
    Invoke-WebRequest -Uri $url -Headers (New-UpdateHeaders -ClientConfig $ClientConfig) -OutFile $downloadPath | Out-Null
  } elseif ($url -match "^file://") {
    $sourcePath = [System.Uri]::new($url).LocalPath
    Copy-Item -LiteralPath $sourcePath -Destination $downloadPath
  } else {
    Copy-Item -LiteralPath $url -Destination $downloadPath
  }

  return $downloadPath
}

function Assert-PackageHash {
  param(
    [string]$PackagePath,
    [string]$ExpectedSha256
  )

  $actual = (Get-FileHash -LiteralPath $PackagePath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $ExpectedSha256) {
    Remove-Item -LiteralPath $PackagePath -Force -ErrorAction SilentlyContinue
    throw "hash_mismatch"
  }

  return $true
}

function Expand-PackageToStaging {
  param(
    [string]$PackagePath,
    [string]$Version
  )

  Ensure-UpdaterDirs
  $stagingRoot = Join-Path $script:RuntimeDir "staging\$Version"
  Remove-Item -LiteralPath $stagingRoot -Recurse -Force -ErrorAction SilentlyContinue
  Ensure-Directory -Path $stagingRoot
  Expand-Archive -LiteralPath $PackagePath -DestinationPath $stagingRoot -Force

  $releaseDir = Join-Path $stagingRoot "fly-desk-release"
  if (-not (Test-Path -LiteralPath $releaseDir)) {
    throw "package_invalid"
  }

  return $releaseDir
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

function Install-ManifestUpdate {
  param(
    $Manifest,
    $ClientConfig = (Get-UpdateClientConfig)
  )

  $localVersion = Get-CurrentReleaseVersion
  [void](Assert-Manifest -Manifest $Manifest -LocalVersion $localVersion)
  $version = [string]$Manifest.version
  $packagePath = ""
  $stagedReleaseDir = ""

  try {
    $packagePath = Download-Package -Manifest $Manifest -ClientConfig $ClientConfig
    [void](Assert-PackageHash -PackagePath $packagePath -ExpectedSha256 ([string]$Manifest.package.sha256))
    $stagedReleaseDir = Expand-PackageToStaging -PackagePath $packagePath -Version $version
    $activated = Activate-StagedRelease -Version $version -StagedReleaseDir $stagedReleaseDir
    Remove-Item -LiteralPath (Join-Path $script:RuntimeDir "staging\$version") -Recurse -Force -ErrorAction SilentlyContinue
    return $activated
  } catch {
    if ($stagedReleaseDir) {
      Remove-Item -LiteralPath (Split-Path -Parent $stagedReleaseDir) -Recurse -Force -ErrorAction SilentlyContinue
    } else {
      Remove-Item -LiteralPath (Join-Path $script:RuntimeDir "staging\$version") -Recurse -Force -ErrorAction SilentlyContinue
    }
    throw
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

  try {
    $clientConfig = Get-UpdateClientConfig
    $manifest = Read-Manifest -ClientConfig $clientConfig
    Install-ManifestUpdate -Manifest $manifest -ClientConfig $clientConfig | Out-Null
  } catch {
    $message = if ($_.Exception) { $_.Exception.Message } else { "$_" }
    Write-UpdaterLog "Update check failed; keeping current local release. $message"
  }
}

if ($MyInvocation.InvocationName -ne "." -and -not (Test-EnabledFlag -Value $env:FLY_DESK_UPDATER_IMPORT_ONLY)) {
  Invoke-FlyDeskUpdate
}
