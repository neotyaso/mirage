#!/usr/bin/env bash
# Lightning AI Studio 内で実行する moshi-backend セットアップ
# Usage: bash scripts/setup_lightning.sh

set -e

echo "=== [1/3] Installing dependencies ==="
pip install --quiet \
    "moshi==0.2.13" \
    "torch==2.5.1" \
    "fastapi" \
    "uvicorn[standard]" \
    "websockets" \
    "sounddevice" \
    "numpy" \
    "pynvml" \
    "pyyaml" \
    "pytest" \
    "pytest-asyncio"

echo "=== [2/3] Pre-downloading Moshi model (HF cache) ==="
python -c "from huggingface_hub import snapshot_download; snapshot_download('kyutai/moshiko-pytorch-bf16')"

echo "=== [3/3] Verifying GPU ==="
python -c "import torch; print(f'CUDA available: {torch.cuda.is_available()}, device: {torch.cuda.get_device_name(0) if torch.cuda.is_available() else None}')"

echo "=== Setup complete ==="
echo "Next: lightning run server python -m server.main --host 0.0.0.0 --port 8000"