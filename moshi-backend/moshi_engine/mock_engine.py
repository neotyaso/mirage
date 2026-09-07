"""モックエンジン — GPU不要"""
import asyncio
from moshi_engine.engine import MoshiEngineBase


class MockEngine(MoshiEngineBase):
    def load(self) -> None:
        print("[MockEngine] loaded (no GPU)")

    async def step(self, audio_chunk_pcm: bytes) -> bytes:
        await asyncio.sleep(0.1)
        return audio_chunk_pcm

    def get_vram_mb(self) -> tuple[int, int]:
        return (0, 0)