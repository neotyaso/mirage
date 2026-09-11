"""Gemini S2S の WS 疎通確認 (Qwen test と同protocol)。

Usage:
    # ローカル mock (ENGINE_BACKEND=mock で gemini factory を起動)
    $env:ENGINE_BACKEND="mock"; $env:PORT="8002"; python -m uvicorn server.gemini_main:app --port 8002
    python scripts/test_gemini_ws.py --url ws://127.0.0.1:8002/ws --frames 10

    # 実キー (GEMINI_API_KEY を設定して起動)
    $env:ENGINE_BACKEND="gemini"; $env:GEMINI_API_KEY="..."; python -m uvicorn server.gemini_main:app --port 8002
    python scripts/test_gemini_ws.py --url ws://127.0.0.1:8002/ws --frames 10 --tone

    # 実キーで確実に応答を得る場合 (テキスト転送。純粋な440Hzトーンは
    # GeminiのVADに無音扱いされ応答が来ない=正常動作のため):
    python scripts/test_gemini_ws.py --url ws://127.0.0.1:8002/ws --text "Hello. Reply briefly in Japanese."

動作:
    1. 接続 → initial listening 待ち (+ /health 表示は手動)
    2. 無音/トーンフレームを --frames 個送る
    3. commit → thinking → text → audio → metrics → listening を読む
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import json
import math
import struct
import sys

import websockets


def make_pcm(frames: int, sr: int = 24_000, freq: float = 0.0, amp: float = 0.3) -> bytes:
    n = int(sr * 0.08)  # 80ms
    out = bytearray()
    for _ in range(frames):
        for i in range(n):
            v = 0.0 if freq <= 0 else math.sin(2 * math.pi * freq * i / sr) * amp
            out += struct.pack("<h", int(max(-1.0, min(1.0, v)) * 32767))
    return bytes(out)


async def main(url: str, frames: int, timeout: float, tone: bool, text: str = "") -> int:
    print(f"[test] connecting to {url}")
    async with websockets.connect(url, max_size=16 * 1024 * 1024) as ws:
        raw = await asyncio.wait_for(ws.recv(), timeout=timeout)
        print(f"[test] initial: {raw}")
        msg = json.loads(raw)
        assert msg.get("state") == "listening", f"expected listening, got {msg}"

        if text:
            await ws.send(json.dumps({"type": "text", "data": text}))
            print(f"[test] sent text: {text!r}")
        else:
            freq = 440.0 if tone else 0.0
            pcm = make_pcm(1, freq=freq)
            b64 = base64.b64encode(pcm).decode()
            for i in range(frames):
                await ws.send(json.dumps({"type": "audio", "data": b64}))
                print(f"[test] sent frame {i} ({'tone' if tone else 'silence'})")
                await asyncio.sleep(0.02)

            await ws.send(json.dumps({"type": "commit"}))
            print("[test] sent commit, waiting for turn result...")

        got_text = got_audio = got_metrics = False
        deadline = asyncio.get_event_loop().time() + timeout
        while asyncio.get_event_loop().time() < deadline:
            try:
                raw = await asyncio.wait_for(ws.recv(), timeout=timeout)
            except asyncio.TimeoutError:
                print("[test] TIMEOUT waiting for turn result")
                return 2
            msg = json.loads(raw)
            t = msg.get("type")
            if t == "state":
                print(f"[test] state: {msg.get('state')}")
            elif t == "text":
                got_text = True
                print(f"[test] text: {str(msg.get('data'))[:200]!r}")
            elif t == "audio":
                got_audio = True
                print(f"[test] audio: {len(base64.b64decode(msg['data']))} bytes PCM")
            elif t == "metrics":
                got_metrics = True
                print(f"[test] metrics: {str(msg)[:300]}")
                break
            elif t == "error":
                print(f"[test] server error: {msg}")
                return 1
            else:
                print(f"[test] other: {raw[:200]}")

        # transcription は audio より遅れて届くことがある。数秒だけ待つ
        if not got_text:
            try:
                end = asyncio.get_event_loop().time() + 8
                while asyncio.get_event_loop().time() < end:
                    raw = await asyncio.wait_for(ws.recv(), timeout=8)
                    msg = json.loads(raw)
                    if msg.get("type") == "text":
                        got_text = True
                        print(f"[test] text(late): {str(msg.get('data'))[:200]!r}")
                        break
                    elif msg.get("type") == "metrics":
                        pass
                    else:
                        print(f"[test] drain: {raw[:200]}")
                        if msg.get("type") == "pong":
                            break
            except asyncio.TimeoutError:
                pass

        await ws.send(json.dumps({"type": "ping"}))
        for _ in range(5):
            raw = await asyncio.wait_for(ws.recv(), timeout=30)
            print(f"[test] ping -> {raw[:200]}")
            if json.loads(raw).get("type") == "pong":
                break
        print(f"[test] done (text={got_text} audio={got_audio} metrics={got_metrics})")
        return 0 if (got_audio and got_metrics) else 1


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="ws://127.0.0.1:8002/ws")
    ap.add_argument("--frames", type=int, default=10)
    ap.add_argument("--timeout", type=float, default=60.0)
    ap.add_argument("--tone", action="store_true")
    ap.add_argument("--text", default="", help="テキスト転送で応答を得る (実キー用)")
    args = ap.parse_args()
    sys.exit(asyncio.run(main(args.url, args.frames, args.timeout, args.tone, args.text)))
