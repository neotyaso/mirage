# mirage — 展示用AITuberブース

リアルタイム会話・顔認識・3Dアバターを組み合わせた展示向けAITuberシステム。
来場者に話しかけ、会話し、反応する自律AIキャラクター。

## システム構成

```
カメラ（顔検出・接近検知）
   ↓
MediaPipe（顔トラッキング）
   ↓
Groq STT（音声認識）← マイク
   ↓
Claude API（LLM会話）
   ↓
音声合成（TTS）→ スピーカー
   ↓
Three.js（3Dアバター表示）← img3dで生成したGLB
```

## ディレクトリ構成

```
mirage/
├── src/              # フロントエンド（React + Three.js）
├── tools/
│   └── img3d/        # 画像→3Dモデル生成パイプライン（サブリポジトリ）
└── NEXT.md           # 今後のタスク・キャラクター構想
```

## 起動方法

### フロントエンド（会話・3D表示）

```bash
pnpm dev
```

### 3Dモデル生成サーバー（WSL2 Ubuntu）

```bash
cd /mnt/c/プログラミング/mirage/tools/img3d
~/.local/bin/uv run server.py
# → http://localhost:8000/
```

詳細は `tools/img3d/README.md` 参照。

---

## 開発記録（ポートフォリオ用）

### プロジェクト概要

2026年7月の展示に向けて構築。「呼び込みAI」として来場者に自律的に話しかけ、会話し、3Dアバターとして視覚的に表現するシステム。

---

### Phase A: 会話・音声システム

**やったこと**
- 顔検出（MediaPipe）で来場者の接近を検知
- 一定距離以内に来た人に自動で話しかける呼び込み機能
- Groq APIでSTT（音声認識）をストリーミング化
- Claude APIでLLM会話（クラウド運用予定）
- ローカルLLMをフォールバックとして用意（Groq障害時）

**工夫**
- 複数人が映った際の顔トラッキング安定化（誰に話しかけるか）
- 会話中に別の人が近づいても呼び込みが誤爆しないよう制御
- Groq STTのストリーミングで応答レイテンシを大幅短縮
- 展示本番用にUIをクリーンアップ（デバッグ表示を隠す）

---

### Phase B: 3Dモデル生成パイプライン構築（最大の山場）

> 2026-07-03〜05。ここが一番大変だった。

#### 動機

展示映えするオリジナル3Dキャラが欲しかった。教授が公開していた `img3d`（TripoSR→Blender→GLB）を自分の環境で動かすことにしたが、ローカル構築でここまで沼るとは思わなかった。

---

#### B-1: 環境構築（WSL2 + CUDA + Python）

**環境**
- Windows 11 + WSL2 Ubuntu
- GTX 1080Ti（VRAM 11GB）、CUDA 12.1
- `uv`（Pythonパッケージマネージャー）

**つまづき**

| 問題 | 原因 | 解決策 |
|------|------|--------|
| `bpy`インストール失敗 | Python 3.13専用なのにuvが3.14を選んだ | `uv sync --python 3.13` でバージョン固定 |
| Blender起動で`libSM.so.6 not found` | WSL2にX11ライブラリが未インストール | `apt-get install libsm6 libxrender1 libxext6 libgl1` |
| sudoコマンドがハング | PowerShell → WSL経由の対話型sudo問題 | `wsl -d Ubuntu -u root` で直接root実行 |

---

#### B-2: HuggingFaceモデルダウンロード（繰り返し発生）

**問題**
- TripoSR（670MB）、TripoSG（8GB）ともにダウンロード中に接続が`CLOSE-WAIT`で止まる
- Pythonの`snapshot_download`は切断後に新しい`.incomplete`ファイルを作り直すため、再実行するたびに最初から
- 80%・93%など中途半端な場所で毎回止まる、30分〜数時間の無駄

**解決策**
```bash
# wget -c でレジューム対応DL + 認証トークン
wget -c --header "Authorization: Bearer $HF_TOKEN" \
  "https://huggingface.co/..."

# .incomplete ファイルを手動でリネームして完成扱いに
mv model.safetensors.incomplete model.safetensors
```

**学び**: 大容量ファイルのダウンロードはPythonライブラリより`wget -c`が安定。HuggingFaceは無認証の大容量ダウンロードを途中で切ることがある。トークン認証が必要。

---

#### B-3: TripoSRからTripoSGへのアップグレード

**なぜ切り替えたか**
- TripoSRは顔のテクスチャが崩れてクオリティが明らかに低い
- GTX 1080Ti（11GB）があればTripoSG（8GB+必要）が動かせると判断
- MIT licenseで商用利用可

**TripoSG固有のインストール沼（連鎖するバージョン問題）**

1. **numpy競合**
   - TripoSGが`numpy==1.22.3`を要求、既存環境は`numpy>=2.2`
   - → 完全に分離した別venv（Python 3.10）を作成

2. **`diso`パッケージのビルド失敗（CUDA C++拡張）**
   - まず`pkg_resources`がないエラー → `pip install setuptools==69.5.1`
   - 次に`cuda_runtime.h`がないエラー → NVIDIAリポジトリ追加して`cuda-nvcc-12-1 cuda-cudart-dev-12-1`インストール
   - GCC 13（システムデフォルト）がCUDA 12.1のnvccに拒否される → `gcc-12 g++-12`インストールして`CC=gcc-12`指定

3. **diffusers/transformers/torchのバージョン不整合（3連続）**
   - `torch.xpu`が存在しないエラー → torch 2.1→2.4にアップグレード
   - `FLAX_WEIGHTS_NAME`がtransformersから消えたエラー → transformers 4.44.2にダウングレード
   - torch 2.4にしたらdisのC++シンボルが壊れる（ABIミスマッチ） → `CC=gcc-12 pip install diso --force-reinstall`で再コンパイル

**感想**: Pythonの「動く組み合わせ」は非常に狭く、torch+diffusers+transformers+numpyは1つ変えると連鎖的に壊れる。公式ドキュメントに書いていない相性問題だらけ。

---

#### B-4: パイプライン統合

**つまづき**

- `uv`をサブプロセスで呼んだら`[Errno 2] No such file or directory: 'uv'`
  - サブプロセスはPATH環境変数を引き継がない場合がある
  - → `shutil.which("uv") or os.path.expanduser("~/.local/bin/uv")` でフルパス解決

- Blenderのデシメーション処理がOBJしか対応していない
  - TripoSGはGLB出力なのに`No mesh found`エラー
  - → `bpy.ops.import_scene.gltf()`を追加して拡張子で分岐

- サブプロセスからの日本語ログが`UnicodeDecodeError`
  - → `subprocess.run(..., encoding="utf-8", errors="replace")`で回避

- `bpy`（Blender）と`torch`は同一プロセスで共存不可
  - bpyはPython 3.13専用、torchはPython 3.10が安定
  - → TripoSGを別venv・別プロセスで実行するサブプロセスアーキテクチャに設計

```python
# bpyとtorchを同一プロセスで動かせないため、
# TripoSGをサブプロセスとして分離する設計
_TRIPOSG_PYTHON = os.path.join(_ROOT, ".venv-triposg", "bin", "python")
subprocess.run([_TRIPOSG_PYTHON, "triposg_infer.py", ...])
```

---

#### B-5: テクスチャ問題と方針転換

**試みたこと**
- TripoSGはジオメトリのみでテクスチャなし
- 元の入力画像をBlenderで自動UV投影してテクスチャとして貼る処理を実装

**結果**
- Smart UV Projectでのテクスチャ投影が失敗
- 画像がランダムな場所に断片的に貼り付けられ、全く意図した見た目にならない

**方針転換**
- 自動テクスチャ投影は断念
- **Blender MCP**（ClaudeがBlenderをMCP経由でPython操作）で手動修正する方針に
- テクスチャだけでなく、指がくっつくなどのメッシュ問題もBlender MCPで修正予定

---

#### B-6: 最終成果

TripoSGパイプラインが完全稼働。

- 入力: 全身画像（1枚）
- 所要時間: 約6〜10分（GPU 100%使用）
- 出力: 高品質なリアル人体3Dメッシュ（グレー）

TripoSRとの比較では別物のクオリティ。髪・顔・シルエットがリアルで展示映えする形状が出力できる。テクスチャはBlender MCPで次フェーズに対応予定。

---

### 技術スタック

| 用途 | 技術 |
|------|------|
| フロントエンド | React + Three.js + Vite |
| 3Dレンダリング | `@react-three/fiber` + `@react-three/drei` |
| 顔検出 | MediaPipe Tasks Vision |
| 音声認識 | Groq Whisper API（ストリーミング） |
| LLM会話 | Claude API（Anthropic） |
| 3Dモデル生成 | TripoSG（VAST-AI-Research）+ bpy（Blender） |
| GPU実行環境 | WSL2 Ubuntu + CUDA 12.1 + GTX 1080Ti |
| Pythonパッケージ管理 | uv |

---

### 一番しんどかったこと

HuggingFaceのダウンロードが何度も途中で止まること。TripoSRで数回、TripoSGで何十回も止まった。原因はHuggingFace CDNが無認証の大容量ダウンロードを途中で切ること。「あと残り少し」というところで止まり、再試行するたびにまた最初から、という無限ループ。最終的に`wget -c`（レジューム）と認証トークンで安定させた。

### 面白かったこと

- TripoSGが実際に動いた瞬間、GPU使用率が100%になって5〜10分後にリアルな人物3Dメッシュが出てきたのは純粋に感動した
- WSL2でWindowsのGPUがそのままCUDA利用できる（NVIDIAのWSL-CUDAブリッジ）完成度が思ったより高い
- 同じシステムで「呼び込み系キャラ」と「傾聴特化キャラ」という全く異なる体験を作れることに気づいた

### 学んだこと

- AIの3Dモデル生成はジオメトリ（形状）は急速に良くなっているが、テクスチャ・リギングはまだ人手の比重が高い
- Pythonのパッケージ競合は「バージョンを合わせる」より「venvを分けて別プロセスで動かす」のが現実的な解決策になることがある
- 展示物は完璧より「7/22までに動く状態」を優先する判断も大事
