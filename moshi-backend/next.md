# next.md — Moshi Backend 次やるメモ

> 最終更新: 2026-09-11（方針転換: Gemini完全自立型へ一本化・Moshi系撤去済み・M1進行中）

## ★ 整理実績（2026-09-11）: Moshi系を撤去

- 削除: `moshi_engine/`、`server/factory,websocket,protocol,main`、`cloud/modal_llmjp_moshi_app.py`、
  `scripts/test_modal_ws.py`、`monitoring/`、`audio/`、`tests/unit/test_{factory,protocol,latency}.py`、
  front側 `useMoshiConversation`・`moshiAudioProcessor`・`moshi-lab/`・`moshi-lab.html`
- 保持: `server/session.py`（Geminiが使用）、`tests/unit/test_session.py`、`useConversation`（M1完了まで）、Playground
- 検証: `tsc --noEmit` 通過、gemini factory import OK（`/health`・`/api/gemini-token`・`/ws` 健在）
- 経緯: `:8002` 未起動で `token発行失敗: 502` → 常駐起動で解消（直/vite経由ともtoken発行OK）

## ★ 次やること（M1: mirage本編へGemini導入・最小疎通＋計測付き）

1. Appにエンジン切替（既存/Gemini）
2. 自立フロー移植（mid/near自動開始・離脱リセット・沈黙ナッジ）
3. Avatar連携（speakingRef/volumeRef・ログ・リップシンク）
4. 呼び込み第一声のZephyr化
5. 計測HUD（接続〜初回音声遅延・turn数・切断回数）
6. M1完了後に `useConversation` 撤去（M2: 自動フォールバック・安定化・起動一発化）

---
> 方針確定: **speechtospeechは Gemini Live API (`gemini-3.1-flash-live-preview`) で実装**。
> Moshi本家 / Qwen 系は凍結・削除しない。moshijp (`cloud/modal_llmjp_moshi_app.py`) は継続中。
> 現フェーズ: **Gemini S2S 骨格実装済み・ローカルmock疎通OK → 実キー疎通待ち**

---

## ★ 方針（2026-09-11）: Gemini 3.1 Flash LiveでS2S

- **使うもの**: `gemini-3.1-flash-live-preview` (Google AI Studio の APIキー、サーバ側のみ保持)
- **構成**: server-to-server。ブラウザ → 自前WS → `server/gemini_main.py` → Gemini Live。
  APIキーはブラウザに出さない。フロントは既存hookのままURL差し替え
  (`audio`/`state`/`metrics` 互換 + `text` 追加、Qwenと同一)。
- **音声**: 入力 24kHz→16kHzリサンプルして `send_realtime_input`、出力 24kHz PCMをそのまま返却。
  VAD/endpointingはGemini側の自動VADに委譲。`commit` は `activity_end` として転送 (Qwen互換)。
- **GPU不要**。Modalデプロイは後回し (ローカル先行)。

### 新規ファイル (2026-09-11)

- `gemini_engine/gemini_live_engine.py` — Live接続ラッパー + `GeminiMockEngine` (キー不要)
- `server/gemini_websocket.py` — streaming proxy (Qwen互換protocol)
- `server/gemini_factory.py` / `server/gemini_main.py` — FastAPI factory + uvicorn入口 (default `:8002`)
- `scripts/test_gemini_ws.py` — 疎通テスト (Qwen版と同手順)
- `requirements-gemini.txt` — `google-genai` 系は分離 (Moshi/Qwenのpinを汚さない)
- フロント: `MoshiLab` に `ws://127.0.0.1:8002/ws` プリセット追加のみ (hook変更なし)
- `.env.example` に `GEMINI_API_KEY/MODEL/VOICE` 追加

### ローカル検証済み (2026-09-11)

- `ENGINE_BACKEND=mock` の Gemini factory を :8002/:8003 で起動
- `python scripts/test_gemini_ws.py --url ws://127.0.0.1:8002/ws --frames 10`
  → thinking → text → speaking → audio(24000B) → metrics → listening。`tsc --noEmit` 通過
- `/health` → `{"status":"ready","backend":"mock","model":"gemini-3.1-flash-live-preview","has_key":false}`

### 実キー疎通OK (2026-09-11)
- `gemini-3.1-flash-live-preview` に Live接続成功。text→音声日本語応答を確認
  (audio計約254KB/約5秒、output_transcription逐次、turn_completeでmetrics+listening)
- `python scripts/test_gemini_ws.py --url ws://127.0.0.1:8008/ws --text "Hello. Reply briefly in Japanese."`
  → thinking → speaking → audio(150KB級、複数チャンク) → text(逐次) → metrics
  (`input_to_inference_ms` 約615ms) → listening。text=True audio=True metrics=True
- 注意点 (実装に反映済み):
  - 純粋な440HzトーンはVADに無音扱いされ応答なし=正常。実音声 or `--text` で検証
  - `connect()` のCMは保持必須 (捨てるとGCでWSが1000 close→受信0件)。`self._cm` に保持
  - 数バイト断片は転送除外 (<1024B skip)、metricsはturn_complete時に1回
- 使い方: `$env:ENGINE_BACKEND="gemini"; $env:GEMINI_API_KEY="..."; python -m uvicorn server.gemini_main:app --port 8002`
- キーはチャット受領・ファイル保存なし (テストプロセスのenvのみ)

### 常駐起動中 (2026-09-11)
- `python -u -m uvicorn server.gemini_main:app --port 8002` を別プロセスで起動済み
  (`.env` のキー参照、`has_key:true` 確認、疎通テスト全OK)
- URL: `ws://127.0.0.1:8002/ws` / health: `http://127.0.0.1:8002/health`

### 直結本仕様化: ephemeral token (2026-09-11)

- 方針: AI Studio方式。backendがtoken発行→ブラウザがGoogleに直結 (低遅延・キー非露出)
- backend: `GET /api/gemini-token` (uses=1、接続30分・新規5分)。疎通OK
- フロント: `useGeminiLive` がtoken直結、失敗時のみdev proxyにフォールバック
- vite: `/api` → `:8002` プロキシ追加 (dev再起動が必要)
- 直結フック修正: micレベル間引き(125Hz→10Hz、1011対策)、マイク→スピーカ直結除去、
  turnCompleteでlistening、「発話を確定」ボタン追加。`tsc` 通過

### 整理 (2026-09-11): 凍結3系統+ログ残骸を削除

- 使用中: `gemini_engine/` + `server/gemini_*` / moshijp (`cloud/modal_llmjp_moshi_app.py` +
  `moshi_engine/` + `server/factory,websocket,protocol,session,main` + `monitoring/`)
- 削除: `qwen_engine/` `qwen3_engine/` `minicpm_engine/`、
  `server/qwen*` `server/minicpm_factory.py`、
  `cloud/modal_{app,benchmark,qwen_app,qwen3_app,minicpm_app}.py`、
  `scripts/{test_qwen_ws,smoke_modal,smoke_moshi_*,asgi_smoke,benchmark}.py`、
  ルートの `*.log` / `apps*.txt` / `deploy*.log` / `stop*.txt` 等
- 注意: Modal上の旧App (qwen-s2s等) は残存。課金はidle停止中のはずだが、
  不要なら `python -m modal app stop <app-id>` で停止すること

## ★ 次やること（Gemini・ローカル先行）

1. ~~**実キー疎通**~~ → 完了 (2026-09-11、`--text` で text/audio/metrics 全OK)
2. **Lab で会話** (次): `ENGINE_BACKEND=gemini` で :8002 起動 → `npm run dev` →
   `/moshi-lab.html` → Geminiプリセットで接続して実音声で話す (要マイク)
3. 問題なければ Modal軽量App化 (`gemini-s2s-staging`) を検討 — GPU不要、secretに `GEMINI_API_KEY`
4. moshijp は継続中 (staging疎通OK→Lab会話へ。詳細は下記moshijp節)

---

## ★ 旧方針メモ（2026-09-10）: Qwen2.5-Omni-7B（凍結）

## ★ 方針転換（2026-09-10）: Moshi → Qwen2.5-Omni-7B

Moshi 7B で Phase 2 まで進んだが (A10G で 128ms/step 動作確認済み)、
full-duplex の作り込み・チューニングに手間がかかるため別方式に切り替え。

- **新方式**: `Qwen/Qwen2.5-Omni-7B` 系で speechtospeech (turn-based)
  - フロントは既存 hook のまま URL 差し替えで動く (`audio`/`state`/`metrics` 互換 + `text` 追加)
  - サーバ側で 80ms フレームをバッファ → 無音 900ms で発話確定 → 1発話ずつ推論 → wav 一括返却
- **VRAM 注意 (公式値)**: 7B BF16 は 15秒音声で 31GB → A10G(24GB) に載らない。
  デフォルトは **GPTQ-Int4 (`Qwen/Qwen2.5-Omni-7B-GPTQ-Int4`, ~11.6GB)** で A10G 想定。
  フル精度を使う場合は `MODAL_GPU=L40S` + `MODAL_QWEN_REPO=Qwen/Qwen2.5-Omni-7B`。
- **Moshi 系コードは凍結** (削除しない)。App も別立て (`moshi-backend-*` と `qwen-s2s-*`)。

### 新規ファイル

- `qwen_engine/qwen_omni_engine.py` — `generate_turn(pcm16) → (text, wav24)`。mock あり
- `server/qwen_websocket.py` — turn-based endpointing (VAD + silence 900ms + commit/cancel)
- `server/qwen_factory.py` — Qwen 用 FastAPI factory (`/health`, `/ws`)
- `cloud/modal_qwen_app.py` — Modal App `qwen-s2s-staging/prod`
- `scripts/test_qwen_ws.py` — 疎通テスト (`--tone` で VAD 発火テスト)
- フロント: `useMoshiConversation` に `onText`/`commitUtterance`/`cancelUtterance` 追加、
  `MoshiLab` に応答テキスト表示・確定ボタン・Qwen URL プリセット追加 (Moshi 互換維持)

### ローカル検証済み (2026-09-10)

- `ENGINE_BACKEND=mock` の Qwen factory を :8001 で起動
- `python scripts/test_qwen_ws.py --url ws://127.0.0.1:8001/ws --frames 10 --tone`
  → thinking → speaking → text → audio(24000B) → metrics → listening。`tsc --noEmit` 通過

## ★ 次やること（最優先: ユーザー側）

1. **staging デプロイ** (1コマンド):
   `$env:MODAL_ENV="staging"; python -m modal deploy cloud/modal_qwen_app.py`
   → `wss://<workspace>--qwen-s2s-staging-serve.modal.run/ws`
2. **疎通確認**:
   `python scripts/test_qwen_ws.py --url wss://.../ws --frames 15 --tone --timeout 120`
   ※初回はモデル DL + ロードで数分かかる。`--timeout 120` 以上推奨
3. **Lab で会話**: `npm run dev` → `/moshi-lab.html` → Qwen URL プリセットで接続して話す。
   無音900msで自動確定、または「発話を確定」ボタンで commit
4. 問題なければ `MODAL_ENV=prod` で prod デプロイ → Mirage 本番は Qwen の prod URL へ

---

---

## ★ 明日やること（最優先）

### Phase 2 残作業: WS audio フレーム送信時の `protocol error 1002` を直す ✅ **完了 (2026-09-09)**

**症状**: WS 接続成功（initial `state: listening` 受信）→ 1 フレーム音声送信 → 即 `1002 protocol error` で切断。

**原因**: `server/websocket.py` でクライアントからの base64 データをデコードせず、またレスポンスも base64 エンコードせずに返していた。

**修正内容** (`server/websocket.py:1-37`):
- `base64.b64decode(msg["data"])` でデコードしてから `engine.step()` に渡す
- `base64.b64encode(audio_out).decode()` でエンコードして返却
- `try/except` で囲みエラーログ出力

**確認結果** (ローカルモック):
```
[test] connecting to ws://127.0.0.1:8000/ws
[test] initial: {'type': 'state', 'state': 'listening'}
[test] frame 0: audio response (3840 bytes PCM)
[test] frame 1: metrics={'type': 'metrics', 'input_to_inference_ms': 107.13, 'inference_to_output_ms': 0.33}
[test] frame 2: audio response (3840 bytes PCM)
[test] ping -> {'type': 'pong'}
[test] done
```

**次のステップ**: Modal staging へデプロイして実 GPU で検証（Phase 2 継続）

### Phase 2 残作業: protocol error 修正後

- [ ] Mirage 側 WS クライアント実装（Phase 4）
- [ ] prod App デプロイ（Phase 6）

---

## ★ 昨夜の成果（2026-09-07 → 2026-09-08）

- ✅ Modal アカウント作成・認証（workspace: `nakakou0123456789`）
- ✅ `moshi-model-cache` Volume 作成
- ✅ Moshi 0.2.13 の API 確定（`info.get_moshi()` + `info.get_mimi()` + `LMGen.step(codes)`）
- ✅ `pytorch_engine.py` を Moshi 0.2.13 対応に修正（`mimi.encode` / `lm_gen.step` / `mimi.decode` を使う形）
- ✅ A10G で Moshi 7B ロード成功（27秒、`vram 16GB / 24GB`）
- ✅ 1ステップ推論 **128ms**（`modal run scripts/smoke_moshi_full.py`）
- ✅ `/health` 200 OK
- ✅ WS 接続成功（`state: listening` 受信）
- ❌ WS audio 送信で 1002 protocol error

### App 状態（2026-09-08 01:xx 時点）

`moshi-backend-staging` 系の deployed App が 3 つ残ってるが、`scaledown_window=300` で 5 分 idle なら課金停止。明日起きたらまず `modal app stop -y` で整理する。

---

## 方針（再掲）

---

## ★ 方針切り替え（2026-09-07）

Lightning AI がよくわからないため、**Modal 一本化**に変更。

| 旧 | 新 |
|---|---|
| Lightning AI = 開発 / Modal = 本番 | **Modal = 開発 + 本番** |
| 環境分離 = 別クラウド | **環境分離 = staging / prod の別 App** |

### 役割分担（Modal 一本化後）

| 環境 | Modal App | 用途 |
|---|---|---|
| **staging** | `moshi-backend-staging` | Moshi 開発・実験・性能測定・Mirage 接続検証 |
| **prod** | `moshi-backend-prod` | Mirage 本番ユーザーが Moshi を動かす場所 |
| **Mirage** | （クライアント） | VRM 表示 / WS クライアント |

### 開発と本番の分離が重要な理由（継続）

開発中（コード変更・依存変更・CUDA 変更・クラッシュ）が **Mirage 本番に影響しない**ようにするため。
Modal 内で **staging App と prod App を別立て**にすることで、deploy の衝突と URL 切替で分離する。

### OpenCode でできる範囲

- ✅ `cloud/modal_app.py` / `cloud/modal_benchmark.py` / `cloud/README.md` の本実装
- ✅ ローカルモックでのサーバ・WS 動作確認
- ✅ Mirage 側 WS クライアント実装
- ❌ Modal アカウント作成 / `modal setup` / `modal deploy` 実行 / 実 GPU 推論

---

## 現状（2026-09-07）

### 完了

- [x] プロジェクト骨格（`moshi-backend/`）作成
- [x] README.md に Modal 一本化の方針・全体像・Phase 1〜7 記載
- [x] モックエンジン（`moshi_engine/mock_engine.py`）で GPU 不要起動確認
- [x] FastAPI + WebSocket サーバ雛形（`server/main.py`, `server/websocket.py`）
- [x] プロトコル定義（`server/protocol.py`）
- [x] セッション管理（`server/session.py`）
- [x] `moshi_engine/pytorch_engine.py` 実装（`MoshiEngineBase` IF、Moshi 公式 `LMGen`）
- [x] `engine.py` を `get_engine()` factory 化（mock / pytorch / candle）
- [x] `requirements.txt` ピン留め（moshi==0.2.13 / torch==2.5.1）
- [x] `Dockerfile` 本実装（Modal / 他クラウド共用）
- [x] `scripts/setup_modal.sh` / `setup_modal.ps1` 本実装
- [x] **`cloud/modal_app.py` 本実装**（staging/prod 両対応、Modal Volume キャッシュ、`/meta` 拡張）
- [x] **`cloud/modal_benchmark.py` 本実装**（`modal run` で latency/VRAM 測定）
- [x] **`cloud/README.md` 本実装**（デプロイ手順・GPU 表・環境変数）
- [x] **`scripts/test_modal_ws.py` 拡張**（--url / --frames 引数対応）
- [x] 1080Ti で Moshi が動かない検証（`docs/moshi-on-1080ti-report.md`）

### 既知の不整合・未着手

- Mirage 側 WS クライアント未着手（`src/` 側、Phase 4）
- MoshiEngine 内部のストリーミング最適化（複数フレームのバッチング等）は未着手
- `Modal Volume` の `create_if_missing=True` が初回 deploy 時の権限で失敗する可能性 → 必要なら手動で `modal volume create moshi-model-cache`

### ✅ 完了済み（2026-09-09 追加）

- WS audio `protocol error 1002` 修正（`server/websocket.py` base64 デコード/エンコード追加）
- ローカルモックでの WS 疎通確認（3フレーム送受信成功、Ping/Pong 成功）
- **Mirage 側 WS クライアント実装**（`src/hooks/useMoshiConversation.ts`, `src/hooks/moshiAudioProcessor.ts`）
  - WebSocket接続・再接続・状態管理（disconnected/connecting/listening/thinking/speaking/error）
  - AudioWorklet で 24kHz mono PCM フレーム（80ms/1920 samples）を低遅延キャプチャ
  - base64 エンコード送信 / デコード再生（WebAudio BufferSource）
  - プロトコル整合: `state` / `audio` / `metrics` / `error` 対応
  - TypeScript ビルド通過（`npm run build` 成功）

---

## フェーズ別 TODO

### Phase 2 — Modal (staging) で Moshi を GPU で動かす（**次の作業**）

#### ✅ 準備完了（OpenCode 側で実装済み）

- [x] `cloud/modal_app.py` / `cloud/modal_benchmark.py` / `cloud/README.md`
- [x] `scripts/setup_modal.sh` / `scripts/test_modal_ws.py`
- [x] `moshi_engine/pytorch_engine.py` 実装
- [x] `requirements.txt` ピン留め
- [x] Modal Volume によるモデルキャッシュ機構
- [x] **WS audio `protocol error 1002` 修正** (`server/websocket.py`)
- [x] **ローカルモックでの WS 疎通確認完了**
- [x] **Modal デプロイファイル確認完了**（`modal_app.py`, `modal_benchmark.py` 修正済み、`server/factory.py` 動作確認）

#### 🔲 ユーザー側で実行

- [x] **Modal アカウント作成** / **カード登録** / `modal setup` 済み
- [x] **Modal Volume** (`moshi-model-cache` 作成済み確認)
- [x] **古い staging App 3 件を `app stop -y` で整理** (2026-09-09)
- [x] **staging にデプロイ** (2026-09-09):
      `$env:MODAL_ENV="staging"; $env:MODAL_GPU="A10G"; python -m modal deploy cloud/modal_app.py`
      → `https://nakakou0123456789--moshi-backend-staging-serve.modal.run`
      ※ `--env` フラグは非対応。環境変数 `MODAL_ENV` で指定する
- [x] **動作確認** (2026-09-09):
      `/health` → `{"status":"ready","vram_used_mb":16240,"vram_total_mb":23028,"backend":"pytorch"}`
      `/meta` → `{"env":"staging","gpu":"A10G","model_repo":"kyutai/moshiko-pytorch-bf16","load_moshi":true}`
- [x] **WS 動作確認 (実 GPU)** (2026-09-09):
      `python moshi-backend/scripts/test_modal_ws.py --url wss://nakakou0123456789--moshi-backend-staging-serve.modal.run/ws --frames 5`
      → initial `listening` OK。frame 0 は timeout（初回推論 ~30s のコールドスタート）。
      frame 1 以降 audio 応答あり（3840 bytes PCM）。`input_to_inference_ms` 初回 29949ms → 2回目 144ms。
      ※ ping に対してキュー溜まりの audio が返ることがある（軽微、要調査）
- [x] **性能測定のブロッカー修正** (2026-09-10):
      `modal run cloud/modal_benchmark.py` の `ModuleNotFoundError: No module named 'cloud'` を修正。
      原因: `from cloud.modal_app import ...` がリモートで解決されない。
      対応: benchmark を自己完結化（image/Volume 定義を複製、pin は modal_app.py と同期）。
      旧 `main(gpu=...)` はデコレータ確定後に env を書き換える見せかけ API だったため削除。
      GPU 切替は `MODAL_GPU=L40S modal run cloud/modal_benchmark.py` で行う。
      モデルキャッシュがあれば DL スキップ。
- [ ] **性能測定の実行** (ユーザー側、staging 実 GPU):
      `MODAL_GPU=A10G modal run cloud/modal_benchmark.py --steps 50`
      → `step_ms.p95` が 80ms 以下ならリアルタイム予算内

#### 🔲 動作確認できたら

- [ ] Mirage 側 WS クライアント実装に進む（Phase 4）

### Phase 3 — リアルタイム対話の成立検証

- [ ] Mirage 側からの連続 PCM 送信 → Moshi 連続応答
- [ ] end-to-end 遅延測定
- [ ] ステート管理（listening / speaking）の整合

### Phase 4 — Mirage から Modal (staging) Moshi へ接続

- [x] Mirage 側 WS クライアント実装（`src/hooks/useMoshiConversation.ts` + `src/hooks/moshiAudioProcessor.ts`）
- [x] `server/protocol.py` と Mirage 側プロトコルの整合確認（base64 PCM, state: listening/thinking/speaking, metrics）
- [x] **サーバが thinking/speaking/listening を通知** (2026-09-10、`server/websocket.py`)。
      従来は初回 listening のみで、Mirage 側の thinking/speaking 遷移が死んでいた。
      切断系 RuntimeError のハンドリング追加。ping 遅延は単一ループの逐次処理が原因と明記。
- [x] **Mirage `connect()` の必敗バグ修正** (2026-09-10、`src/hooks/useMoshiConversation.ts`)。
      旧実装はクロージャの stale `state` をポーリング → 成功でも必ず timeout。
      初回 listening 到着で直接 resolve する方式に変更 + `stateRef` 追加 + `pong` ハンドリング + 再接続時の旧ソケット掃除。
      `tsc --noEmit` 通過。
- [x] **ローカルモックで WS 疎通確認** (2026-09-10):
      thinking → speaking → audio(3840B) → metrics → listening の順序確認、
      ping → pong 確認（残留 listening の drain 後に pong が返ることを確認）。
      `scripts/test_modal_ws.py` を新プロトコル対応（audio まで drain、ping 前 drain、pong まで読み飛ばし）。
- [x] `.env.example` に `VITE_MOSHI_WS_URL` を追加
- [x] **S2S単体テストUI** (2026-09-10、`moshi-lab.html` + `src/moshi-lab/MoshiLab.tsx`)。
      Avatarなし・WS直結で接続/無音フレーム送信/メトリクス/ログを確認できる。
      開き方: `npm run dev` → `http://localhost:5173/moshi-lab.html`。
      hook に `onMetrics`/`onAudio` 通知を追加（既存動作は不変）。
- [x] **サーバ側の鮮度対策** (2026-09-10、`server/websocket.py`)。
      A10G の step 約110ms がフレーム間隔 80ms を上回り、サーバ受信バッファに古いフレームが
      溜まって応答がどんどん古くなる（1023フレームで約30秒遅れ）問題に対応。
      処理前に即時受信分を最新だけ残して読み捨て（`dropped_stale_frames` を metrics に追加）。
      ローカルmockで疎通確認済み。**staging への再デプロイ待ち**。
- [ ] **staging 再デプロイ** (ユーザー側、1コマンド):
      `MODAL_ENV=staging` で `python -m modal deploy cloud/modal_app.py`。
      thinking/speaking 通知版・drain 版が載る。以降は Lab で会話再試行。
- [ ] Mirage から staging URL に WS 接続（Lab の URL 欄に `wss://...-serve.modal.run/ws` を入れて接続）
- [ ] 既存 `useConversation.ts` との切替統合（フォールバック戦略。次回作業の本命）

### Phase 5 — 実際の Mirage で音声対話

- [ ] 呼び込み → 会話 → 別れのフロー全体を Moshi だけで成立させる
- [ ] 既存 STT/TTS フォールバックとの切替ポイント整理

### Phase 6 — Modal (prod) デプロイ

- [ ] `modal deploy cloud/modal_app.py --env prod`
- [ ] staging と同じコードで prod が動くことを検証
- [ ] コールドスタート時間・コスト実測
- [ ] 監視・アラート設定

### Phase 7 — Mirage 本番化

- [ ] Mirage 側の WS エンドポイントを prod URL に向け替え
- [ ] スケール・セッション管理・ログ・監視を prod App で運用
- [ ] フォールバック戦略（AivisSpeech / Ollama）と Moshi の併用方針決定

---

## 未解決の疑問・要確認

- **Moshi のライセンス**: Mirage で商用利用可能か最終確認
- **HF トークン要否**: `kyutai/moshiko-pytorch-bf16` は public のはず（未確認）
- **量子化**: Modal の T4 / L4 で 24GB に収まらない場合の 4bit / 8bit 化
- **Audio I/O の責務**: 音声キャプチャは Mirage 側（WebAudio）かサーバ側か
  - 現状の `server/websocket.py` はサーバ側音声 I/O を前提にしているが、Modal にデプロイするとサーバにマイクをつなげない
  - **修正方向**: Mirage 側で音声キャプチャ → PCM を WS 送信 → Modal が PCM を受信して Moshi 推論 → 応答 PCM を返却
- **Volume 初回失敗**: `create_if_missing=True` の挙動を要確認
- ~~**ping に対してキュー溜まりの audio が返る**~~ → 原因特定済み (2026-09-10):
  サーバ側キューではなく、テストクライアントが残留 `listening` を読まずに ping 応答として拾っていただけ。
  `test_modal_ws.py` を drain + pong まで読み飛ばし対応し、ping → pong が正常に返ることをローカルで確認済み

---

## メモ：このファイルと README.md の使い分け

- `README.md` = **全体の設計・構成・クイックスタート**（新規参加者 / 面接で見せる用）
- `next.md` = **現状・次の TODO・未解決の疑問**（自分が開発を続ける用）

Phase が一段落するごとに両方を必ず更新する。