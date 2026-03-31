$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$script:AppName = "Fly Desk"
$script:ProjectRoot = Split-Path -Parent $PSScriptRoot
$script:RuntimeDir = Join-Path $script:ProjectRoot ".launcher"
$script:StateFile = Join-Path $script:RuntimeDir "state.json"
$script:LauncherLog = Join-Path $script:RuntimeDir "launcher.log"
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

$script:SkipBrowser = Test-EnabledFlag -Value $env:FLY_DESK_SKIP_BROWSER
$script:SilentMode = Test-EnabledFlag -Value $env:FLY_DESK_SILENT

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

function Get-NodePath {
  @(
    (Get-CommandPath "node.exe"),
    (Get-CommandPath "node")
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
}

function Get-NpmPath {
  @(
    (Get-CommandPath "npm.cmd"),
    (Get-CommandPath "npm")
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
}

function Assert-NodeReady {
  $nodePath = Get-NodePath
  if (-not $nodePath) {
    Fail-Launcher "No se encontro Node.js. Instala Node.js 20 o superior y vuelve a abrir Fly Desk."
  }

  $versionText = (& $nodePath -v).Trim()
  if (-not $versionText -or $versionText -notmatch "^v(?<major>\d+)") {
    Fail-Launcher "No se pudo leer correctamente la version de Node.js."
  }

  if ([int]$Matches["major"] -lt 20) {
    Fail-Launcher "Fly Desk necesita Node.js 20 o superior. Version detectada: $versionText"
  }

  return $nodePath
}

function Assert-NpmReady {
  $npmPath = Get-NpmPath
  if (-not $npmPath) {
    Fail-Launcher "No se encontro npm. Reinstala Node.js y vuelve a abrir Fly Desk."
  }

  return $npmPath
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
  $distEntry = Join-Path $script:ProjectRoot "dist\\index.js"
  if (-not (Test-Path -LiteralPath $distEntry)) {
    return $true
  }

  $distTime = (Get-Item -LiteralPath $distEntry).LastWriteTime
  $sourceTime = Get-LatestWriteTime -Paths @(
    (Join-Path $script:ProjectRoot "src"),
    (Join-Path $script:ProjectRoot "public"),
    (Join-Path $script:ProjectRoot "api")
  )

  $configFiles = @(
    (Join-Path $script:ProjectRoot "package.json"),
    (Join-Path $script:ProjectRoot "package-lock.json"),
    (Join-Path $script:ProjectRoot "tsconfig.json"),
    (Join-Path $script:ProjectRoot "tsconfig.build.json")
  ) | Where-Object { Test-Path -LiteralPath $_ }

  foreach ($configFile in $configFiles) {
    if ((Get-Item -LiteralPath $configFile).LastWriteTime -gt $distTime) {
      return $true
    }
  }

  return $sourceTime -gt $distTime
}

function Ensure-DependenciesAndBuild {
  $npmPath = Assert-NpmReady
  $nodeModules = Join-Path $script:ProjectRoot "node_modules"

  if (-not (Test-Path -LiteralPath $nodeModules)) {
    Invoke-LoggedProcess -FilePath $npmPath -ArgumentList @("install") -WorkingDirectory $script:ProjectRoot -StepName "npm install"
  }

  if (Test-BuildNeeded) {
    Invoke-LoggedProcess -FilePath $npmPath -ArgumentList @("run", "build") -WorkingDirectory $script:ProjectRoot -StepName "npm run build"
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
    $distEntry = Join-Path $script:ProjectRoot "dist\\index.js"
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId"
    if (-not $process) {
      return $false
    }

    $commandLine = [string]$process.CommandLine
    return $commandLine -like "*$distEntry*"
  } catch {
    return $false
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
    [string]$NodePath,
    [int]$Port
  )

  $distEntry = Join-Path $script:ProjectRoot "dist\\index.js"
  if (-not (Test-Path -LiteralPath $distEntry)) {
    Fail-Launcher "No existe dist\\index.js despues de compilar."
  }

  $previousPort = $env:PORT
  $env:PORT = "$Port"

  try {
    $process = Start-Process `
      -FilePath $NodePath `
      -ArgumentList @($distEntry) `
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
  }

  Write-LauncherLog "Servidor iniciado con PID $($process.Id) en puerto $Port."
  return $process.Id
}

try {
  Ensure-RuntimeDir
  Write-LauncherLog "Inicio del launcher en puerto fijo $script:LauncherPort."

  $state = Get-State
  if ($state) {
    $statePort = if ($state.port) { [int]$state.port } else { $script:LauncherPort }
    $statePid = if ($state.pid) { [int]$state.pid } else { 0 }
    $stateHealthy = Test-HealthEndpoint -Port $statePort
    $stateListening = Test-ProcessListeningOnPort -ProcessId $statePid -Port $statePort

    if ($stateHealthy -or $stateListening) {
      Write-LauncherLog "Instancia existente reutilizada en puerto $statePort (health=$stateHealthy, listening=$stateListening, pid=$statePid)."
      if ($statePid -gt 0) {
        Save-State -Port $statePort -ProcessId $statePid -StdOutLog ([string]$state.stdoutLog) -StdErrLog ([string]$state.stderrLog)
      }
      Open-AppInBrowser -Port $statePort
      exit 0
    }
  }

  if (Test-HealthEndpoint -Port $script:LauncherPort) {
    Write-LauncherLog "Se detecto una instancia saludable en el puerto del launcher."
    Save-State -Port $script:LauncherPort -ProcessId 0
    Open-AppInBrowser -Port $script:LauncherPort
    exit 0
  }

  if ($state -and $state.pid -and (Test-ProcessAlive -ProcessId ([int]$state.pid))) {
    Stop-ProcessTree -ProcessId ([int]$state.pid)
    Start-Sleep -Milliseconds 800
  }

  $occupyingPids = @(Get-ListeningProcessIdsForPort -Port $script:LauncherPort)
  if ($occupyingPids.Count -gt 0) {
    $knownStatePid = if ($state -and $state.pid) { [int]$state.pid } else { 0 }
    $foreignPids = @($occupyingPids | Where-Object { $_ -ne $knownStatePid })

    foreach ($processId in @($foreignPids | Where-Object { Test-FlyDeskServerProcess -ProcessId $_ })) {
      Write-LauncherLog "Se encontro un Fly Desk huerfano en PID $processId y sera detenido antes de relanzar."
      Stop-ProcessTree -ProcessId $processId
      Start-Sleep -Milliseconds 800
    }

    $occupyingPids = @(Get-ListeningProcessIdsForPort -Port $script:LauncherPort)
    $foreignPids = @($occupyingPids | Where-Object { $_ -ne $knownStatePid })
    if ($foreignPids.Count -gt 0) {
      Fail-Launcher "Fly Desk usa el puerto fijo $script:LauncherPort para el acceso directo, pero esta ocupado por otra aplicacion. Cierra esa aplicacion o libera el puerto y vuelve a intentar."
    }
  }

  Initialize-RunLogs
  Write-LauncherLog "Logs de esta ejecucion: $script:ServerOutLog | $script:ServerErrLog"

  $nodePath = Assert-NodeReady
  Ensure-DependenciesAndBuild
  Clear-State

  $serverProcessId = Start-ServerProcess -NodePath $nodePath -Port $script:LauncherPort
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
