$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$script:AppName = "Fly Desk"
$script:ProjectRoot = Split-Path -Parent $PSScriptRoot
$script:RuntimeDir = Join-Path $script:ProjectRoot ".launcher"
$script:StateFile = Join-Path $script:RuntimeDir "state.json"
$script:LauncherLog = Join-Path $script:RuntimeDir "launcher.log"
$script:ServerOutLog = ""
$script:ServerErrLog = ""

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

function Initialize-RunLogs {
  Ensure-RuntimeDir
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $script:ServerOutLog = Join-Path $script:RuntimeDir "server-$stamp.out.log"
  $script:ServerErrLog = Join-Path $script:RuntimeDir "server-$stamp.err.log"
  Set-Content -LiteralPath $script:ServerOutLog -Value "" -Encoding UTF8
  Set-Content -LiteralPath $script:ServerErrLog -Value "" -Encoding UTF8
}

function Show-ErrorPopup {
  param([string]$Message)

  try {
    $shell = New-Object -ComObject WScript.Shell
    [void]$shell.Popup($Message, 0, $script:AppName, 16)
  } catch {
    Write-LauncherLog "No se pudo abrir popup de error: $($_.Exception.Message)"
  }
}

function Fail-Launcher {
  param([string]$Message)

  Write-LauncherLog "ERROR: $Message"
  Show-ErrorPopup "$Message`n`nRevisa:`n${script:LauncherLog}"
  throw $Message
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
  $candidates = @(
    (Get-CommandPath "node.exe"),
    (Get-CommandPath "node")
  ) | Where-Object { $_ }

  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate) {
      return $candidate
    }
  }

  return $null
}

function Get-NpmPath {
  $candidates = @(
    (Get-CommandPath "npm.cmd"),
    (Get-CommandPath "npm")
  ) | Where-Object { $_ }

  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate) {
      return $candidate
    }
  }

  return $null
}

function Assert-NodeReady {
  $nodePath = Get-NodePath
  if (-not $nodePath) {
    Fail-Launcher "No se encontro Node.js. Instala Node.js 20 o superior y vuelve a ejecutar el acceso directo."
  }

  $versionText = (& $nodePath -v).Trim()
  if (-not $versionText) {
    Fail-Launcher "No se pudo leer la version de Node.js."
  }

  $major = 0
  if ($versionText -match "^v(?<major>\d+)") {
    $major = [int]$Matches["major"]
  }

  if ($major -lt 20) {
    Fail-Launcher "Este proyecto necesita Node.js 20 o superior. Version detectada: $versionText"
  }

  return $nodePath
}

function Assert-NpmReady {
  $npmPath = Get-NpmPath
  if (-not $npmPath) {
    Fail-Launcher "No se encontro npm. Reinstala Node.js y vuelve a ejecutar el acceso directo."
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
    Fail-Launcher "$StepName fallo con codigo $($process.ExitCode). Revisa:`n${script:ServerOutLog}`n${script:ServerErrLog}"
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
    $configTime = (Get-Item -LiteralPath $configFile).LastWriteTime
    if ($configTime -gt $distTime) {
      return $true
    }
  }

  return $sourceTime -gt $distTime
}

function Ensure-DependenciesAndBuild {
  $npmPath = Assert-NpmReady
  $nodeModules = Join-Path $script:ProjectRoot "node_modules"

  if (-not (Test-Path -LiteralPath $nodeModules)) {
    Write-LauncherLog "No existe node_modules. Ejecutando npm install."
    Invoke-LoggedProcess -FilePath $npmPath -ArgumentList @("install") -WorkingDirectory $script:ProjectRoot -StepName "npm install"
  }

  if (Test-BuildNeeded) {
    Write-LauncherLog "La carpeta dist esta ausente o desactualizada. Ejecutando npm run build."
    Invoke-LoggedProcess -FilePath $npmPath -ArgumentList @("run", "build") -WorkingDirectory $script:ProjectRoot -StepName "npm run build"
  }
}

function Test-PortAvailable {
  param([int]$Port)

  $listener4 = $null
  $listener6 = $null
  try {
    $listener4 = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
    $listener4.Start()
    $listener6 = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::IPv6Loopback, $Port)
    $listener6.Server.DualMode = $false
    $listener6.Start()
    return $true
  } catch {
    return $false
  } finally {
    if ($listener4) {
      $listener4.Stop()
    }
    if ($listener6) {
      $listener6.Stop()
    }
  }
}

function Get-FreePort {
  $preferredPorts = 3000..3010
  foreach ($port in $preferredPorts) {
    if (Test-PortAvailable -Port $port) {
      return $port
    }
  }

  Fail-Launcher "No se encontro un puerto libre entre 3000 y 3010."
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

function Stop-ProcessesUsingPort {
  param([int]$Port)

  $processIds = Get-ListeningProcessIdsForPort -Port $Port
  foreach ($processId in $processIds) {
    if ($processId -le 0) {
      continue
    }

    try {
      $process = Get-Process -Id $processId -ErrorAction Stop
      Write-LauncherLog "Liberando puerto $Port al detener PID $processId ($($process.ProcessName))."
      Stop-Process -Id $processId -Force -ErrorAction Stop
    } catch {
      Write-LauncherLog "No se pudo detener el PID $processId en puerto ${Port}: $($_.Exception.Message)"
    }
  }

  Start-Sleep -Milliseconds 800
}

function Release-BlockedPorts {
  foreach ($port in 3000..3010) {
    if (Test-PortAvailable -Port $port) {
      continue
    }

    if (Test-HealthEndpoint -Port $port) {
      continue
    }

    Stop-ProcessesUsingPort -Port $port
  }
}

function Find-HealthyPort {
  foreach ($port in 3000..3010) {
    if (Test-HealthEndpoint -Port $port) {
      return $port
    }
  }

  return $null
}

function Test-HealthEndpoint {
  param([int]$Port)

  $urls = @(
    "http://localhost:$Port/api/health",
    "http://127.0.0.1:$Port/api/health",
    "http://[::1]:$Port/api/health"
  )

  foreach ($url in $urls) {
    $client = $null
    try {
      $handler = [System.Net.Http.HttpClientHandler]::new()
      $client = [System.Net.Http.HttpClient]::new($handler)
      $client.Timeout = [TimeSpan]::FromSeconds(2)
      $response = $client.GetAsync($url).GetAwaiter().GetResult()
      if ([int]$response.StatusCode -eq 200) {
        return $true
      }
    } catch {
    } finally {
      if ($client) {
        $client.Dispose()
      }
    }
  }

  return $false
}

function Get-State {
  if (-not (Test-Path -LiteralPath $script:StateFile)) {
    return $null
  }

  try {
    return Get-Content -LiteralPath $script:StateFile -Raw | ConvertFrom-Json
  } catch {
    Write-LauncherLog "No se pudo leer state.json. Se regenerara."
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
  $state = [pscustomobject]@{
    port = $Port
    pid = $ProcessId
    stdoutLog = $StdOutLog
    stderrLog = $StdErrLog
    updatedAt = (Get-Date).ToString("o")
  }

  $state | ConvertTo-Json | Set-Content -LiteralPath $script:StateFile -Encoding UTF8
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

function Get-ChromePath {
  $candidates = @(
    "${env:LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe",
    "${env:PROGRAMFILES}\\Google\\Chrome\\Application\\chrome.exe",
    "${env:ProgramFiles(x86)}\\Google\\Chrome\\Application\\chrome.exe"
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1

  if ($candidates) {
    return $candidates
  }

  return $null
}

function Open-AppInBrowser {
  param([int]$Port)

  $url = "http://localhost:$Port/"
  $chromePath = Get-ChromePath

  if ($chromePath) {
    try {
      Start-Process -FilePath $chromePath -ArgumentList @("--new-tab", $url) -WindowStyle Normal | Out-Null
      Write-LauncherLog "Se abrio Chrome en $url"
      return
    } catch {
      Write-LauncherLog "Chrome detectado pero no se pudo abrir: $($_.Exception.Message)"
    }
  }

  try {
    Start-Process -FilePath "cmd.exe" -ArgumentList @("/c", "start", "", $url) -WindowStyle Hidden | Out-Null
    Write-LauncherLog "Chrome no encontrado. Se abrio el navegador predeterminado en $url"
    return
  } catch {
    Write-LauncherLog "No se pudo abrir ningun navegador automaticamente: $($_.Exception.Message)"
    Show-ErrorPopup "Fly Desk se inicio correctamente, pero no se pudo abrir el navegador.`n`nAbre manualmente:`n$url"
  }
}

function Wait-ForServer {
  param(
    [int]$Port,
    [int]$ProcessId
  )

  $deadline = (Get-Date).AddSeconds(45)
  while ((Get-Date) -lt $deadline) {
    if (Test-HealthEndpoint -Port $Port) {
      return $true
    }

    if (-not (Test-ProcessAlive -ProcessId $ProcessId)) {
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

  if (Test-HealthEndpoint -Port $Port) {
    Write-LauncherLog "Ya existe un servicio saludable en el puerto $Port. Se reutilizara."
    return 0
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

  Write-LauncherLog "Proceso iniciado con PID $($process.Id) en puerto $Port"
  return $process.Id
}

try {
  Ensure-RuntimeDir
  Write-LauncherLog "Inicio de launcher."

  $state = Get-State
  if ($state -and $state.port -and (Test-HealthEndpoint -Port ([int]$state.port))) {
    Write-LauncherLog "Instancia existente detectada en puerto $($state.port)."
    Open-AppInBrowser -Port ([int]$state.port)
    exit 0
  }

  $healthyPort = Find-HealthyPort
  if ($healthyPort) {
    Write-LauncherLog "Instancia saludable encontrada por escaneo en puerto $healthyPort."
    Save-State -Port $healthyPort -ProcessId 0
    Open-AppInBrowser -Port $healthyPort
    exit 0
  }

  Initialize-RunLogs
  Write-LauncherLog "Logs de esta ejecucion: $script:ServerOutLog | $script:ServerErrLog"

  $nodePath = Assert-NodeReady
  Ensure-DependenciesAndBuild

  if ($state -and $state.pid -and (Test-ProcessAlive -ProcessId ([int]$state.pid))) {
    Write-LauncherLog "Limpiando estado previo con PID $($state.pid) no saludable."
  }
  Clear-State

  Release-BlockedPorts

  $port = Get-FreePort
  $serverProcessId = Start-ServerProcess -NodePath $nodePath -Port $port

  if ($serverProcessId -eq 0) {
    Save-State -Port $port -ProcessId 0 -StdOutLog $script:ServerOutLog -StdErrLog $script:ServerErrLog
    Open-AppInBrowser -Port $port
    exit 0
  }

  if (-not (Wait-ForServer -Port $port -ProcessId $serverProcessId)) {
    Fail-Launcher "El servidor no respondio correctamente en http://localhost:$port/. Revisa:`n${script:ServerOutLog}`n${script:ServerErrLog}"
  }

  Save-State -Port $port -ProcessId $serverProcessId -StdOutLog $script:ServerOutLog -StdErrLog $script:ServerErrLog
  Open-AppInBrowser -Port $port
  Write-LauncherLog "Launcher completado correctamente."
} catch {
  $message = if ($_.Exception) { $_.Exception.Message } else { "$_" }
  Write-LauncherLog "Fallo final: $message"
  exit 1
}
