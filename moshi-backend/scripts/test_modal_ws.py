"""
Modalデプロイ後の動作確認クライアント。

Usage:
    MODAL_WS_URL=wss://<workspace>--moshi-local-realtime-serve.modal.run/ws \
        python scripts/test_modal_ws.py
"""
import asyncio
import base64
import os
import sys
import websockets


async def main() -> None:
    url = os.environ.get("MODAL_WS_URL")
    if not url:
        print("ERROR: Set MODAL_WS_URL environment variable", file=sys.stderr)
        sys.exit(1)

    print(f"Connecting to {url} ...")
    async with websockets.connect(url) as ws:
        initial = await ws.recv()
        print(f"Received: {initial}")

        sample_rate = 24000
        silence = b"\x00\x00" * (sample_rate * 1)
        await ws.send_json({
            "type": "audio",
            "data": base64.b64encode(silence).decode(),
        })

        try:
            response = await asyncio.wait_for(ws.recv(), timeout=30.0)
            print(f"Response: {len(response)} bytes")
        except asyncio.TimeoutError:
            print("Timeout (server may be processing)")


if __name__ == "__main__":
    asyncio.run(main())
