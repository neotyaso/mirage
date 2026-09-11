"""Gemini Live S2S 用 FastAPI factory。Moshi/Qwen とは別 App。GPU不要。"""
import datetime
import os
import time

from fastapi import FastAPI, WebSocket
from fastapi.responses import JSONResponse

from server.gemini_websocket import handle_gemini_websocket
from server.session import Session
from gemini_engine.gemini_live_engine import get_gemini_engine, GEMINI_MODEL, get_api_key


def create_gemini_app() -> FastAPI:
    app = FastAPI(title="Gemini Live S2S Backend")
    engine = get_gemini_engine()

    @app.on_event("startup")
    async def startup():
        print(f"[Gemini startup] ENGINE_BACKEND={os.environ.get('ENGINE_BACKEND', 'gemini')}")
        print(f"[Gemini startup] model={GEMINI_MODEL} key={'あり' if get_api_key() else 'なし(mock用)'}")
        try:
            engine.load()
        except Exception as e:
            print(f"[Gemini startup] load note: {e}")

    @app.get("/health")
    async def health():
        is_mock = type(engine).__name__ == "GeminiMockEngine"
        has_key = bool(get_api_key())
        loaded = is_mock or has_key
        return {
            "status": "ready" if loaded else "degraded",
            "vram_used_mb": 0,
            "vram_total_mb": 0,
            "backend": os.environ.get("ENGINE_BACKEND", "gemini"),
            "model": GEMINI_MODEL,
            "has_key": has_key,
        }

    @app.websocket("/ws")
    async def ws_endpoint(ws: WebSocket):
        await handle_gemini_websocket(
            ws, engine, lambda: Session(session_id=f"g_{int(time.time() * 1000)}")
        )

    @app.get("/api/gemini-token")
    async def gemini_token():
        """直結クライアント用 ephemeral token 発行 (AI Studio方式)。
        ブラウザは token で Google に直結。APIキー自体は渡らない。
        uses=1 (1セッションのみ)、接続30分・新規セッション5分有効。
        """
        from google import genai

        api_key = get_api_key()
        if not api_key:
            return JSONResponse(status_code=503, content={"error": "GEMINI_API_KEY 未設定"})
        try:
            client = genai.Client(api_key=api_key)
            now = datetime.datetime.now(datetime.timezone.utc)
            expire = now + datetime.timedelta(minutes=30)
            new_session = now + datetime.timedelta(minutes=5)
            token = client.auth_tokens.create(
                config={
                    "uses": 1,
                    "expire_time": expire,
                    "new_session_expire_time": new_session,
                }
            )
            name = getattr(token, "name", None) or token["name"]
            return {
                "token": name,
                "expireTime": expire.isoformat(),
                "newSessionExpireTime": new_session.isoformat(),
            }
        except Exception as e:
            print(f"[Gemini] token mint failed: {e}")
            return JSONResponse(status_code=502, content={"error": str(e)})

    return app
