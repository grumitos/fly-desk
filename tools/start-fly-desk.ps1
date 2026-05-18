$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$script:AppName = "Fly Desk"
$script:ProjectRoot = if ($env:FLY_DESK_INSTALL_ROOT) {
  [System.IO.Path]::GetFullPath($env:FLY_DESK_INSTALL_ROOT)
} else {
  Split-Path -Parent $PSScriptRoot
}
$script:RuntimeDir = Join-Path $script:ProjectRoot ".launcher"
$script:LogsDir = Join-Path $script:RuntimeDir "logs"
$script:StateFile = Join-Path $script:RuntimeDir "state.json"
$script:LauncherLog = Join-Path $script:LogsDir "launcher.log"
$script:LauncherPort = if ($env:FLY_DESK_LAUNCHER_PORT) { [int]$env:FLY_DESK_LAUNCHER_PORT } else { 32123 }
$script:ServerOutLog = ""
$script:ServerErrLog = ""
$script:SkipBrowser = $false
$script:SilentMode = $false

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

function Read-NonNegativeIntEnv {
  param(
    [string]$Name,
    [int]$Fallback
  )

  $value = [Environment]::GetEnvironmentVariable($Name)
  if (-not $value) {
    return $Fallback
  }

  $parsed = 0
  if ([int]::TryParse($value.Trim(), [ref]$parsed) -and $parsed -ge 0) {
    return $parsed
  }

  return $Fallback
}

$script:SkipBrowser = Test-EnabledFlag -Value $env:FLY_DESK_SKIP_BROWSER
$script:SilentMode = Test-EnabledFlag -Value $env:FLY_DESK_SILENT
$script:LauncherPort = Read-NonNegativeIntEnv -Name "FLY_DESK_LAUNCHER_PORT" -Fallback $script:LauncherPort

function Ensure-Directory {
  param([string]$Path)

  if (-not (Test-Path -LiteralPath $Path)) {
    New-Item -ItemType Directory -Path $Path | Out-Null
  }
}

function Ensure-RuntimeDir {
  Ensure-Directory -Path $script:RuntimeDir
  Ensure-Directory -Path $script:LogsDir
}

function Write-LauncherLog {
  param([string]$Message)

  Ensure-RuntimeDir
  $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  Add-Content -LiteralPath $script:LauncherLog -Value "[$timestamp] $Message"
}

function Show-Popup {
  param(
    [string]$Message,
    [int]$Icon = 64
  )

  if ($script:SilentMode) {
    Write-LauncherLog "Popup skipped in silent mode: $Message"
    return
  }

  try {
    $shell = New-Object -ComObject WScript.Shell
    [void]$shell.Popup($Message, 0, $script:AppName, $Icon)
  } catch {
    Write-LauncherLog "Could not show popup: $($_.Exception.Message)"
  }
}

function Fail-Launcher {
  param([string]$Message)

  Write-LauncherLog "ERROR: $Message"
  Show-Popup "$Message`n`nRevisa:`n$script:LauncherLog" 16
  throw $Message
}

function Initialize-RunLogs {
  Ensure-RuntimeDir
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $script:ServerOutLog = Join-Path $script:LogsDir "server-$stamp.out.log"
  $script:ServerErrLog = Join-Path $script:LogsDir "server-$stamp.err.log"
  Set-Content -LiteralPath $script:ServerOutLog -Value "" -Encoding UTF8
  Set-Content -LiteralPath $script:ServerErrLog -Value "" -Encoding UTF8
}

function Get-CommandPath {
  param([string]$Name)

  $command = Get-Command $Name -ErrorAction SilentlyContinue
  if ($command) {
    return $command.Source
  }

  return $null
}

function Get-BunPath {
  @(
    (Get-CommandPath "bun.exe"),
    (Get-CommandPath "bun"),
    (Join-Path $env:USERPROFILE ".bun\bin\bun.exe")
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
}

function Assert-BunReady {
  $bunPath = Get-BunPath
  if (-not $bunPath) {
    Fail-Launcher "No se encontro Bun para modo desarrollo. Instala Bun o usa una release empaquetada."
  }

  $versionText = (& $bunPath --version).Trim()
  if (-not $versionText) {
    Fail-Launcher "No se pudo leer correctamente la version de Bun."
  }

  Write-LauncherLog "Bun detectado: $versionText ($bunPath)"
  return $bunPath
}

function Get-LatestWriteTime {
  param([string[]]$Paths)

  $latest = Get-Date "2000-01-01"
  foreach ($path in $Paths) {
    if (-not (Test-Path -LiteralPath $path)) {
      continue
    }

    $items = Get-ChildItem -LiteralPath $path -Recurse -File -ErrorAction SilentlyContinue
    foreach ($item in $items) {
      if ($item.LastWriteTime -gt $latest) {
        $latest = $item.LastWriteTime
      }
    }
  }

  return $latest
}

function Test-BuildNeeded {
  $distEntry = Join-Path $script:ProjectRoot "frontend\dist\index.html"
  if (-not (Test-Path -LiteralPath $distEntry)) {
    return $true
  }

  $distTime = (Get-Item -LiteralPath $distEntry).LastWriteTime
  $sourceTime = Get-LatestWriteTime -Paths @(
    (Join-Path $script:ProjectRoot "src"),
    (Join-Path $script:ProjectRoot "frontend\src"),
    (Join-Path $script:ProjectRoot "frontend\public"),
    (Join-Path $script:ProjectRoot "frontend\index.html"),
    (Join-Path $script:ProjectRoot "scripts\build-frontend.ts")
  )

  $configFiles = @(
    (Join-Path $script:ProjectRoot "package.json"),
    (Join-Path $script:ProjectRoot "frontend\package.json"),
    (Join-Path $script:ProjectRoot "bun.lock"),
    (Join-Path $script:ProjectRoot "bunfig.toml"),
    (Join-Path $script:ProjectRoot "tsconfig.json"),
    (Join-Path $script:ProjectRoot "frontend\tsconfig.json"),
    (Join-Path $script:ProjectRoot "frontend\tsconfig.app.json")
  ) | Where-Object { Test-Path -LiteralPath $_ }

  foreach ($configFile in $configFiles) {
    if ((Get-Item -LiteralPath $configFile).LastWriteTime -gt $distTime) {
      return $true
    }
  }

  return $sourceTime -gt $distTime
}

function Invoke-LoggedProcess {
  param(
    [string]$FilePath,
    [string[]]$ArgumentList,
    [string]$WorkingDirectory,
    [string]$StepName
  )

  Write-LauncherLog "${StepName}: starting $FilePath $($ArgumentList -join ' ')"
  $process = Start-Process `
    -FilePath $FilePath `
    -ArgumentList $ArgumentList `
    -WorkingDirectory $WorkingDirectory `
    -Wait `
    -PassThru `
    -WindowStyle Hidden `
    -RedirectStandardOutput $script:ServerOutLog `
    -RedirectStandardError $script:ServerErrLog

  if ($process.ExitCode -ne 0) {
    Fail-Launcher "$StepName fallo con codigo $($process.ExitCode). Revisa:`n$script:ServerOutLog`n$script:ServerErrLog"
  }
}

function Ensure-DependenciesAndBuild {
  $bunPath = Assert-BunReady
  $nodeModules = Join-Path $script:ProjectRoot "node_modules"

  if (-not (Test-Path -LiteralPath $nodeModules)) {
    Invoke-LoggedProcess -FilePath $bunPath -ArgumentList @("install", "--frozen-lockfile") -WorkingDirectory $script:ProjectRoot -StepName "bun install --frozen-lockfile"
  }

  if (Test-BuildNeeded) {
    Invoke-LoggedProcess -FilePath $bunPath -ArgumentList @("run", "build") -WorkingDirectory $script:ProjectRoot -StepName "bun run build"
  }

  return $bunPath
}

function Get-CurrentFilePath {
  return Join-Path $script:ProjectRoot "app\current.json"
}

function Test-ReleaseModeAvailable {
  return Test-Path -LiteralPath (Get-CurrentFilePath)
}

function Read-CurrentReleasePointer {
  $currentFile = Get-CurrentFilePath
  if (-not (Test-Path -LiteralPath $currentFile)) {
    throw "Missing app/current.json."
  }

  try {
    return Get-Content -LiteralPath $currentFile -Raw | ConvertFrom-Json
  } catch {
    throw "app/current.json is not valid JSON: $($_.Exception.Message)"
  }
}

function Get-ActiveRelease {
  $current = Read-CurrentReleasePointer
  $version = ([string]$current.version).Trim()
  if (-not $version) {
    throw "app/current.json is missing version."
  }

  $releaseDir = ([string]$current.releaseDir).Trim()
  if (-not $releaseDir) {
    $releaseDir = Join-Path $script:ProjectRoot "app\releases\$version"
  }

  $releaseDir = [System.IO.Path]::GetFullPath($releaseDir)
  $executablePath = Join-Path $releaseDir "bin\fly-desk.exe"
  $publicDir = Join-Path $releaseDir "frontend\dist"
  $indexPath = Join-Path $publicDir "index.html"
  $releaseJsonPath = Join-Path $releaseDir "release.json"

  if (-not (Test-Path -LiteralPath $releaseJsonPath)) {
    throw "Active release is missing release.json: $releaseJsonPath"
  }

  if (-not (Test-Path -LiteralPath $executablePath)) {
    throw "Active release is missing executable: $executablePath"
  }

  if (-not (Test-Path -LiteralPath $indexPath)) {
    throw "Active release is missing frontend index: $indexPath"
  }

  return [pscustomobject]@{
    version = $version
    releaseDir = $releaseDir
    executablePath = $executablePath
    publicDir = $publicDir
  }
}

function New-ReleaseEnvironment {
  param(
    [string]$ReleaseDir,
    [int]$Port,
    [string]$ExecutablePath = ""
  )

  $outputCacheDir = Join-Path $script:ProjectRoot "output\cache"
  Ensure-Directory -Path $outputCacheDir
  $publicDir = Join-Path $ReleaseDir "frontend\dist"

  return @{
    "PORT" = "$Port"
    "FLY_DESK_RELEASE_DIR" = $ReleaseDir
    "FLY_DESK_PUBLIC_DIR" = $publicDir
    "FLY_DESK_SESSION_DB_PATH" = Join-Path $outputCacheDir "fly-desk-cache.sqlite"
    "FLY_DESK_LOCATION_SUGGESTION_DB_PATH" = Join-Path $outputCacheDir "location-suggestion-cache.sqlite"
    "FLY_DESK_EXECUTABLE_PATH" = $ExecutablePath
  }
}

function Start-ProcessWithEnvironment {
  param(
    [string]$FilePath,
    [string[]]$ArgumentList,
    [string]$WorkingDirectory,
    [hashtable]$Environment
  )

  $previous = @{}
  foreach ($key in $Environment.Keys) {
    $previous[$key] = [Environment]::GetEnvironmentVariable($key, "Process")
    [Environment]::SetEnvironmentVariable($key, [string]$Environment[$key], "Process")
  }

  try {
    $parameters = @{
      FilePath = $FilePath
      WorkingDirectory = $WorkingDirectory
      PassThru = $true
      WindowStyle = "Hidden"
      RedirectStandardOutput = $script:ServerOutLog
      RedirectStandardError = $script:ServerErrLog
    }

    if ($ArgumentList -and $ArgumentList.Count -gt 0) {
      $parameters["ArgumentList"] = $ArgumentList
    }

    return Start-Process @parameters
  } finally {
    foreach ($key in $Environment.Keys) {
      [Environment]::SetEnvironmentVariable($key, $previous[$key], "Process")
    }
  }
}

function Test-HealthEndpoint {
  param([int]$Port)

  $client = $null
  try {
    $handler = [System.Net.Http.HttpClientHandler]::new()
    $client = [System.Net.Http.HttpClient]::new($handler)
    $client.Timeout = [TimeSpan]::FromSeconds(2)
    $response = $client.GetAsync("http://127.0.0.1:$Port/api/health").GetAwaiter().GetResult()
    return [int]$response.StatusCode -eq 200
  } catch {
    return $false
  } finally {
    if ($client) {
      $client.Dispose()
    }
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
    Write-LauncherLog "Stopped PID $ProcessId."
  } catch {
    Write-LauncherLog "Could not stop PID ${ProcessId}: $($_.Exception.Message)"
  }
}

function Get-State {
  if (-not (Test-Path -LiteralPath $script:StateFile)) {
    return $null
  }

  try {
    return Get-Content -LiteralPath $script:StateFile -Raw | ConvertFrom-Json
  } catch {
    Write-LauncherLog "state.json was invalid and will be ignored."
    return $null
  }
}

function Save-State {
  param(
    [int]$Port,
    [int]$ProcessId,
    [string]$Mode,
    [string]$Version = "",
    [string]$ReleaseDir = "",
    [string]$StdOutLog = "",
    [string]$StdErrLog = ""
  )

  Ensure-RuntimeDir
  [pscustomobject]@{
    port = $Port
    pid = $ProcessId
    mode = $Mode
    version = $Version
    releaseDir = $ReleaseDir
    stdoutLog = $StdOutLog
    stderrLog = $StdErrLog
    updatedAt = (Get-Date).ToString("o")
  } | ConvertTo-Json | Set-Content -LiteralPath $script:StateFile -Encoding UTF8
}

function Clear-State {
  if (Test-Path -LiteralPath $script:StateFile) {
    Remove-Item -LiteralPath $script:StateFile -Force -ErrorAction SilentlyContinue
  }
}

function Test-ProcessAlive {
  param([int]$ProcessId)

  try {
    $null = Get-Process -Id $ProcessId -ErrorAction Stop
    return $true
  } catch {
    return $false
  }
}

function Test-StateMatchesTarget {
  param(
    $State,
    [string]$Mode,
    $Release
  )

  if (-not $State) {
    return $false
  }

  if ([string]$State.mode -ne $Mode) {
    return $false
  }

  if ($Mode -eq "release") {
    return [string]$State.version -eq [string]$Release.version `
      -and [string]$State.releaseDir -eq [string]$Release.releaseDir
  }

  return $true
}

function Open-AppInBrowser {
  param([int]$Port)

  $url = "http://127.0.0.1:$Port/"

  if ($script:SkipBrowser) {
    Write-LauncherLog "Browser open skipped by FLY_DESK_SKIP_BROWSER at $url"
    return
  }

  try {
    Start-Process -FilePath "cmd.exe" -ArgumentList @("/c", "start", "", $url) -WindowStyle Hidden | Out-Null
    Write-LauncherLog "Opened default browser at $url"
  } catch {
    Show-Popup "Fly Desk se inicio correctamente, pero no se pudo abrir el navegador.`n`nAbre manualmente:`n$url" 48
  }
}

function Wait-ForServer {
  param(
    [int]$Port,
    [int]$ProcessId
  )

  $deadline = (Get-Date).AddSeconds(120)
  while ((Get-Date) -lt $deadline) {
    if ($script:ServerOutLog -and (Test-Path -LiteralPath $script:ServerOutLog)) {
      $stdout = Get-Content -LiteralPath $script:ServerOutLog -Raw -ErrorAction SilentlyContinue
      if ($stdout -match "Fly Desk running at http://(?:localhost|127\.0\.0\.1):$Port\b") {
        return $true
      }
    }

    if (Test-HealthEndpoint -Port $Port) {
      return $true
    }

    if ($ProcessId -gt 0 -and -not (Test-ProcessAlive -ProcessId $ProcessId)) {
      return $false
    }

    Start-Sleep -Milliseconds 750
  }

  return $false
}

function Invoke-UpdaterIfAvailable {
  if (Test-EnabledFlag -Value $env:FLY_DESK_SKIP_SELF_UPDATE) {
    Write-LauncherLog "Self-update skipped by FLY_DESK_SKIP_SELF_UPDATE."
    return
  }

  $updateScript = Join-Path $script:ProjectRoot "tools\update-fly-desk.ps1"
  if (-not (Test-Path -LiteralPath $updateScript)) {
    return
  }

  try {
    Write-LauncherLog "Running local update bootstrap."
    & $updateScript
  } catch {
    Write-LauncherLog "Update bootstrap failed; keeping current local release. $($_.Exception.Message)"
  }
}

function Start-ReleaseServerProcess {
  param(
    $Release,
    [int]$Port
  )

  $envMap = New-ReleaseEnvironment -ReleaseDir $Release.releaseDir -Port $Port -ExecutablePath $Release.executablePath
  $process = Start-ProcessWithEnvironment `
    -FilePath $Release.executablePath `
    -ArgumentList @() `
    -WorkingDirectory $script:ProjectRoot `
    -Environment $envMap

  Write-LauncherLog "Release $($Release.version) started with PID $($process.Id) on port $Port."
  return $process.Id
}

function Start-DevServerProcess {
  param(
    [string]$BunPath,
    [int]$Port
  )

  $envMap = @{
    "PORT" = "$Port"
    "BUN_EXECUTABLE_PATH" = $BunPath
  }
  $process = Start-ProcessWithEnvironment `
    -FilePath $BunPath `
    -ArgumentList @("run", "start") `
    -WorkingDirectory $script:ProjectRoot `
    -Environment $envMap

  Write-LauncherLog "Development server started with PID $($process.Id) on port $Port."
  return $process.Id
}

function Stop-PortOccupants {
  param([int]$Port)

  foreach ($processId in @(Get-ListeningProcessIdsForPort -Port $Port)) {
    Write-LauncherLog "Stopping process on launcher port $Port (PID $processId)."
    Stop-ProcessTree -ProcessId $processId
  }

  Start-Sleep -Milliseconds 800
}

function Invoke-FlyDeskLauncher {
  try {
    Ensure-RuntimeDir
    Write-LauncherLog "Launcher starting on fixed port $script:LauncherPort."
    Invoke-UpdaterIfAvailable
    Initialize-RunLogs
    Write-LauncherLog "Run logs: $script:ServerOutLog | $script:ServerErrLog"

    $mode = "dev"
    $release = $null
    $bunPath = ""
    if (Test-ReleaseModeAvailable) {
      $release = Get-ActiveRelease
      $mode = "release"
      Write-LauncherLog "Release mode selected: $($release.version) at $($release.releaseDir)."
    } else {
      $bunPath = Ensure-DependenciesAndBuild
      Write-LauncherLog "Development mode selected."
    }

    $state = Get-State
    $statePid = if ($state -and $state.pid) { [int]$state.pid } else { 0 }
    $hasHealthyPort = Test-HealthEndpoint -Port $script:LauncherPort

    if ($hasHealthyPort -and (Test-StateMatchesTarget -State $state -Mode $mode -Release $release)) {
      Write-LauncherLog "Reusing active Fly Desk instance on port $script:LauncherPort (PID $statePid)."
      Open-AppInBrowser -Port $script:LauncherPort
      return
    }

    if ($hasHealthyPort -or @(Get-ListeningProcessIdsForPort -Port $script:LauncherPort).Count -gt 0) {
      Stop-PortOccupants -Port $script:LauncherPort
    }

    if (@(Get-ListeningProcessIdsForPort -Port $script:LauncherPort).Count -gt 0) {
      Fail-Launcher "Fly Desk usa el puerto fijo $script:LauncherPort, pero sigue ocupado por otra aplicacion."
    }

    Clear-State
    $serverProcessId = if ($mode -eq "release") {
      Start-ReleaseServerProcess -Release $release -Port $script:LauncherPort
    } else {
      Start-DevServerProcess -BunPath $bunPath -Port $script:LauncherPort
    }

    Save-State `
      -Port $script:LauncherPort `
      -ProcessId $serverProcessId `
      -Mode $mode `
      -Version $(if ($release) { $release.version } else { "" }) `
      -ReleaseDir $(if ($release) { $release.releaseDir } else { "" }) `
      -StdOutLog $script:ServerOutLog `
      -StdErrLog $script:ServerErrLog

    if (-not (Wait-ForServer -Port $script:LauncherPort -ProcessId $serverProcessId)) {
      Stop-ProcessTree -ProcessId $serverProcessId
      Clear-State
      Fail-Launcher "Fly Desk no respondio correctamente en http://127.0.0.1:$script:LauncherPort/. Revisa:`n$script:ServerOutLog`n$script:ServerErrLog"
    }

    Save-State `
      -Port $script:LauncherPort `
      -ProcessId $serverProcessId `
      -Mode $mode `
      -Version $(if ($release) { $release.version } else { "" }) `
      -ReleaseDir $(if ($release) { $release.releaseDir } else { "" }) `
      -StdOutLog $script:ServerOutLog `
      -StdErrLog $script:ServerErrLog

    Open-AppInBrowser -Port $script:LauncherPort
    Write-LauncherLog "Launcher completed."
  } catch {
    $message = if ($_.Exception) { $_.Exception.Message } else { "$_" }
    Write-LauncherLog "Final failure: $message"
    exit 1
  }
}

if ($MyInvocation.InvocationName -ne "." -and -not (Test-EnabledFlag -Value $env:FLY_DESK_LAUNCHER_IMPORT_ONLY)) {
  Invoke-FlyDeskLauncher
}
