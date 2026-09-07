"""Moshi Engine Interface — Modal/Lightning/Local 共通"""
from abc import ABC, abstractmethod
import os


class MoshiEngineBase(ABC):
    @abstractmethod
    def load(self) -> None: ...

    @abstractmethod
    async def step(self, audio_chunk_pcm: bytes) -> bytes: ...

    @abstractmethod
    def get_vram_mb(self) -> tuple[int, int]: ...


class PyTorchEngine(MoshiEngineBase):
    def __init__(self, model_name: str = "kyutai/moshiko-pytorch-bf16", device: str = "cuda"):
        self.model_name = model_name
        self.device = device
        self.ckpt = None

    def load(self) -> None:
        # Phase 2 で実装。Lightning AI動作確認時に fill in.
        raise NotImplementedError("Phase 1 task — Lightning AI で実装する")

    async def step(self, audio_chunk_pcm: bytes) -> bytes:
        raise NotImplementedError("Phase 1 task")

    def get_vram_mb(self) -> tuple[int, int]:
        from monitoring.gpu import get_vram_mb
        return get_vram_mb()


class CandleEngine(MoshiEngineBase):
    def __init__(self): ...

    def load(self): raise NotImplementedError("将来用")

    async def step(self, audio_chunk_pcm: bytes): raise NotImplementedError

    def get_vram_mb(self): return (0, 0)


def get_engine() -> MoshiEngineBase:
    backend = os.environ.get("ENGINE_BACKEND", "pytorch")
    if backend == "pytorch":
        return PyTorchEngine()
    if backend == "mock":
        from moshi_engine.mock_engine import MockEngine
        return MockEngine()
    if backend == "candle":
        return CandleEngine()
    raise ValueError(f"Unknown ENGINE_BACKEND: {backend}")