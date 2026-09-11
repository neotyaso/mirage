"""Gemini Live API (gemini-3.1-flash-live-preview) S2S エンジン。

設計:
  - フロント互換: 既存WSプロトコル (audio/state/metrics + text) を維持。
    フロントはURL差し替えのみで動く (Qwen方式と同一)。
  - サーバ側は Gemini Live への薄いプロキシ:
    フロント 24kHz PCM → 16kHz にリサンプル → send_realtime_input で転送。
    Gemini 24kHz PCM / transcription を受けてそのまま WS で返す。
  - VAD/endpointing は Gemini 側の automatic_activity_detection に委譲。
    フロントからの commit は activity_end として転送 (Qwen互換)。
  - GPU不要。GEMINI_API_KEY (or GOOGLE_API_KEY) が無ければ起動時に警告し、
    ENGINE_BACKEND=mock の場合は GeminiMockEngine (GPU不要・課金なし) を使う。

公式仕様 (ai.google.dev/gemini-api/docs/live-api):
  - model: gemini-3.1-flash-live-preview
  - 入力: raw 16-bit PCM 16kHz mono, mime audio/pcm;rate=16000
  - 出力: raw 16-bit PCM 24kHz mono (そのままフロントへ)
  - SDK: pip install google-genai, from google import genai
  - config: response_modalities=[AUDIO], input/output_audio_transcription={},
    system_instruction, speech_config.voice_config.prebuilt_voice_config.voice_name
"""
from __future__ import annotations

import asyncio
import math
import os
import struct

GEMINI_MODEL = os.environ.get(
    "GEMINI_MODEL", os.environ.get("MODAL_GEMINI_MODEL", "gemini-3.1-flash-live-preview")
)
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", os.environ.get("GOOGLE_API_KEY", ""))
GEMINI_SYSTEM_PROMPT = os.environ.get(
    "GEMINI_SYSTEM_PROMPT",
    "あなたは展示ブースの明るい受付嬢レムです。日本語で、短く元気に話します。"
    "一文は40文字以内。相手の話に具体的に反応し、質問で会話を続けます。",
)
GEMINI_VOICE = os.environ.get("GEMINI_VOICE", "Zephyr")


def get_api_key() -> str:
    return os.environ.get("GEMINI_API_KEY", os.environ.get("GOOGLE_API_KEY", ""))


def build_config_dict() -> dict:
    """google-genai の LiveConnectConfig に渡せる dict 形式。"""
    return {
        "response_modalities": ["AUDIO"],
        "system_instruction": GEMINI_SYSTEM_PROMPT,
        "speech_config": {
            "voice_config": {"prebuilt_voice_config": {"voice_name": GEMINI_VOICE}}
        },
        "input_audio_transcription": {},
        "output_audio_transcription": {},
    }


class GeminiLiveSession:
    """1 WSクライアントに対応する Gemini Live セッションのラッパー。"""

    def __init__(self, model: str | None = None) -> None:
        self.model = model or GEMINI_MODEL
        self._client = None
        self._cm = None  # connect() の async context manager。保持しないとGCで切断される
        self._session = None

    async def open(self) -> None:
        try:
            from google import genai
        except ImportError as e:
            raise RuntimeError(
                "google-genai 未インストール。pip install -r requirements-gemini.txt"
            ) from e
        api_key = get_api_key()
        if not api_key:
            raise RuntimeError("GEMINI_API_KEY (or GOOGLE_API_KEY) が未設定")
        self._client = genai.Client(api_key=api_key)
        config = build_config_dict()
        # NOTE: connect() は @asynccontextmanager。__aenter__ したCM本体を
        # self._cm に保持しないと参照切れ→asyncgen finalizerでWSが1000 closeされる。
        # 以前は一時オブジェクトに__aenter__していたため受信0件で切断されていた。
        self._cm = self._client.aio.live.connect(model=self.model, config=config)
        self._session = await self._cm.__aenter__()

    async def send_pcm16k(self, pcm: bytes) -> None:
        from google.genai import types

        assert self._session is not None, "session not open"
        if not pcm:
            return
        await self._session.send_realtime_input(
            audio=types.Blob(data=pcm, mime_type="audio/pcm;rate=16000")
        )

    async def send_text(self, text: str) -> None:
        """フロント/Lab からのテキスト入力 (実キー疎通テスト・マイクなし会話用)。"""
        assert self._session is not None, "session not open"
        if not text:
            return
        await self._session.send_realtime_input(text=text)

    async def commit_turn(self) -> None:
        """フロントの確定ボタン/Qwen互換commit → Gemini に activity_end を送る。"""
        from google.genai import types

        assert self._session is not None, "session not open"
        try:
            await self._session.send_realtime_input(
                activity_end=types.ActivityEnd()
            )
        except TypeError:
            # SDK版差異: 引数名が違う場合は無視 (自動VADに任せる)
            pass

    async def receive_loop(self, on_audio, on_text, on_state=None):
        """Geminiからの応答を回し、コールバックで返す。終了するまで戻らない。

        on_audio(bytes: 24kHz PCM), on_text(str, kind), on_state(str)
        kind: "input" | "output"
        """
        assert self._session is not None, "session not open"
        try:
            async for response in self._session.receive():
                sc = getattr(response, "server_content", None)
                if sc is None:
                    continue
                # ターン確定 → listening に戻す合図
                if getattr(sc, "turn_complete", False):
                    if on_state:
                        await on_state("listening")
                    continue
                if getattr(sc, "interrupted", False):
                    if on_state:
                        await on_state("listening")
                    continue
                # モデル音声チャンク
                mt = getattr(sc, "model_turn", None)
                if mt and getattr(mt, "parts", None):
                    for part in mt.parts:
                        inline = getattr(part, "inline_data", None)
                        if inline is not None and getattr(inline, "data", None):
                            data = inline.data
                            # SDKは bytes / base64 str どちらもあり得る
                            if isinstance(data, str):
                                import base64

                                data = base64.b64decode(data)
                            # speaking通知は on_audio 側で行う (二重送信防止)
                            await on_audio(bytes(data))
                # 入力転写 (ユーザ発話の確認用)
                it = getattr(sc, "input_transcription", None)
                if it and getattr(it, "text", None):
                    if on_state:
                        await on_state("thinking")
                    await on_text(it.text, "input")
                # 出力転写 (モデル応答テキスト)
                ot = getattr(sc, "output_transcription", None)
                if ot and getattr(ot, "text", None):
                    await on_text(ot.text, "output")
        except Exception:
            import traceback

            print("[Gemini] receive_loop FAILED:")
            traceback.print_exc()
            raise

    async def close(self) -> None:
        try:
            if self._cm is not None:
                try:
                    await self._cm.__aexit__(None, None, None)
                except Exception:
                    pass
        finally:
            self._cm = None
            self._session = None
            self._client = None


class GeminiLiveEngine:
    """factory 用エンジン。セッション生成と /health 向け情報を提供。"""

    def __init__(self, model: str | None = None) -> None:
        self.model = model or GEMINI_MODEL

    def load(self) -> None:
        # 接続は WS 毎に遅延確立。ここではキー有無だけ警告。
        if not get_api_key():
            print("[Gemini] WARNING: GEMINI_API_KEY 未設定 (接続時にエラー)。mockを使う場合は ENGINE_BACKEND=mock")
        else:
            print(f"[Gemini] model={self.model} (keyあり)")

    def create_session(self) -> GeminiLiveSession:
        return GeminiLiveSession(model=self.model)

    def get_vram_mb(self) -> tuple[int, int]:
        return (0, 0)


class GeminiMockEngine(GeminiLiveEngine):
    """APIキー不要のモック。protocol互換の text+audio を返す。

    streamingプロキシと同じ outward protocol で振る舞い、
    test_gemini_ws.py (frames + commit → thinking/text/audio/metrics/listening)
    が実キーなしで通ることを目的とする。
    """

    def __init__(self) -> None:
        super().__init__(model="mock")

    def load(self) -> None:
        print("[GeminiMock] loaded (no API key, no GPU)")

    def create_session(self):  # type: ignore[override]
        return GeminiMockSession()


class GeminiMockSession:
    """commit または一定量の audio 受信で 0.5秒サイン波+固定テキストを返す。"""

    def __init__(self) -> None:
        self._frames = 0
        self._closed = False
        self._recv_queue: asyncio.Queue = asyncio.Queue()

    async def send_pcm16k(self, pcm: bytes) -> None:
        self._frames += 1
        await self._recv_queue.put(("frame", pcm))

    async def commit_turn(self) -> None:
        await self._recv_queue.put(("commit", b""))

    async def send_text(self, text: str) -> None:
        await self._recv_queue.put(("text", text.encode("utf-8")[:200]))

    async def receive_loop(self, on_audio, on_text, on_state=None):
        # commit / text / 5フレーム溜まったら1ターン返す
        pending = 0
        while not self._closed:
            kind, _ = await self._recv_queue.get()
            if kind in ("commit", "text"):
                pass
            else:
                pending += 1
                if pending < 5:
                    continue
            pending = 0
            if on_state:
                await on_state("thinking")
            await asyncio.sleep(0.2)
            await on_text("こんにちは！Geminiモックです。聞こえてますか？", "output")
            # speaking通知は on_audio 側で行う (二重送信防止)
            # 440Hz 0.5秒 24kHz PCM
            n = 24_000 // 2
            out = bytearray(n * 2)
            for i in range(n):
                v = int(math.sin(2 * math.pi * 440 * i / 24_000) * 0.3 * 32767)
                struct.pack_into("<h", out, i * 2, v)
            await on_audio(bytes(out))
            if on_state:
                await on_state("listening")

    async def close(self) -> None:
        self._closed = True
        try:
            await self._recv_queue.put(("commit", b""))
        except Exception:
            pass


def get_gemini_engine() -> GeminiLiveEngine:
    backend = os.environ.get("ENGINE_BACKEND", "gemini").lower()
    if backend in ("mock", "gemini-mock"):
        return GeminiMockEngine()
    return GeminiLiveEngine()
