from fastapi import WebSocket, WebSocketDisconnect
from server.protocol import StateMessage
from monitoring.latency import LatencyTracker


async def handle_websocket(ws: WebSocket, engine, session_factory) -> None:
    await ws.accept()
    session = session_factory()
    latency = LatencyTracker()

    await ws.send_json(StateMessage(type="state", state="listening").__dict__)
    print(f"[Session {session.session_id}] connected")

    try:
        while True:
            msg = await ws.receive_json()

            if msg.get("type") == "audio":
                latency.mark("input_received")
                audio_out = await engine.step(msg["data"])
                latency.mark("inference_done")

                await ws.send_json({"type": "audio", "data": audio_out})
                latency.mark("output_sent")

                report = {
                    "type": "metrics",
                    "input_to_inference_ms": latency.since_mark_ms("input_received", "inference_done"),
                    "inference_to_output_ms": latency.since_mark_ms("inference_done", "output_sent"),
                }
                await ws.send_json(report)

            elif msg.get("type") == "ping":
                await ws.send_json({"type": "pong"})

    except WebSocketDisconnect:
        print(f"[Session {session.session_id}] disconnected")