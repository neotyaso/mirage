<#
.SYNOPSIS
  One-shot startup script for the mirage exhibition runtime.
  Health-checks required services and starts uvicorn (moshi-backend)
  in the background when :8002 is down.
.DESCRIPTION
  Check order: vite(:5173) -> backend(:8002) -> AivisSpeech(:10101) -> Ollama(:11434).
  Prints missing services in color and returns success via exit code (0=all OK, 1=missing).
  -WhatIf prints the plan only and exits 0 (dry run).
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start-dev.ps1
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start-dev.ps1 -WhatIf
#>
param(
  [switch]$WhatIf,
  [int]$BackendWaitSec = 30,
  [int]$TimeoutSec = 4
)

$RepoRoot = Split-Path -Parent $PSScriptRoot
$BackendDir = Join-Path $RepoRoot "moshi-backend"

$SvcViteName = "vite (frontend)"
$SvcViteUrl = "http://localhost:5173/"
$SvcBackendName = "backend (:8002)"
$SvcBackendUrl = "http://localhost:8002/health"
$SvcAivisName = "AivisSpeech"
$SvcAivisUrl = "http://localhost:10101/speakers"
$SvcOllamaName = "Ollama"
$SvcOllamaUrl = "http://localhost:11434/api/tags"

if ($WhatIf) {
  Write-Host "[WhatIf] health checks in order:" -ForegroundColor Cyan
  Write-Host "[WhatIf]   vite -> http://localhost:5173/" -ForegroundColor Cyan
  Write-Host "[WhatIf]   backend -> http://localhost:8002/health" -ForegroundColor Cyan
  Write-Host "[WhatIf]   AivisSpeech -> http://localhost:10101/speakers" -ForegroundColor Cyan
  Write-Host "[WhatIf]   Ollama -> http://localhost:11434/api/tags" -ForegroundColor Cyan
  Write-Host "[WhatIf] if :8002 is down: start 'python -m uvicorn server.gemini_main:app --port 8002' in background" -ForegroundColor Cyan
  exit 0
}

function Test-Service {
  param([string]$Name, [string]$Url, [int]$Timeout)
  try {
    $res = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec $Timeout -ErrorAction Stop
    $code = $res.StatusCode
    if ($code -ge 200 -and $code -lt 400) {
      Write-Host "[ OK ] $Name $Url (HTTP $code)" -ForegroundColor Green
      return $true
    }
    Write-Host "[ NG ] $Name $Url (HTTP $code)" -ForegroundColor Red
    return $false
  } catch {
    Write-Host "[ NG ] $Name $Url" -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    return $false
  }
}

function Start-Backend {
  if (-not (Test-Path -LiteralPath $BackendDir)) {
    Write-Host "[ NG ] moshi-backend not found." -ForegroundColor Red
    Write-Host $BackendDir -ForegroundColor Red
    return $false
  }
  $python = Get-Command python -ErrorAction SilentlyContinue
  if (-not $python) {
    Write-Host "[ NG ] python not found. Check PATH." -ForegroundColor Red
    return $false
  }
  Write-Host "[ .. ] starting backend (:8002) in background..." -ForegroundColor Yellow
  try {
    Start-Process -FilePath "python" `
      -ArgumentList "-m", "uvicorn", "server.gemini_main:app", "--port", "8002" `
      -WorkingDirectory $BackendDir -WindowStyle Minimized -ErrorAction Stop | Out-Null
  } catch {
    Write-Host "[ NG ] failed to start uvicorn." -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    return $false
  }
  $deadline = (Get-Date).AddSeconds($BackendWaitSec)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 2
    try {
      $res = Invoke-WebRequest -Uri $SvcBackendUrl -UseBasicParsing -TimeoutSec $TimeoutSec -ErrorAction Stop
      if ($res.StatusCode -eq 200) {
        Write-Host "[ OK ] backend (:8002) is up." -ForegroundColor Green
        return $true
      }
    } catch {
      # still starting; keep waiting
    }
  }
  Write-Host "[ NG ] backend (:8002) did not respond." -ForegroundColor Red
  return $false
}

Write-Host "mirage startup check" -ForegroundColor Cyan
$failed = 0

# 1. vite
if (-not (Test-Service -Name $SvcViteName -Url $SvcViteUrl -Timeout $TimeoutSec)) {
  Write-Host "       -> start vite (:5173) with 'npm run dev'." -ForegroundColor Yellow
  $failed++
}

# 2. backend (:8002). auto-start when down
if (-not (Test-Service -Name $SvcBackendName -Url $SvcBackendUrl -Timeout $TimeoutSec)) {
  if (-not (Start-Backend)) {
    $failed++
  }
}

# 3. AivisSpeech
if (-not (Test-Service -Name $SvcAivisName -Url $SvcAivisUrl -Timeout $TimeoutSec)) {
  Write-Host "       -> start AivisSpeech (:10101)." -ForegroundColor Yellow
  $failed++
}

# 4. Ollama
if (-not (Test-Service -Name $SvcOllamaName -Url $SvcOllamaUrl -Timeout $TimeoutSec)) {
  Write-Host "       -> start Ollama (:11434) with 'ollama serve'." -ForegroundColor Yellow
  $failed++
}

if ($failed -gt 0) {
  Write-Host ""
  Write-Host "Some services are missing." -ForegroundColor Red
  exit 1
}
Write-Host ""
Write-Host "All services are up." -ForegroundColor Green
exit 0
