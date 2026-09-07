import os
import time
from fastapi import FastAPI, WebSocket
from server.websocket import handle_websocket
from server.session import Session
from moshi_engine.engine import get_engine


def create_app() -> FastAPI:
    app = FastAPI(title="Moshi Local Realtime")
    engine = get_engine()

    @app.on_event("startup")
    async def startup():
        try:
            engine.load()
        except NotImplementedError as e:
            print(f"[Startup] Engine.load() skipped: {e}")
        vram = engine.get_vram_mb()
        print(f"[Startup] VRAM: {vram[0]}MB / {vram[1]}MB")

    @app.get("/health")
    async def health():
        vram = engine.get_vram_mb()
        return {
            "status": "ready",
            "vram_used_mb": vram[0],
            "vram_total_mb": vram[1],
            "backend": os.environ.get("ENGINE_BACKEND", "pytorch"),
        }

    @app.websocket("/ws")
    async def ws_endpoint(ws: WebSocket):
        await handle_websocket(ws, engine, lambda: Session(session_id=f"s_{int(time.time()*1000)}"))

    return app