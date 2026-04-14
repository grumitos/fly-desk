param(
  [string]$EnvPath = (Join-Path (Split-Path -Parent $PSScriptRoot) ".env")
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Read-PlainOrDefault {
  param(
    [string]$Prompt,
    [string]$CurrentValue = ""
  )

  if ($CurrentValue) {
    $answer = Read-Host "$Prompt [$CurrentValue]"
    if ([string]::IsNullOrWhiteSpace($answer)) {
      return $CurrentValue
    }
    return $answer.Trim()
  }

  while ($true) {
    $answer = Read-Host $Prompt
    if (-not [string]::IsNullOrWhiteSpace($answer)) {
      return $answer.Trim()
    }
  }
}

function Read-OptionalSecret {
  param(
    [string]$Prompt
  )

  $secure = Read-Host -AsSecureString $Prompt
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  } finally {
    if ($bstr -ne [IntPtr]::Zero) {
      [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }
  }
}

function Parse-EnvFile {
  param(
    [string]$Path
  )

  $orderedKeys = [System.Collections.Generic.List[string]]::new()
  $values = [ordered]@{}

  if (Test-Path -LiteralPath $Path) {
    foreach ($line in Get-Content -LiteralPath $Path -Encoding UTF8) {
      if ($line -match '^\s*#' -or $line -notmatch '=') {
        continue
      }

      $parts = $line -split '=', 2
      $key = $parts[0].Trim()
      $value = $parts[1]
      if (-not $values.Contains($key)) {
        $orderedKeys.Add($key)
      }
      $values[$key] = $value
    }
  }

  return @{
    OrderedKeys = $orderedKeys
    Values = $values
  }
}

function Set-EnvValue {
  param(
    [System.Collections.Generic.List[string]]$OrderedKeys,
    [System.Collections.IDictionary]$Values,
    [string]$Key,
    [AllowNull()][string]$Value
  )

  if ($null -eq $Value) {
    if ($Values.Contains($Key)) {
      $Values.Remove($Key)
      [void]$OrderedKeys.Remove($Key)
    }
    return
  }

  if (-not $Values.Contains($Key)) {
    $OrderedKeys.Add($Key)
  }
  $Values[$Key] = $Value
}

function Save-EnvFile {
  param(
    [string]$Path,
    [System.Collections.Generic.List[string]]$OrderedKeys,
    [System.Collections.IDictionary]$Values
  )

  $lines = foreach ($key in $OrderedKeys) {
    if ($Values.Contains($key)) {
      "$key=$($Values[$key])"
    }
  }

  $content = if ($lines.Count -gt 0) {
    ($lines -join [Environment]::NewLine) + [Environment]::NewLine
  } else {
    ""
  }

  Set-Content -LiteralPath $Path -Value $content -Encoding UTF8
}

Write-Host ""
Write-Host "Configurar Costamar B2B" -ForegroundColor Cyan
Write-Host "Ingresa email, password y el secreto del autenticador." -ForegroundColor Gray
Write-Host "Para Auth puedes pegar Base32, otpauth://..., otpauth-migration://... o un JSON con totpUri (por ejemplo Proton Pass)." -ForegroundColor Gray
Write-Host "No pegues un codigo temporal." -ForegroundColor Gray
Write-Host "Si quieres borrar el secreto guardado, escribe solo '-' en ese campo." -ForegroundColor Gray
Write-Host ""

$envData = Parse-EnvFile -Path $EnvPath
$orderedKeys = $envData.OrderedKeys
$values = $envData.Values

$currentEmail = if ($values.Contains("COSTAMAR_B2B_EMAIL")) { [string]$values["COSTAMAR_B2B_EMAIL"] } else { "" }
$currentTotp = if ($values.Contains("COSTAMAR_B2B_TOTP_SECRET")) { [string]$values["COSTAMAR_B2B_TOTP_SECRET"] } else { "" }

$email = Read-PlainOrDefault -Prompt "Email Costamar B2B" -CurrentValue $currentEmail
$password = Read-OptionalSecret -Prompt "Password Costamar B2B (Enter para mantener actual si ya existe)"
$authSecret = Read-Host "Secreto Auth/TOTP, otpauth://, otpauth-migration:// o JSON con totpUri (Enter para mantener actual, '-' para borrar)"

Set-EnvValue -OrderedKeys $orderedKeys -Values $values -Key "COSTAMAR_B2B_EMAIL" -Value $email

if (-not [string]::IsNullOrEmpty($password)) {
  Set-EnvValue -OrderedKeys $orderedKeys -Values $values -Key "COSTAMAR_B2B_PASSWORD" -Value $password
} elseif (-not $values.Contains("COSTAMAR_B2B_PASSWORD")) {
  Write-Host "No habia password guardado; quedo pendiente." -ForegroundColor Yellow
}

if ($authSecret -eq "-") {
  Set-EnvValue -OrderedKeys $orderedKeys -Values $values -Key "COSTAMAR_B2B_TOTP_SECRET" -Value $null
} elseif (-not [string]::IsNullOrWhiteSpace($authSecret)) {
  Set-EnvValue -OrderedKeys $orderedKeys -Values $values -Key "COSTAMAR_B2B_TOTP_SECRET" -Value $authSecret.Trim()
} elseif (-not $values.Contains("COSTAMAR_B2B_TOTP_SECRET") -and $currentTotp) {
  Set-EnvValue -OrderedKeys $orderedKeys -Values $values -Key "COSTAMAR_B2B_TOTP_SECRET" -Value $currentTotp
}

Set-EnvValue -OrderedKeys $orderedKeys -Values $values -Key "COSTAMAR_B2B_USE_LIVE_BROWSER" -Value "0"
Set-EnvValue -OrderedKeys $orderedKeys -Values $values -Key "COSTAMAR_B2B_PROMPT_ENABLED" -Value "1"
Set-EnvValue -OrderedKeys $orderedKeys -Values $values -Key "COSTAMAR_CDP_TAB_SCAN_ENABLED" -Value "0"

Save-EnvFile -Path $EnvPath -OrderedKeys $orderedKeys -Values $values

Write-Host ""
Write-Host "Listo. Se actualizo $EnvPath" -ForegroundColor Green
Write-Host "Reinicia Fly Desk para que tome los nuevos valores." -ForegroundColor Green
Write-Host ""
Read-Host "Presiona Enter para cerrar"
