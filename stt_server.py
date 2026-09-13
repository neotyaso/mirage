"""
STT server: faster-whisper (kotoba-whisper-v2) で日本語音声をテキスト化
起動: python stt_server.py
"""
import os
import tempfile
import uvicorn
from fastapi import FastAPI, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from faster_whisper import WhisperModel

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# small: M1 AirのCPUでも数秒で起動・認識できるサイズ。展示の短文用途の既定
# 精度を上げる場合のみ STT_MODEL / STT_DEVICE / STT_COMPUTE_TYPE のenvで上書き
MODEL_NAME = os.environ.get("STT_MODEL", "small")
DEVICE = os.environ.get("STT_DEVICE", "cpu")
COMPUTE_TYPE = os.environ.get("STT_COMPUTE_TYPE", "int8")  # CUDAを使う場合のみ "float32" を指定 (1080Tiはfloat16不可)

print(f"Loading {MODEL_NAME} ({DEVICE}/{COMPUTE_TYPE}) ...")
try:
    model = WhisperModel(MODEL_NAME, device=DEVICE, compute_type=COMPUTE_TYPE)
except Exception as e:
    print(f"[STT] {DEVICE} load failed ({e}), falling back to cpu/int8")
    model = WhisperModel(MODEL_NAME, device="cpu", compute_type="int8")
print("STT server ready.")


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.post("/transcribe")
async def transcribe(audio: UploadFile = File(...)):
    # 受け取った音声ファイルを一時保存して文字起こし
    suffix = os.path.splitext(audio.filename or ".webm")[1] or ".webm"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as f:
        f.write(await audio.read())
        tmp_path = f.name

    try:
        segments, _ = model.transcribe(
            tmp_path,
            language="ja",
            beam_size=1,            # ビームサーチ無し（貪欲探索）。展示の短い発話では精度差はほぼ出ないが数倍速い
            vad_filter=True,       # 無音部分を自動スキップ
            vad_parameters={"min_silence_duration_ms": 500},
        )
        text = "".join(s.text for s in segments).strip()
    finally:
        os.unlink(tmp_path)

    print(f"[STT] {text}")
    return {"text": text}


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
