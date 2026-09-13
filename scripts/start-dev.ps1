<#
.SYNOPSIS
  mirage 展示ランタイムの一発起動スクリプト (Windows用ホットスタンバイ)。
.DESCRIPTION
  NOTE: 予備スクリプト (メインは npm run dev / scripts/dev.mjs)。
  Check order: vite(:5173) -> local STT(:8000, downなら裏で自動起動)
    -> backend(:8002, 廃止のため警告のみ)
    -> AivisSpeech(:10101, 警告のみ) -> Ollama(:11434, 警告のみ).
  フォールバック (STT) はホットスタンバイが前提のため、
  down時は裏プロセスで起動してヘルス応答まで待つ。
  backend/AivisSpeech/Ollama は自動起動せず警告のみ。
  -LaunchVite を付けると最後に vite をフォアグラウンド起動する
  (Ctrl+C で vite だけ止まる。裏の STT は残る)。
  終了コード: 0=起動可、1=必須サービス不足。
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start-dev.ps1
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start-dev.ps1 -LaunchVite
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start-dev.ps1 -WhatIf
#>
param(
  [switch]$WhatIf,
  [switch]$LaunchVite,
  [int]$SttWaitSec = 180,
  [int]$TimeoutSec = 4
)

$RepoRoot = Split-Path -Parent $PSScriptRoot

$SvcViteName = "vite (frontend)"
$SvcViteUrl = "http://localhost:5173/"
$SvcSttName = "local STT (:8000)"
$SvcSttUrl = "http://localhost:8000/health"
$SvcBackendName = "backend (:8002)"
$SvcBackendUrl = "http://localhost:8002/health"
$SvcAivisName = "AivisSpeech"
$SvcAivisUrl = "http://localhost:10101/speakers"
$SvcOllamaName = "Ollama"
$SvcOllamaUrl = "http://localhost:11434/api/tags"

if ($WhatIf) {
  Write-Host "[WhatIf] health checks in order:" -ForegroundColor Cyan
  Write-Host "[WhatIf]   vite -> http://localhost:5173/" -ForegroundColor Cyan
  Write-Host "[WhatIf]   local STT -> http://localhost:8000/health (downなら裏で 'python stt_server.py' を起動)" -ForegroundColor Cyan
  Write-Host "[WhatIf]   backend -> http://localhost:8002/health (廃止のため警告のみ)" -ForegroundColor Cyan
  Write-Host "[WhatIf]   AivisSpeech -> http://localhost:10101/speakers (警告のみ)" -ForegroundColor Cyan
  Write-Host "[WhatIf]   Ollama -> http://localhost:11434/api/tags (警告のみ)" -ForegroundColor Cyan
  if ($LaunchVite) {
    Write-Host "[WhatIf] 最後に 'npx vite' をフォアグラウンド起動" -ForegroundColor Cyan
  }
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

function Wait-HttpOk {
  param([string]$Url, [int]$Timeout, [datetime]$Deadline)
  while ((Get-Date) -lt $Deadline) {
    Start-Sleep -Seconds 2
    try {
      $res = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec $Timeout -ErrorAction Stop
      if ($res.StatusCode -ge 200 -and $res.StatusCode -lt 400) {
        return $true
      }
    } catch {
      # still starting; keep waiting
    }
  }
  return $false
}

function Start-SttServer {
  $sttScript = Join-Path $RepoRoot "stt_server.py"
  if (-not (Test-Path -LiteralPath $sttScript)) {
    Write-Host "[ NG ] stt_server.py not found." -ForegroundColor Red
    Write-Host $sttScript -ForegroundColor Red
    return $false
  }
  $python = Get-Command python -ErrorAction SilentlyContinue
  if (-not $python) {
    Write-Host "[ NG ] python not found. Check PATH." -ForegroundColor Red
    return $false
  }
  # このPCは CUDA の cublas 不足で cuda 起動が落ちるため、未指定時は cpu/int8 を既定にする
  if (-not $env:STT_DEVICE) { $env:STT_DEVICE = "cpu" }
  if (-not $env:STT_COMPUTE_TYPE) { $env:STT_COMPUTE_TYPE = "int8" }
  $model = if ($env:STT_MODEL) { $env:STT_MODEL } else { "small (default)" }
  $log = Join-Path $env:TEMP "mirage-stt.log"
  $errLog = Join-Path $env:TEMP "mirage-stt.err.log"
  Write-Host "[ .. ] starting local STT (:8000) in background... (model=$model device=$($env:STT_DEVICE)/$($env:STT_COMPUTE_TYPE))" -ForegroundColor Yellow
  Write-Host "       log: $log" -ForegroundColor Yellow
  try {
    Start-Process -FilePath "python" `
      -ArgumentList "stt_server.py" `
      -WorkingDirectory $RepoRoot -WindowStyle Minimized `
      -RedirectStandardOutput $log -RedirectStandardError $errLog `
      -ErrorAction Stop | Out-Null
  } catch {
    Write-Host "[ NG ] failed to start stt_server.py." -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    return $false
  }
  $deadline = (Get-Date).AddSeconds($SttWaitSec)
  if (Wait-HttpOk -Url $SvcSttUrl -Timeout $TimeoutSec -Deadline $deadline) {
    Write-Host "[ OK ] local STT (:8000) is up." -ForegroundColor Green
    return $true
  }
  Write-Host "[ NG ] local STT (:8000) did not respond. Check $log" -ForegroundColor Red
  return $false
}

Write-Host "mirage startup check" -ForegroundColor Cyan
$failed = 0
$hardFailed = 0

# 1. vite
$viteUp = Test-Service -Name $SvcViteName -Url $SvcViteUrl -Timeout $TimeoutSec
if (-not $viteUp -and -not $LaunchVite) {
  Write-Host "       -> start vite (:5173) with 'npm run dev'." -ForegroundColor Yellow
  $failed++
}

# 2. local STT (:8000). auto-start when down
if (-not (Test-Service -Name $SvcSttName -Url $SvcSttUrl -Timeout $TimeoutSec)) {
  if (-not (Start-SttServer)) {
    $failed++
    $hardFailed++
  }
}

# 3. backend (:8002). moshi-backend廃止のため警告のみ
if (-not (Test-Service -Name $SvcBackendName -Url $SvcBackendUrl -Timeout $TimeoutSec)) {
  Write-Host "       -> backend不要 (moshi-backend廃止)。無視してよい。" -ForegroundColor Yellow
}

# 4. AivisSpeech (warn only)
if (-not (Test-Service -Name $SvcAivisName -Url $SvcAivisUrl -Timeout $TimeoutSec)) {
  Write-Host "       -> start AivisSpeech (:10101)." -ForegroundColor Yellow
  $failed++
}

# 5. Ollama (warn only)
if (-not (Test-Service -Name $SvcOllamaName -Url $SvcOllamaUrl -Timeout $TimeoutSec)) {
  Write-Host "       -> start Ollama (:11434) with 'ollama serve'." -ForegroundColor Yellow
  $failed++
}

if ($LaunchVite) {
  if ($hardFailed -gt 0) {
    Write-Host ""
    Write-Host "必須サービス (STT/backend) が不足しているため vite を起動しません。" -ForegroundColor Red
    exit 1
  }
  if ($viteUp) {
    Write-Host ""
    Write-Host "vite は既に起動しています。終了します。" -ForegroundColor Green
    exit 0
  }
  Write-Host ""
  Write-Host "starting vite (:5173)..." -ForegroundColor Cyan
  & npx vite
  exit $LASTEXITCODE
}

if ($failed -gt 0) {
  Write-Host ""
  Write-Host "Some services are missing." -ForegroundColor Red
  exit 1
}
Write-Host ""
Write-Host "All services are up." -ForegroundColor Green
exit 0
