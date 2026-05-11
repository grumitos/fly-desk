$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$script:AppName = "Fly Desk"
$script:ProjectRoot = Split-Path -Parent $PSScriptRoot
$script:RuntimeDir = Join-Path $script:ProjectRoot ".launcher"
$script:StateFile = Join-Path $script:RuntimeDir "state.json"
$script:GitUpdateStateFile = Join-Path $script:RuntimeDir "git-update-state.json"
$script:LauncherLog = Join-Path $script:RuntimeDir "launcher.log"
$script:LauncherPort = if ($env:FLY_DESK_LAUNCHER_PORT) { [int]$env:FLY_DESK_LAUNCHER_PORT } else { 32123 }
$script:ServerOutLog = ""
$script:ServerErrLog = ""
$script:SkipBrowser = $false
$script:SilentMode = $false
$script:SkipGitUpdate = $false
$script:GitRemoteCheckTtlSeconds = 300
$script:GitRemoteCheckTimeoutSeconds = 3
$script:GitPullTimeoutSeconds = 90

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
$script:SkipGitUpdate = Test-EnabledFlag -Value $env:FLY_DESK_SKIP_GIT_UPDATE
$script:GitRemoteCheckTtlSeconds = Read-NonNegativeIntEnv -Name "FLY_DESK_GIT_CHECK_TTL_SECONDS" -Fallback 300
$script:GitRemoteCheckTimeoutSeconds = Read-NonNegativeIntEnv -Name "FLY_DESK_GIT_CHECK_TIMEOUT_SECONDS" -Fallback 3
$script:GitPullTimeoutSeconds = Read-NonNegativeIntEnv -Name "FLY_DESK_GIT_PULL_TIMEOUT_SECONDS" -Fallback 90

function Ensure-RuntimeDir {
  if (-not (Test-Path -LiteralPath $script:RuntimeDir)) {
    New-Item -ItemType Directory -Path $script:RuntimeDir | Out-Null
  }
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
    Write-LauncherLog "Popup omitido por modo silencioso: $Message"
    return
  }

  try {
    $shell = New-Object -ComObject WScript.Shell
    [void]$shell.Popup($Message, 0, $script:AppName, $Icon)
  } catch {
    Write-LauncherLog "No se pudo abrir popup: $($_.Exception.Message)"
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
  $script:ServerOutLog = Join-Path $script:RuntimeDir "server-$stamp.out.log"
  $script:ServerErrLog = Join-Path $script:RuntimeDir "server-$stamp.err.log"
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

function Get-GitPath {
  @(
    (Get-CommandPath "git.exe"),
    (Get-CommandPath "git")
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
}

function Assert-BunReady {
  $bunPath = Get-BunPath
  if (-not $bunPath) {
    Fail-Launcher "No se encontro Bun. Instala Bun y vuelve a abrir Fly Desk."
  }

  $versionText = (& $bunPath --version).Trim()
  if (-not $versionText) {
    Fail-Launcher "No se pudo leer correctamente la version de Bun."
  }

  Write-LauncherLog "Bun detectado: $versionText ($bunPath)"
  return $bunPath
}

function Invoke-LoggedProcess {
  param(
    [string]$FilePath,
    [string[]]$ArgumentList,
    [string]$WorkingDirectory,
    [string]$StepName
  )

  Write-LauncherLog "${StepName}: iniciando $FilePath $($ArgumentList -join ' ')"
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

function Invoke-GitCommand {
  param(
    [string]$GitPath,
    [string[]]$ArgumentList,
    [int]$TimeoutSeconds
  )

  Ensure-RuntimeDir
  $safeTimeoutSeconds = [Math]::Max(1, $TimeoutSeconds)
  $stamp = "{0}-{1}" -f (Get-Date -Format "yyyyMMdd-HHmmssfff"), ([Guid]::NewGuid().ToString("N"))
  $stdoutPath = Join-Path $script:RuntimeDir "git-$stamp.out.log"
  $stderrPath = Join-Path $script:RuntimeDir "git-$stamp.err.log"
  $timedOut = $false
  $exitCode = 1

  try {
    $process = Start-Process `
      -FilePath $GitPath `
      -ArgumentList $ArgumentList `
      -WorkingDirectory $script:ProjectRoot `
      -PassThru `
      -WindowStyle Hidden `
      -RedirectStandardOutput $stdoutPath `
      -RedirectStandardError $stderrPath

    if (-not $process.WaitForExit($safeTimeoutSeconds * 1000)) {
      $timedOut = $true
      Stop-ProcessTree -ProcessId $process.Id
    } else {
      $exitCode = $process.ExitCode
    }
  } catch {
    $exitCode = 1
    Set-Content -LiteralPath $stderrPath -Value $_.Exception.Message -Encoding UTF8
  }

  $stdout = if (Test-Path -LiteralPath $stdoutPath) { Get-Content -LiteralPath $stdoutPath -Raw -ErrorAction SilentlyContinue } else { "" }
  $stderr = if (Test-Path -LiteralPath $stderrPath) { Get-Content -LiteralPath $stderrPath -Raw -ErrorAction SilentlyContinue } else { "" }
  Remove-Item -LiteralPath $stdoutPath, $stderrPath -Force -ErrorAction SilentlyContinue

  return [pscustomobject]@{
    ExitCode = $exitCode
    StdOut = [string]$stdout
    StdErr = [string]$stderr
    TimedOut = $timedOut
  }
}

function Get-GitUpdateState {
  if (-not (Test-Path -LiteralPath $script:GitUpdateStateFile)) {
    return $null
  }

  try {
    return Get-Content -LiteralPath $script:GitUpdateStateFile -Raw | ConvertFrom-Json
  } catch {
    Write-LauncherLog "git-update-state.json estaba dañado y sera regenerado."
    return $null
  }
}

function Save-GitUpdateState {
  param(
    [string]$LocalHead,
    [string]$RemoteHead,
    [string]$RemoteName,
    [string]$RemoteRef
  )

  Ensure-RuntimeDir
  [pscustomobject]@{
    localHead = $LocalHead
    remoteHead = $RemoteHead
    remoteName = $RemoteName
    remoteRef = $RemoteRef
    checkedAt = (Get-Date).ToString("o")
  } | ConvertTo-Json | Set-Content -LiteralPath $script:GitUpdateStateFile -Encoding UTF8
}

function Test-RecentGitRemoteMatch {
  param(
    [string]$LocalHead,
    [string]$RemoteName,
    [string]$RemoteRef
  )

  if ($script:GitRemoteCheckTtlSeconds -le 0) {
    return $false
  }

  $state = Get-GitUpdateState
  if (-not $state) {
    return $false
  }

  if ([string]$state.localHead -ne $LocalHead `
    -or [string]$state.remoteHead -ne $LocalHead `
    -or [string]$state.remoteName -ne $RemoteName `
    -or [string]$state.remoteRef -ne $RemoteRef) {
    return $false
  }

  try {
    $checkedAt = [DateTime]::Parse([string]$state.checkedAt)
    return ((Get-Date) - $checkedAt).TotalSeconds -lt $script:GitRemoteCheckTtlSeconds
  } catch {
    return $false
  }
}

function Ensure-ProjectUpdated {
  if ($script:SkipGitUpdate) {
    Write-LauncherLog "Git update omitido por FLY_DESK_SKIP_GIT_UPDATE."
    return
  }

  $gitPath = Get-GitPath
  if (-not $gitPath) {
    Write-LauncherLog "Git no esta disponible; se omite actualizacion del proyecto."
    return
  }

  $repoCheck = Invoke-GitCommand -GitPath $gitPath -ArgumentList @("rev-parse", "--is-inside-work-tree") -TimeoutSeconds 5
  if ($repoCheck.TimedOut -or $repoCheck.ExitCode -ne 0 -or $repoCheck.StdOut.Trim() -ne "true") {
    Write-LauncherLog "No se pudo confirmar repositorio Git; se omite actualizacion."
    return
  }

  $branchResult = Invoke-GitCommand -GitPath $gitPath -ArgumentList @("rev-parse", "--abbrev-ref", "HEAD") -TimeoutSeconds 5
  $branch = $branchResult.StdOut.Trim()
  if ($branchResult.TimedOut -or $branchResult.ExitCode -ne 0 -or -not $branch -or $branch -eq "HEAD") {
    Write-LauncherLog "Git update omitido: HEAD sin rama local rastreable."
    return
  }

  $remoteResult = Invoke-GitCommand -GitPath $gitPath -ArgumentList @("config", "--get", "branch.$branch.remote") -TimeoutSeconds 5
  $mergeResult = Invoke-GitCommand -GitPath $gitPath -ArgumentList @("config", "--get", "branch.$branch.merge") -TimeoutSeconds 5
  $remoteName = $remoteResult.StdOut.Trim()
  $remoteRef = $mergeResult.StdOut.Trim()
  if ($remoteResult.TimedOut -or $mergeResult.TimedOut `
    -or $remoteResult.ExitCode -ne 0 -or $mergeResult.ExitCode -ne 0 `
    -or -not $remoteName -or -not $remoteRef) {
    Write-LauncherLog "Git update omitido: la rama $branch no tiene upstream configurado."
    return
  }

  $headResult = Invoke-GitCommand -GitPath $gitPath -ArgumentList @("rev-parse", "HEAD") -TimeoutSeconds 5
  $localHead = $headResult.StdOut.Trim()
  if ($headResult.TimedOut -or $headResult.ExitCode -ne 0 -or -not $localHead) {
    Write-LauncherLog "Git update omitido: no se pudo leer HEAD local."
    return
  }

  if (Test-RecentGitRemoteMatch -LocalHead $localHead -RemoteName $remoteName -RemoteRef $remoteRef) {
    Write-LauncherLog "Git update omitido: remoto ya confirmado en el mismo commit dentro del TTL ($script:GitRemoteCheckTtlSeconds s)."
    return
  }

  $remoteCheck = Invoke-GitCommand -GitPath $gitPath -ArgumentList @("ls-remote", $remoteName, $remoteRef) -TimeoutSeconds $script:GitRemoteCheckTimeoutSeconds
  if ($remoteCheck.TimedOut) {
    Write-LauncherLog "Git update omitido: chequeo remoto excedio $script:GitRemoteCheckTimeoutSeconds s."
    return
  }

  if ($remoteCheck.ExitCode -ne 0) {
    Write-LauncherLog "Git update omitido: no se pudo consultar $remoteName/$remoteRef. $($remoteCheck.StdErr.Trim())"
    return
  }

  $remoteLine = @($remoteCheck.StdOut -split "`r?`n" | Where-Object { $_.Trim() } | Select-Object -First 1)
  $remoteHead = if ($remoteLine.Count -gt 0) { @($remoteLine[0] -split "\s+" | Where-Object { $_ })[0] } else { "" }
  if (-not $remoteHead) {
    Write-LauncherLog "Git update omitido: el remoto no devolvio commit para $remoteName/$remoteRef."
    return
  }

  Save-GitUpdateState -LocalHead $localHead -RemoteHead $remoteHead -RemoteName $remoteName -RemoteRef $remoteRef
  if ($remoteHead -eq $localHead) {
    Write-LauncherLog "Git update omitido: $branch ya esta en el mismo commit que $remoteName/$remoteRef ($localHead)."
    return
  }

  $statusResult = Invoke-GitCommand -GitPath $gitPath -ArgumentList @("status", "--porcelain") -TimeoutSeconds 5
  if ($statusResult.TimedOut -or $statusResult.ExitCode -ne 0) {
    Write-LauncherLog "Git update omitido: no se pudo comprobar si hay cambios locales."
    return
  }

  if ($statusResult.StdOut.Trim().Length -gt 0) {
    Write-LauncherLog "Git update omitido: hay cambios locales sin commitear; no se ejecuta pull."
    return
  }

  $remoteBranch = $remoteRef -replace "^refs/heads/", ""
  Write-LauncherLog "Git update: remoto cambio de $localHead a $remoteHead; ejecutando pull --ff-only."
  $pullResult = Invoke-GitCommand -GitPath $gitPath -ArgumentList @("pull", "--ff-only", $remoteName, $remoteBranch) -TimeoutSeconds $script:GitPullTimeoutSeconds
  if ($pullResult.TimedOut) {
    Write-LauncherLog "Git update fallo: pull excedio $script:GitPullTimeoutSeconds s."
    return
  }

  if ($pullResult.ExitCode -ne 0) {
    Write-LauncherLog "Git update fallo: pull --ff-only no completo. $($pullResult.StdErr.Trim())"
    return
  }

  $newHeadResult = Invoke-GitCommand -GitPath $gitPath -ArgumentList @("rev-parse", "HEAD") -TimeoutSeconds 5
  $newHead = $newHeadResult.StdOut.Trim()
  if ($newHead) {
    Save-GitUpdateState -LocalHead $newHead -RemoteHead $newHead -RemoteName $remoteName -RemoteRef $remoteRef
    Write-LauncherLog "Git update completado: $branch quedo en $newHead."
  }
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
  $distEntry = Join-Path $script:ProjectRoot "frontend\\dist\\index.html"
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

function Ensure-DependenciesAndBuild {
  $bunPath = Assert-BunReady
  $nodeModules = Join-Path $script:ProjectRoot "node_modules"

  if (-not (Test-Path -LiteralPath $nodeModules)) {
    Invoke-LoggedProcess -FilePath $bunPath -ArgumentList @("install", "--frozen-lockfile") -WorkingDirectory $script:ProjectRoot -StepName "bun install --frozen-lockfile"
  }

  if (Test-BuildNeeded) {
    Invoke-LoggedProcess -FilePath $bunPath -ArgumentList @("run", "build") -WorkingDirectory $script:ProjectRoot -StepName "bun run build"
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

function Test-BunProcess {
  param([int]$ProcessId)

  if ($ProcessId -le 0) {
    return $false
  }

  try {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId"
    if (-not $process) {
      return $false
    }

    $processName = [string]$process.Name
    return $processName -eq "bun.exe" -or $processName -eq "bun"
  } catch {
    return $false
  }
}

function Test-FlyDeskUiEndpoint {
  param([int]$Port)

  $client = $null
  try {
    $handler = [System.Net.Http.HttpClientHandler]::new()
    $client = [System.Net.Http.HttpClient]::new($handler)
    $client.Timeout = [TimeSpan]::FromSeconds(2)
    $response = $client.GetAsync("http://127.0.0.1:$Port/").GetAwaiter().GetResult()
    if ([int]$response.StatusCode -ne 200) {
      return $false
    }

    $content = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
    return $content -like "*<title>Fly Desk</title>*"
  } catch {
    return $false
  } finally {
    if ($client) {
      $client.Dispose()
    }
  }
}

function Get-ListeningTcpRecords {
  $lines = & netstat -ano -p tcp 2>$null
  $records = @()

  foreach ($line in $lines) {
    $parts = @($line -split "\s+" | Where-Object { $_ })
    if ($parts.Length -lt 5) {
      continue
    }

    if ($parts[0] -ne "TCP" -or $parts[3] -ne "LISTENING") {
      continue
    }

    $portMatch = [regex]::Match($parts[1], ":(?<port>\d+)$")
    if (-not $portMatch.Success) {
      continue
    }

    $records += [pscustomobject]@{
      Port = [int]$portMatch.Groups["port"].Value
      ProcessId = [int]$parts[4]
    }
  }

  return $records
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

function Test-ProcessHostsFlyDeskUi {
  param([int]$ProcessId)

  if ($ProcessId -le 0) {
    return $false
  }

  foreach ($record in @(Get-ListeningTcpRecords | Where-Object { [int]$_.ProcessId -eq $ProcessId })) {
    if (Test-FlyDeskUiEndpoint -Port ([int]$record.Port)) {
      return $true
    }
  }

  return $false
}

function Stop-ProcessTree {
  param([int]$ProcessId)

  if ($ProcessId -le 0) {
    return
  }

  try {
    & taskkill /PID $ProcessId /T /F | Out-Null
    Write-LauncherLog "Se detuvo PID $ProcessId."
  } catch {
    Write-LauncherLog "No se pudo detener PID ${ProcessId}: $($_.Exception.Message)"
  }
}

function Get-State {
  if (-not (Test-Path -LiteralPath $script:StateFile)) {
    return $null
  }

  try {
    return Get-Content -LiteralPath $script:StateFile -Raw | ConvertFrom-Json
  } catch {
    Write-LauncherLog "state.json estaba dañado y sera regenerado."
    return $null
  }
}

function Save-State {
  param(
    [int]$Port,
    [int]$ProcessId,
    [string]$StdOutLog = "",
    [string]$StdErrLog = ""
  )

  Ensure-RuntimeDir
  [pscustomobject]@{
    port = $Port
    pid = $ProcessId
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

function Test-ProcessListeningOnPort {
  param(
    [int]$ProcessId,
    [int]$Port
  )

  if ($ProcessId -le 0) {
    return $false
  }

  return @((Get-ListeningProcessIdsForPort -Port $Port)) -contains $ProcessId
}

function Test-FlyDeskServerProcess {
  param([int]$ProcessId)

  if ($ProcessId -le 0) {
    return $false
  }

  try {
    $srcEntry = Join-Path $script:ProjectRoot "src\\index.ts"
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId"
    if (-not $process) {
      return $false
    }

    $commandLine = [string]$process.CommandLine
    $distEntry = Join-Path $script:ProjectRoot "dist\\index.js"

    if ((
        (Test-BunProcess -ProcessId $ProcessId) `
        -and (
          ($commandLine -like "*$srcEntry*") `
          -or ($commandLine -like "*src\\index.ts*") `
          -or ($commandLine -like "*src/index.ts*") `
          -or (
            $commandLine -like "*$script:ProjectRoot*" `
              -and $commandLine -like "*run*start*"
          )
        )
      ) `
      -or (
        $commandLine -like "*$distEntry*" `
          -or (
            $commandLine -like "*$script:ProjectRoot*" `
              -and ($commandLine -like "*dist\\index.js*" -or $commandLine -like "*dist/index.js*")
          )
      )) {
      return $true
    }

    return $false
  } catch {
    return $false
  }
}

function Get-FlyDeskServerProcessIds {
  $processes = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue
  if (-not $processes) {
    return @()
  }

  return @(
    $processes |
      Where-Object { Test-FlyDeskServerProcess -ProcessId ([int]$_.ProcessId) } |
      ForEach-Object { [int]$_.ProcessId } |
      Sort-Object -Unique
  )
}

function Get-FlyDeskEndpointProcessIds {
  $records = @(Get-ListeningTcpRecords)
  if ($records.Count -eq 0) {
    return @()
  }

  return @(
    $records |
      Where-Object { Test-FlyDeskServerProcess -ProcessId ([int]$_.ProcessId) } |
      Where-Object { Test-FlyDeskUiEndpoint -Port ([int]$_.Port) } |
      ForEach-Object { [int]$_.ProcessId } |
      Sort-Object -Unique
  )
}

function Stop-AllFlyDeskInstances {
  $processesToStop = @(
    @((Get-FlyDeskServerProcessIds) + (Get-FlyDeskEndpointProcessIds)) |
      Sort-Object -Unique
  )

  foreach ($processId in $processesToStop) {
    Write-LauncherLog "Se encontro una instancia previa de Fly Desk (PID $processId) y sera detenida antes de relanzar."
    Stop-ProcessTree -ProcessId $processId
  }

  if ($processesToStop.Count -gt 0) {
    Start-Sleep -Milliseconds 800
  }
}

function Get-ChromePath {
  @(
    "${env:LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe",
    "${env:PROGRAMFILES}\\Google\\Chrome\\Application\\chrome.exe",
    "${env:ProgramFiles(x86)}\\Google\\Chrome\\Application\\chrome.exe"
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
}

function Open-AppInBrowser {
  param([int]$Port)

  $url = "http://127.0.0.1:$Port/"

  if ($script:SkipBrowser) {
    Write-LauncherLog "Se omite apertura de navegador por FLY_DESK_SKIP_BROWSER en $url"
    return
  }

  $chromePath = Get-ChromePath

  if ($chromePath) {
    try {
      Start-Process -FilePath $chromePath -ArgumentList @("--new-window", $url) -WindowStyle Normal | Out-Null
      Write-LauncherLog "Se abrio Chrome en $url"
      return
    } catch {
      Write-LauncherLog "No se pudo abrir Chrome automaticamente: $($_.Exception.Message)"
    }
  }

  try {
    Start-Process -FilePath "cmd.exe" -ArgumentList @("/c", "start", "", $url) -WindowStyle Hidden | Out-Null
    Write-LauncherLog "Se abrio el navegador predeterminado en $url"
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

function Start-ServerProcess {
  param(
    [string]$BunPath,
    [int]$Port
  )

  $previousPort = $env:PORT
  $previousBunExecutablePath = $env:BUN_EXECUTABLE_PATH
  $env:PORT = "$Port"
  $env:BUN_EXECUTABLE_PATH = $BunPath

  try {
    $process = Start-Process `
      -FilePath $BunPath `
      -ArgumentList @("run", "start") `
      -WorkingDirectory $script:ProjectRoot `
      -PassThru `
      -WindowStyle Hidden `
      -RedirectStandardOutput $script:ServerOutLog `
      -RedirectStandardError $script:ServerErrLog
  } finally {
    if ($null -eq $previousPort) {
      Remove-Item Env:PORT -ErrorAction SilentlyContinue
    } else {
      $env:PORT = $previousPort
    }

    if ($null -eq $previousBunExecutablePath) {
      Remove-Item Env:BUN_EXECUTABLE_PATH -ErrorAction SilentlyContinue
    } else {
      $env:BUN_EXECUTABLE_PATH = $previousBunExecutablePath
    }
  }

  Write-LauncherLog "Servidor iniciado con PID $($process.Id) en puerto $Port."
  return $process.Id
}

try {
  Ensure-RuntimeDir
  Write-LauncherLog "Inicio del launcher en puerto fijo $script:LauncherPort."
  Ensure-ProjectUpdated

  $state = Get-State
  $statePid = if ($state -and $state.pid) { [int]$state.pid } else { 0 }
  $occupyingPids = @(Get-ListeningProcessIdsForPort -Port $script:LauncherPort)
  $flyDeskPidsOnLauncherPort = @($occupyingPids | Where-Object { Test-FlyDeskServerProcess -ProcessId $_ })
  $hasReusableInstance = $false

  if ($flyDeskPidsOnLauncherPort.Count -gt 0 -and (Test-HealthEndpoint -Port $script:LauncherPort)) {
    $hasReusableInstance = $true
    if ($statePid -le 0 -or -not ($flyDeskPidsOnLauncherPort -contains $statePid)) {
      $statePid = [int]$flyDeskPidsOnLauncherPort[0]
      Save-State -Port $script:LauncherPort -ProcessId $statePid
    }
  }

  if ($hasReusableInstance -and -not (Test-BuildNeeded)) {
    Write-LauncherLog "Se reutiliza la instancia activa de Fly Desk en puerto $script:LauncherPort (PID $statePid)."
    Open-AppInBrowser -Port $script:LauncherPort
    return
  }

  foreach ($processId in $flyDeskPidsOnLauncherPort) {
    Write-LauncherLog "Se detendra la instancia activa de Fly Desk en PID $processId para aplicar un relanzamiento limpio."
    Stop-ProcessTree -ProcessId $processId
  }

  if ($flyDeskPidsOnLauncherPort.Count -gt 0) {
    Start-Sleep -Milliseconds 800
  }

  Clear-State
  $occupyingPids = @(Get-ListeningProcessIdsForPort -Port $script:LauncherPort)
  if ($occupyingPids.Count -gt 0) {
    $foreignPids = @($occupyingPids | Where-Object { -not (Test-FlyDeskServerProcess -ProcessId $_) })

    if ($foreignPids.Count -gt 0) {
      Fail-Launcher "Fly Desk usa el puerto fijo $script:LauncherPort para el acceso directo, pero esta ocupado por otra aplicacion. Cierra esa aplicacion o libera el puerto y vuelve a intentar."
    }
  }

  Initialize-RunLogs
  Write-LauncherLog "Logs de esta ejecucion: $script:ServerOutLog | $script:ServerErrLog"

  $bunPath = Assert-BunReady
  Ensure-DependenciesAndBuild
  Clear-State

  $serverProcessId = Start-ServerProcess -BunPath $bunPath -Port $script:LauncherPort
  Save-State -Port $script:LauncherPort -ProcessId $serverProcessId -StdOutLog $script:ServerOutLog -StdErrLog $script:ServerErrLog
  if (-not (Wait-ForServer -Port $script:LauncherPort -ProcessId $serverProcessId)) {
    Stop-ProcessTree -ProcessId $serverProcessId
    Clear-State
    Fail-Launcher "Fly Desk no respondio correctamente en http://127.0.0.1:$script:LauncherPort/. Revisa:`n$script:ServerOutLog`n$script:ServerErrLog"
  }

  Save-State -Port $script:LauncherPort -ProcessId $serverProcessId -StdOutLog $script:ServerOutLog -StdErrLog $script:ServerErrLog
  Open-AppInBrowser -Port $script:LauncherPort
  Write-LauncherLog "Launcher completado correctamente."
} catch {
  $message = if ($_.Exception) { $_.Exception.Message } else { "$_" }
  Write-LauncherLog "Fallo final: $message"
  exit 1
}
