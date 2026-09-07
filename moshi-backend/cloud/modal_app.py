"""
Modal deployment for Moshi realtime voice server.

Usage:
    modal token new
    modal deploy cloud/modal_app.py

Environment:
    MODAL_GPU=A10G (default) | L4 | L40S | A100
"""
import os
import modal

app = modal.App("moshi-local-realtime")

image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install(
        "moshi==0.2.13",
        "torch==2.5.1",
        "fastapi",
        "uvicorn[standard]",
        "websockets",
        "pyyaml",
        "numpy",
    )
    .add_local_python_source("server", "moshi_engine", "monitoring")
)

GPU_CONFIG = os.environ.get("MODAL_GPU", "A10G")


@app.function(
    image=image,
    gpu=GPU_CONFIG,
    scaledown_window=300,  # 5分warm pool維持
    timeout=3600,
    max_containers=10,
)
@modal.asgi_app()
def serve():
    from server.factory import create_app
    return create_app()
