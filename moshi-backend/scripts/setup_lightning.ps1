$ErrorActionPreference = "Stop"

Write-Host "=== [1/2] Installing dependencies (Windows local) ===" -ForegroundColor Cyan
pip install --quiet moshi torch fastapi "uvicorn[standard]" websockets sounddevice numpy pynvml pyyaml pytest pytest-asyncio

Write-Host "=== [2/2] Mock mode test ===" -ForegroundColor Cyan
$env:ENGINE_BACKEND = "mock"
python -m server.main --host 127.0.0.1 --port 8000