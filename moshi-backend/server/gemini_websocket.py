"""Gemini Live 用 WS ハンドラ (streaming proxy + Qwen互換protocol)。

プロトコル互換性 (フロント変更不要):
  - 受信: {type: audio, data: base64(24kHz int16)} を80msフレーム毎に受ける
  - 送信: state / audio / metrics + text
  - 追加受信: {type: commit} → Gemini に activity_end (強制確定)
              {type: cancel} → 無視して listening 通知 (自動VADに委譲)
              {type: ping} → {type: pong}

動作:
  - WS接続毎に Gemini Live セッションを1つ開く (server-to-server 構成)。
    APIキーはサーバ側のみが保持し、ブラウザに漏れない。
  - フロント24kHz → 16kHz リサンプル (numpy不要の軽量版) して転送。
  - Gemini 24kHz 出力はそのまま base64 で返す (フロント playPcm が可変長対応)。
  - transcription は text として返す。input/output の区別は metrics.text に結合しない。
  - metrics はターン毎に input_to_inference_ms (ターン開始→初回音声) を計測。

Moshi本家 / Qwen 系コードは凍結。moshijpは継続中。いずれも本ファイルからは触らない。
"""
from __future__ import annotations

import asyncio
import base64
import struct
import time

from fastapi import WebSocket, WebSocketDisconnect

IN_SR = 24_000
MODEL_SR = 16_000


def _resample_24k_to_16k(pcm24: bytes) -> bytes:
    n_in = len(pcm24) // 2
    if n_in == 0:
        return b""
    vals = struct.unpack(f"<{n_in}h", pcm24)
    n_out = int(n_in * MODEL_SR / IN_SR)
    out = bytearray(n_out * 2)
    for i in range(n_out):
        pos = i * n_in / n_out
        j = int(pos)
        frac = pos - j
        a = vals[j] / 32768.0
        b = vals[min(j + 1, n_in - 1)] / 32768.0
        v = int(max(-1.0, min(1.0, a + (b - a) * frac)) * 32767)
        struct.pack_into("<h", out, i * 2, v)
    return bytes(out)


async def handle_gemini_websocket(ws: WebSocket, engine, session_factory) -> None:
    await ws.accept()
    session = session_factory()
    await ws.send_json({"type": "state", "state": "listening"})
    print(f"[Gemini session {session.session_id}] connected (model={getattr(engine, 'model', '?')})")

    # Gemini セッション確立 (mock は open なし、実キーはここで Live 接続)
    gsession = engine.create_session()
    try:
        open_fn = getattr(gsession, "open", None)
        if callable(open_fn):
            await open_fn()
    except Exception as e:
        print(f"[Gemini session {session.session_id}] open failed: {e}")
        await ws.send_json({"type": "error", "message": str(e)})
        await ws.close()
        return

    turn_start: float | None = None
    first_audio_ms: float | None = None
    last_text = ""

    async def on_audio(pcm24: bytes) -> None:
        nonlocal first_audio_ms
        if len(pcm24) < 1024:
            # 先頭の数バイト断片 (SessionResumption直後の2B等) は捨てる
            return
        if turn_start is not None and first_audio_ms is None:
            first_audio_ms = (time.perf_counter() - turn_start) * 1000
        try:
            await ws.send_json({"type": "state", "state": "speaking"})
            await ws.send_json({"type": "audio", "data": base64.b64encode(pcm24).decode()})
        except RuntimeError:
            pass

    async def on_text(text: str, kind: str = "output") -> None:
        nonlocal last_text
        if kind == "output":
            last_text = text
        try:
            await ws.send_json({"type": "text", "data": text})
        except RuntimeError:
            pass

    async def on_state(state: str) -> None:
        nonlocal turn_start, first_audio_ms, last_text
        if state == "thinking" and turn_start is None:
            turn_start = time.perf_counter()
            first_audio_ms = None
            last_text = ""
        try:
            if state == "listening" and first_audio_ms is not None:
                # ターン確定時に1回だけ metrics (Qwen互換)。textは逐次送信済み。
                await ws.send_json(
                    {
                        "type": "metrics",
                        "input_to_inference_ms": round(first_audio_ms, 1),
                        "inference_to_output_ms": 0.0,
                        "backend": "gemini",
                        "text": last_text,
                    }
                )
            await ws.send_json({"type": "state", "state": state})
        except RuntimeError:
            pass
        finally:
            if state == "listening":
                turn_start = None
                first_audio_ms = None

    recv_task = asyncio.create_task(
        gsession.receive_loop(on_audio, on_text, on_state)
    )

    def _log_recv_done(t: asyncio.Task) -> None:
        try:
            t.result()
            print(f"[Gemini session {session.session_id}] receive_loop ended cleanly")
        except asyncio.CancelledError:
            pass
        except Exception:
            import traceback

            print(f"[Gemini session {session.session_id}] receive_loop FAILED:")
            traceback.print_exc()

    recv_task.add_done_callback(_log_recv_done)

    try:
        while True:
            msg = await ws.receive_json()
            mtype = msg.get("type")
            if mtype == "audio":
                try:
                    pcm24 = base64.b64decode(msg["data"])
                except Exception as e:
                    await ws.send_json({"type": "error", "message": f"invalid base64: {e}"})
                    continue
                if turn_start is None:
                    turn_start = time.perf_counter()
                    first_audio_ms = None
                pcm16 = _resample_24k_to_16k(pcm24)
                try:
                    await gsession.send_pcm16k(pcm16)
                except Exception as e:
                    await ws.send_json({"type": "error", "message": str(e)})
            elif mtype in ("commit", "end", "flush"):
                try:
                    await gsession.commit_turn()
                except Exception as e:
                    await ws.send_json({"type": "error", "message": str(e)})
            elif mtype == "text" and isinstance(msg.get("data"), str):
                # Lab/テストからのテキスト入力 → Gemini に転送 (マイクなし疎通・会話用)
                if turn_start is None:
                    turn_start = time.perf_counter()
                    first_audio_ms = None
                try:
                    await ws.send_json({"type": "state", "state": "thinking"})
                    await gsession.send_text(msg["data"])
                except Exception as e:
                    await ws.send_json({"type": "error", "message": str(e)})
            elif mtype == "ping":
                await ws.send_json({"type": "pong"})
            elif mtype == "cancel":
                await ws.send_json({"type": "state", "state": "listening"})
    except WebSocketDisconnect:
        print(f"[Gemini session {session.session_id}] disconnected")
    except RuntimeError as e:
        print(f"[Gemini session {session.session_id}] runtime disconnect: {e}")
    finally:
        recv_task.cancel()
        try:
            await gsession.close()
        except Exception:
            pass
