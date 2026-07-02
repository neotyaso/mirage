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

# "small": OpenAI Whisper標準モデル。エンコーダーが軽く実測3.9秒→1.1秒（約4倍速）
# kotoba-whisper-v2.0-faster（大文字硬い日本語特化）は精度は良いがエンコーダーがlarge-v3のまま重く展示用途には不向きだった
# 精度が足りない場合は "medium" を試す（small よりは遅いがlargeよりずっと軽い）
MODEL_NAME = "small"
COMPUTE_TYPE = "int8"  # Macはint8が安定。GPU(CUDA)あれば "float16" に

print(f"Loading {MODEL_NAME} ...")
model = WhisperModel(MODEL_NAME, device="cpu", compute_type=COMPUTE_TYPE)
print("STT server ready.")


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
