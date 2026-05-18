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
$script:ReceiptsDir = Join-Path $script:RuntimeDir "receipts"
$script:PendingReceiptsDir = Join-Path $script:ReceiptsDir "pending"
$script:SentReceiptsDir = Join-Path $script:ReceiptsDir "sent"
$script:UpdateLockDir = Join-Path $script:RuntimeDir "update-lock"
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
  Ensure-Directory -Path $script:PendingReceiptsDir
  Ensure-Directory -Path $script:SentReceiptsDir
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

function Get-PropertyValue {
  param(
    $Object,
    [string]$Name,
    $Fallback = ""
  )

  if (-not $Object) {
    return $Fallback
  }

  if (@($Object.PSObject.Properties | ForEach-Object { $_.Name }) -contains $Name) {
    return $Object.$Name
  }

  return $Fallback
}

function Get-OrCreateInstallId {
  Ensure-UpdaterDirs
  $installIdPath = Join-Path $script:RuntimeDir "install-id.json"
  if (Test-Path -LiteralPath $installIdPath) {
    try {
      $existing = Read-JsonFile -Path $installIdPath
      $installId = ([string](Get-PropertyValue -Object $existing -Name "installId")).Trim()
      if ($installId) {
        return $installId
      }
    } catch {
    }
  }

  $installId = [guid]::NewGuid().ToString()
  Write-JsonFile -Path $installIdPath -Value ([pscustomobject]@{
    installId = $installId
    createdAt = (Get-Date).ToUniversalTime().ToString("o")
  })

  return $installId
}

function Write-Receipt {
  param(
    [string]$EventType,
    [string]$Version,
    [string]$PreviousVersion = "",
    [string]$ReleaseId = "",
    [string]$Status = "success",
    [string]$ErrorCode = ""
  )

  Ensure-UpdaterDirs
  $eventId = [guid]::NewGuid().ToString()
  $occurredAt = (Get-Date).ToUniversalTime().ToString("o")
  $stamp = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssfffZ")
  $receiptPath = Join-Path $script:PendingReceiptsDir "$stamp-$eventId.json"

  Write-JsonFile -Path $receiptPath -Value ([pscustomobject]@{
    appId = "fly-desk"
    installId = Get-OrCreateInstallId
    eventId = $eventId
    eventType = $EventType
    version = $Version
    previousVersion = $PreviousVersion
    releaseId = $ReleaseId
    bootstrapVersion = $script:BootstrapVersion
    occurredAt = $occurredAt
    status = $Status
    errorCode = $ErrorCode
  })

  return $receiptPath
}

function Get-ReceiptUrl {
  param($ClientConfig)

  $envReceiptUrl = [Environment]::GetEnvironmentVariable("FLY_DESK_RECEIPTS_URL")
  if ($envReceiptUrl) {
    return $envReceiptUrl
  }

  $receiptConfig = Get-PropertyValue -Object $ClientConfig -Name "receipts" -Fallback $null
  $receiptUrl = [string](Get-PropertyValue -Object $receiptConfig -Name "url")
  if ($receiptUrl) {
    return $receiptUrl
  }

  if ($ClientConfig -and [string]$ClientConfig.baseUrl) {
    return "$($ClientConfig.baseUrl)/receipts"
  }

  return ""
}

function Test-ReceiptsEnabled {
  param($ClientConfig)

  $envFlag = [Environment]::GetEnvironmentVariable("FLY_DESK_RECEIPTS_ENABLED")
  if ($envFlag) {
    return Test-EnabledFlag -Value $envFlag
  }

  $receiptConfig = Get-PropertyValue -Object $ClientConfig -Name "receipts" -Fallback $null
  $enabled = Get-PropertyValue -Object $receiptConfig -Name "enabled" -Fallback $true
  if ($enabled -is [bool]) {
    return $enabled
  }

  return Test-EnabledFlag -Value ([string]$enabled)
}

function Send-Receipt {
  param(
    $Receipt,
    $ClientConfig = (Get-UpdateClientConfig)
  )

  if (-not (Test-ReceiptsEnabled -ClientConfig $ClientConfig)) {
    return $false
  }

  $receiptUrl = Get-ReceiptUrl -ClientConfig $ClientConfig
  if (-not $receiptUrl) {
    return $false
  }

  try {
    $response = Invoke-WebRequest `
      -Uri $receiptUrl `
      -Method Post `
      -Headers (New-UpdateHeaders -ClientConfig $ClientConfig) `
      -ContentType "application/json" `
      -Body ($Receipt | ConvertTo-Json -Depth 8) `
      -UseBasicParsing
    return [int]$response.StatusCode -ge 200 -and [int]$response.StatusCode -lt 300
  } catch {
    return $false
  }
}

function Move-ReceiptToSent {
  param([string]$Path)

  Ensure-UpdaterDirs
  $destination = Join-Path $script:SentReceiptsDir (Split-Path -Leaf $Path)
  if (Test-Path -LiteralPath $destination) {
    $destination = Join-Path $script:SentReceiptsDir "$([guid]::NewGuid().ToString())-$(Split-Path -Leaf $Path)"
  }

  Move-Item -LiteralPath $Path -Destination $destination
  return $destination
}

function Flush-Receipts {
  param($ClientConfig = (Get-UpdateClientConfig))

  Ensure-UpdaterDirs
  $flushed = @()
  foreach ($receiptFile in @(Get-ChildItem -LiteralPath $script:PendingReceiptsDir -Filter "*.json" -File | Sort-Object Name)) {
    try {
      $receipt = Read-JsonFile -Path $receiptFile.FullName
      if (Send-Receipt -Receipt $receipt -ClientConfig $ClientConfig) {
        $flushed += Move-ReceiptToSent -Path $receiptFile.FullName
      }
    } catch {
      Write-UpdaterLog "Receipt flush failed for $($receiptFile.Name): $($_.Exception.Message)"
    }
  }

  return $flushed
}

function Invoke-WithUpdateLock {
  param([scriptblock]$ScriptBlock)

  Ensure-UpdaterDirs
  try {
    New-Item -ItemType Directory -Path $script:UpdateLockDir -ErrorAction Stop | Out-Null
  } catch {
    throw "update_already_running"
  }

  try {
    Write-JsonFile -Path (Join-Path $script:UpdateLockDir "owner.json") -Value ([pscustomobject]@{
      pid = $PID
      createdAt = (Get-Date).ToUniversalTime().ToString("o")
    })
    return & $ScriptBlock
  } finally {
    Remove-Item -LiteralPath $script:UpdateLockDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function Get-CurrentReleasePointer {
  $currentPath = Join-Path $script:ProjectRoot "app\current.json"
  if (-not (Test-Path -LiteralPath $currentPath)) {
    return $null
  }

  try {
    return Read-JsonFile -Path $currentPath
  } catch {
    return $null
  }
}

function Get-ProtectedReleaseDirs {
  $protected = @()
  $current = Get-CurrentReleasePointer
  $currentVersion = ([string](Get-PropertyValue -Object $current -Name "version")).Trim()
  $currentReleaseDir = ([string](Get-PropertyValue -Object $current -Name "releaseDir")).Trim()
  if ($currentVersion -and -not $currentReleaseDir) {
    $currentReleaseDir = Join-Path $script:ProjectRoot "app\releases\$currentVersion"
  }
  if ($currentReleaseDir) {
    $protected += [System.IO.Path]::GetFullPath($currentReleaseDir)
  }

  $lastKnownGoodPath = Get-LastKnownGoodFilePath
  if (Test-Path -LiteralPath $lastKnownGoodPath) {
    try {
      $good = Read-JsonFile -Path $lastKnownGoodPath
      $goodVersion = ([string](Get-PropertyValue -Object $good -Name "version")).Trim()
      $goodReleaseDir = ([string](Get-PropertyValue -Object $good -Name "releaseDir")).Trim()
      if ($goodVersion -and -not $goodReleaseDir) {
        $goodReleaseDir = Join-Path $script:ProjectRoot "app\releases\$goodVersion"
      }
      if ($goodReleaseDir) {
        $protected += [System.IO.Path]::GetFullPath($goodReleaseDir)
      }
    } catch {
    }
  }

  return $protected | Sort-Object -Unique
}

function Get-ReleaseSortVersion {
  param([string]$Version)

  try {
    return [version](([string]$Version).Split("-", 2)[0])
  } catch {
    return [version]"0.0.0"
  }
}

function Prune-OldReleases {
  param([int]$KeepCount = 3)

  Ensure-UpdaterDirs
  $releasesRoot = Join-Path $script:ProjectRoot "app\releases"
  if (-not (Test-Path -LiteralPath $releasesRoot)) {
    return @()
  }

  $releasesRootFull = [System.IO.Path]::GetFullPath($releasesRoot)
  $protected = @(Get-ProtectedReleaseDirs)
  $keep = New-Object "System.Collections.Generic.HashSet[string]" ([System.StringComparer]::OrdinalIgnoreCase)
  foreach ($path in $protected) {
    [void]$keep.Add([System.IO.Path]::GetFullPath($path))
  }

  $releaseDirs = @(Get-ChildItem -LiteralPath $releasesRoot -Directory | Sort-Object `
    @{ Expression = { Get-ReleaseSortVersion -Version $_.Name }; Descending = $true },
    @{ Expression = { $_.Name }; Descending = $true })

  foreach ($releaseDir in $releaseDirs) {
    if ($keep.Count -ge $KeepCount) {
      break
    }

    [void]$keep.Add([System.IO.Path]::GetFullPath($releaseDir.FullName))
  }

  $removed = @()
  foreach ($releaseDir in $releaseDirs) {
    $fullPath = [System.IO.Path]::GetFullPath($releaseDir.FullName)
    if ($keep.Contains($fullPath)) {
      continue
    }

    if (-not $fullPath.StartsWith($releasesRootFull, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "Refusing to prune release outside app/releases: $fullPath"
    }

    Remove-Item -LiteralPath $fullPath -Recurse -Force
    $removed += $fullPath
    Write-UpdaterLog "Pruned old release $fullPath."
  }

  return $removed
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
  $receiptsValue = if ($propertyNames -contains "receipts") { $config.receipts } else { $null }
  $baseUrl = if ($env:FLY_DESK_UPDATE_BASE_URL) { $env:FLY_DESK_UPDATE_BASE_URL } else { $baseUrlValue }
  $channel = if ($env:FLY_DESK_UPDATE_CHANNEL) { $env:FLY_DESK_UPDATE_CHANNEL } else { $channelValue }
  $token = if ($env:FLY_DESK_UPDATE_TOKEN) { $env:FLY_DESK_UPDATE_TOKEN } else { $tokenValue }

  return [pscustomobject]@{
    baseUrl = $baseUrl.TrimEnd("/")
    channel = if ($channel) { $channel } else { "stable" }
    token = $token
    receipts = $receiptsValue
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
    Invoke-WebRequest -Uri $url -Headers (New-UpdateHeaders -ClientConfig $ClientConfig) -OutFile $downloadPath -UseBasicParsing | Out-Null
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
  $releaseId = [string](Get-PropertyValue -Object $Manifest -Name "releaseId")
  $packagePath = ""
  $stagedReleaseDir = ""

  try {
    $packagePath = Download-Package -Manifest $Manifest -ClientConfig $ClientConfig
    [void](Assert-PackageHash -PackagePath $packagePath -ExpectedSha256 ([string]$Manifest.package.sha256))
    [void](Write-Receipt -EventType "download_verified" -Version $version -PreviousVersion $localVersion -ReleaseId $releaseId -Status "success")
    $stagedReleaseDir = Expand-PackageToStaging -PackagePath $packagePath -Version $version
    $activated = Activate-StagedRelease -Version $version -StagedReleaseDir $stagedReleaseDir
    [void](Write-Receipt -EventType "activated" -Version $version -PreviousVersion $localVersion -ReleaseId $releaseId -Status "success")
    Remove-Item -LiteralPath (Join-Path $script:RuntimeDir "staging\$version") -Recurse -Force -ErrorAction SilentlyContinue
    return $activated
  } catch {
    $errorCode = if ($_.Exception) { $_.Exception.Message } else { "$_" }
    [void](Write-Receipt -EventType "failed" -Version $version -PreviousVersion $localVersion -ReleaseId $releaseId -Status "failed" -ErrorCode $errorCode)
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
    Invoke-WithUpdateLock -ScriptBlock {
      $clientConfig = Get-UpdateClientConfig
      [void](Flush-Receipts -ClientConfig $clientConfig)

      $localVersion = Get-CurrentReleaseVersion
      [void](Write-Receipt -EventType "check_started" -Version $localVersion -Status "success")

      try {
        $manifest = Read-Manifest -ClientConfig $clientConfig
      } catch {
        [void](Write-Receipt -EventType "failed" -Version $localVersion -Status "failed" -ErrorCode "manifest_unavailable")
        throw
      }

      $manifestVersion = [string]$manifest.version
      $releaseId = [string](Get-PropertyValue -Object $manifest -Name "releaseId")
      try {
        [void](Assert-Manifest -Manifest $manifest -LocalVersion $localVersion)
      } catch {
        $errorCode = if ($_.Exception) { $_.Exception.Message } else { "$_" }
        if ($errorCode -eq "manifest_no_newer_version") {
          [void](Write-Receipt -EventType "no_update" -Version $localVersion -ReleaseId $releaseId -Status "success")
          [void](Flush-Receipts -ClientConfig $clientConfig)
          return
        }

        [void](Write-Receipt -EventType "failed" -Version $localVersion -ReleaseId $releaseId -Status "failed" -ErrorCode $errorCode)
        throw
      }

      [void](Write-Receipt -EventType "update_available" -Version $manifestVersion -PreviousVersion $localVersion -ReleaseId $releaseId -Status "success")
      Install-ManifestUpdate -Manifest $manifest -ClientConfig $clientConfig | Out-Null
      [void](Flush-Receipts -ClientConfig $clientConfig)
    } | Out-Null
  } catch {
    $message = if ($_.Exception) { $_.Exception.Message } else { "$_" }
    Write-UpdaterLog "Update check failed; keeping current local release. $message"
  }
}

if ($MyInvocation.InvocationName -ne "." -and -not (Test-EnabledFlag -Value $env:FLY_DESK_UPDATER_IMPORT_ONLY)) {
  Invoke-FlyDeskUpdate
}
