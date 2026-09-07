# Moshi Backend

Mirageから接続するMoshiリアルタイム音声対話バックエンド。

## 重要: ローカル1080Tiでは動かない

2026年9月時点で1080Ti (Compute Capability 6.1) では、Moshi 7Bモデルが**動作不能**と検証済み:
- VRAM余裕 148MB (Mimi codec + KV cache で OOM)
- 1ステップ推論 5.5秒 (リアルタイム予算80msの69倍)
- PyTorch Triton inductor がCC7.0+必須で1080Tiでは動かない

詳細は `docs/moshi-on-1080ti-report.md` を参照。

## アーキテクチャ

```
[Moshi Engine Interface]
   (moshi_engine/engine.py)
         |
   +-----+-----+
   |           |
[Lightning AI] [Modal]
  開発・検証    本番運用
```

両環境で**同じ`server/factory.py`**を動かします。

## 開発フロー

1. **Phase 1**: 骨格完成 (今ここ)
2. **Phase 2**: Lightning AI上でPyTorchEngine実装・Moshi動作確認
3. **Phase 3**: リアルタイム対話の成立検証
4. **Phase 4**: WebSocket Mirage接続
5. **Phase 5**: Modalデプロイ

## クイックスタート (モック)

```bash
# インストール
pip install -r requirements.txt

# モックモードで起動 (GPU不要)
ENGINE_BACKEND=mock python -m server.main
# -> http://127.0.0.1:8000/health
# -> ws://127.0.0.1:8000/ws
```

Windows ローカルでの確認:
```powershell
.\scripts\run.ps1
```

## Lightning AI で開発

```bash
# Lightning CLI インストール
pip install lightning
lightning login

# Studio作成 (L4 GPU)
lightning init new moshi-dev --machine L4
lightning sync moshi-dev ./moshi-backend

# Studio内で
bash scripts/setup_lightning.sh
python -m server.main
```

## Modal にデプロイ

```bash
pip install modal
modal token new
modal deploy cloud/modal_app.py
```

## Mirage から接続

WebSocketクライアントはMirage側(`src/`)で実装予定。

## ディレクトリ構成

```
moshi-backend/
├── README.md
├── Dockerfile
├── requirements-cloud.txt
├── .gitignore
│
├── server/                  # FastAPI + WebSocket エントリ
│   ├── main.py              # アプリ起動・health/ws
│   ├── factory.py           # 環境別エンジン生成 (env→ENGINE_BACKEND)
│   ├── websocket.py         # Mirage向けWSハンドラ
│   ├── session.py           # セッション状態管理
│   └── protocol.py          # 音声フレーム/イベント定義
│
├── moshi_engine/            # Moshiエンジン抽象
│   ├── engine.py            # MoshiEngine 抽象IF
│   └── mock_engine.py       # GPU不要のモック実装
│
├── audio/                   # 音声I/O・Mimi codec
├── config/                  # YAML設定
├── cloud/                   # Modalデプロイ
│   └── modal_app.py
├── monitoring/              # pynvml・メトリクス
├── logs/                    # *.jsonl (gitignore)
│
├── scripts/
│   ├── setup_lightning.sh   # Lightning Studio セットアップ
│   ├── setup_lightning.ps1  # Windowsローカル モック確認
│   ├── run.ps1              # Windowsローカル起動
│   ├── run_local.sh         # POSIXローカル起動
│   └── benchmark.sh         # モックでベンチ
│
├── tests/
│   ├── unit/
│   └── integration/
│
└── docs/
    └── moshi-on-1080ti-report.md
```