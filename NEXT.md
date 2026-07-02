# 再開メモ

> 最終更新: 2026-07-01
> 方向確定: **AITuber受付嬢（呼び込み展示）**
> ※ REQUIREMENTS.md はまだ旧コンセプト（空中スマホ）のまま — 後で改訂する

---

## プロジェクトの現方向

展示ブースで **VRMアバターが全身表示**され、カメラで人を検知したら
「ねえねえお兄さん話していかない？」と**人間味のある声で自動的に呼び込む**。

経緯: 空中スマホUI → 人体パーティクル → どちらも「画面の中で完結＝で何」で没。
ユーザーがオープンキャンパスで見たグダグダAITuberへの「もっとちゃんとやれよ」
という不満から着地。＝不満駆動で自分ごと。

こだわり3点（前のグダへのアンチテーゼ）: **全身が映る / 人間味の声 / 呼び込み**

段階方針: **A = 呼び込み＋ライト反応を隙なく完璧に → B = 双方向フリー会話**。いまA。

---

## 実装済み（A）

| 機能 | ファイル | 状態 |
|------|---------|------|
| VRM全身表示・まばたき・呼吸 | `src/components/Avatar.tsx` | ✅ |
| 音声＋リップシンク（簡易） | `src/App.tsx`（speechSynthesis） | ✅ 仮の声 |
| 人検知→自動呼び込み | `src/hooks/useFaceDetection.ts` + `App.tsx` | ✅ |

- アバター: `public/avatar/sample.vrm`（three-vrm公式サンプル＝仮。本番はVRoid自作キャラに差し替え）
- MediaPipeモデル: `public/mediapipe/`（顔検出 blaze_face_short_range）
- 動作確認: 「▶展示スタート」→カメラ許可→顔を外して戻ると自動呼び込み

---

## 差別化戦略（aituber-kitとの違い）

既存のaituber-kitは「配信画面の中にいる2Dキャラ」。
このプロジェクトは「展示空間に存在する3Dキャラ」として差別化する。

---

## 実装ロードマップ（差別化フェーズ）

### Phase 1 ─ Off-axis 3Dカメラ（最優先・最大差別化）【✅完了】
> 来場者の顔位置にカメラが追従 → フラットな画面が「3Dの窓」に見える（Johnny Lee方式）

- `faceCenterRef.x/y` → `camera.position` を ±lerp でリアルタイム更新
- `OrbitControls` を展示モードでは無効化
- 対象ファイル: `src/App.tsx`（Canvas カメラ制御）、`src/components/Avatar.tsx`

### Phase 2 ─ 距離推定 → 呼び込み強度変化【✅完了】
> BBサイズ（顔の大きさ）で遠近を判定し、モードを切り替える

- `useFaceDetection.ts` に `distanceRef`（BB面積から推定）を追加
- 遠い → 手招きアニメ＋大声呼び込み
- 近い → 会話モードへ遷移

### Phase 3 ─ 複数人対応 + 視線スキャン【✅完了】
> `faceCountRef`（すでにある）を使い切る

- 2人以上 → 「お二人ですね！」系セリフ
- 複数顔の間でlookAtTargetをスキャン

### Phase 4 ─ 来場者表情検出 → キャラ共感【✅完了】
> `@mediapipe/tasks-vision`（すでに導入済み）で笑顔スコアを取得

- 笑顔 → VRM `happy` 表情に反映
- 驚き → VRM `surprised` 表情に反映

---

### Phase 5 ─ 接近演出（キャラが近づいてくる）【✅完了・要調整】
> 距離ゾーンでキャラの Z 位置を lerp。遠い→奥で待機、近い→画面ぎわまで接近

- `Avatar.tsx` の `ZONE_Z`（absent -0.5 / far -0.2 / mid 0.5 / near 1.4）、`APPROACH_LERP=0.02`
- カメラ追従のX軸逆転バグも修正済み（鏡像表示に合わせ `fc.x - 0.5`）

---

## 午後やること（2026-07-02）

### 優先順位順

1. **動作確認・微調整**
   - 整列ポーズの腕角度が自然か（sample.vrmで確認。値は `Avatar.tsx` の `lArm.rotation.z = -1.2`）
   - 上半身前傾（近づいたとき覗き込む）が動いてるか確認
   - 停止ボタンの挙動確認

2. **会話機能（Phase B）実装**
   - Ollamaセットアップ（未インストールなら `brew install ollama`）
   - モデル選定: 日本語なら `gemma3:12b` か `qwen2.5:14b`
   - STT選定: **RealtimeSTT**（Python, VAD内蔵）か **Web Speech API**（ゼロ設定）か決める
   - Pythonサーバー立てて React から fetch（AivisSpeechと同じ構造）
   - 会話フロー: 呼び込み中→ジェスチャー/音声で会話モード切り替え

3. **本番VRMモデルに差し替え**
   - `public/avatar/sample.vrm` を差し替えるだけ
   - `surprised` 表情はVRoidStudioで追加しておく

4. **VRMAアニメーション（入手できたら）**
   - `idle.vrma` / `walk.vrma` を `public/avatar/` に置いて実装依頼

---

## 詰める課題（接近演出）

1. **接近時のズームで顔が画面外に見切れる** ← 最優先
   - 原因: perspective カメラに対しキャラを Z で手前に出すと、画角(FOV)が固定なので
     近づくほど巨大化してフレームアウトする（頭が切れる）
   - 対処案:
     - a) `near` の Z を控えめにする（1.4 → 0.8 程度）＋見切れ確認
     - b) 接近時はカメラの `fov` を広げる or カメラを少し引く（`position.z`↑）で全身を保つ
     - c) 「体ごとズーム」ではなく **上半身が寄る／前傾して覗き込む** モーションに変える
        （全身移動より自然。首・上体だけ前に出す）
     - d) 近距離では **腰から上フレーミング**（バストアップ）に構図を切り替える
   - ねらい: 「近づく」と「見切れる」を分離する。存在感は出しつつ頭は必ず収める

2. 展示用にデバッグUI（右上小窓・HUD・ボタン）を隠す/整理
3. **本番VRMモデル**に差し替え（今は three-vrm 公式サンプル）

---

## アニメーション実装（ファイル待ち）

`@pixiv/three-vrm-animation` 導入済み。VRMAファイルを `public/avatar/` に置けば即実装可。

| ファイル | 用途 | 状態 |
|---------|------|------|
| `idle.vrma` | 誰もいない時のループ（お茶・伸び等） | ファイル待ち |
| `walk.vrma` | 来場者検知→歩いてくる | ファイル待ち |

- 入手先: Booth / ニコニコ立体 / Mixamo(要変換) / BVH→VRMA変換
- 状態機械: absent→idle / far検知→walk→到着→呼び込み / near→立ち止まり
- ファイルが来たら Claudeに渡すだけで実装する

---

## アイデア（差別化・改善の種）

### アイドルの「生活感」＝ 空間に住んでいる演出
> 誰もいない時にキャラが勝手に生きている。展示の「窓の中に別世界」感を最大化

- **お茶を飲む / スマホを見る / 伸びをする / 鼻歌** などの微モーション
- 実装: 本格派は **VRMA（VRMアニメーション）ファイル**を用意して再生
  （`@pixiv/three-vrm-animation` は導入済み。VRoid/フリー素材/自作モーション）
- 簡易版: procedural（腕・首を sin 波、たまに視線を外す）でも「間」は作れる

### 俺(Claude)からの差別化提案 — aituber-kit が絶対やらない軸
aituber-kit は「配信画面の中の受動的な2Dキャラ」。こっちは「空間にいて先に動く3Dキャラ」。
"存在感" と "能動性" を突き詰めるほど差がつく。

1. **接近スピードへの反応（プロクセミクス）** ← 安い・高インパクト・誰もやってない
   - `faceSize` の**変化速度**を見る。ゆっくり来る→歓迎、急に来る→「わっ近い！」と仰け反る
   - 距離“量”でなく“来かた”に反応する＝生き物っぽさが跳ね上がる

2. **接地・窓化で「本当にそこにいる」錯覚を完成させる**
   - 床の影・一貫したライティング・画面フチを“窓枠”として演出
   - Phase1 の視差は「窓」が信じられて初めて効く。接地感が土台

3. **手招き・身振りの呼び込み**（呼び込みコンセプトの核）
   - 遠い人に物理的に手招き（手を振る）。声だけでなく体で誘う＝キャッチらしさ

4. **空間オーディオ**
   - 来場者が左にいれば声も左から。距離で音量・少しリバーブ→奥行きが耳でも出る

5. **視線を外すと構う**
   - ランドマークの顔向き（yaw）で「そっぽ向いた」を検知→「ねえ、こっち見てよ〜」

6. **キャッチの人格を振り切る**
   - 無視されるほど食い下がる／可愛く粘る、の演技段階。展示映えする“やり取り”になる

---

## その後（B）→ 実装済み・Groqに移行済み
- STT(Groq Whisper) → LLM(Groq Llama) → TTS(AivisSpeech) で双方向会話。ストリーミング化で低レイテンシ化済み

---

## 技術スタック

### フロントエンド
- **Vite + React + TypeScript**（Next.js不採用）
- **React Three Fiber + three-vrm** — VRM描画・SpringBone・表情
- **MediaPipe FaceLandmarker** — 顔検出・距離推定・blendshapes表情取得

### 会話システム（2026-07-02〜: ローカルOllama/faster-whisperからGroqに移行）
| 役割 | 使用技術 | エンドポイント |
|------|---------|--------------|
| **STT** | Groq Whisper `whisper-large-v3-turbo` | `/groq/openai/v1/audio/transcriptions`（Viteプロキシ経由） |
| **LLM** | Groq `llama-3.3-70b-versatile`（ストリーミング＋文単位TTS） | `/groq/openai/v1/chat/completions`（Viteプロキシ経由） |
| **TTS** | AivisSpeech（VOICEVOX互換） | localhost:10101 |

- APIキーは `.env.local` の `GROQ_API_KEY`（`.env.example`参照）。`vite.config.ts`のプロキシがサーバー側で付与するのでブラウザJSには出さない
- 無料枠: `llama-3.3-70b-versatile`は1000req/日・12000トークン/分（2026-07-02時点、要確認）
- LLMモデルは `src/hooks/useConversation.ts` の `GROQ_CHAT_MODEL` を変えるだけで切り替え可
  - 現在: `llama-3.3-70b-versatile`（gemma2はGroqで廃止済み）
  - 代替: `llama-3.1-8b-instant`（最速・無料枠の日次上限も広い）/ `openai/gpt-oss-120b`（最大だが会話向きではなさそう）
- STT精度が甘い場合は `GROQ_STT_MODEL` を `whisper-large-v3`（turboでない方、やや遅いが精度最大）に
- **オフライン用フォールバック**（ネット不通時）: `stt_server.py`（faster-whisper `small`、要`.venv`）+ Ollama `gemma2`が残置してある。`useConversation.ts`をOllama版に戻せば復帰可能

### キャラクター
- **名前**: レム
- **VRMモデル**: `public/avatar/sample.vrm`（暫定。本番はVRoid自作に差し替え）
- **システムプロンプト**: `src/hooks/useConversation.ts` の `SYSTEM_PROMPT`
  - コンカフェ・キャバ嬢系の陽気なキャッチ口調
  - ガハハ笑い、タメ口、相手をヨイショ、1〜2文以内

### 旧コード（退役・未使用・掃除予定）
`Scene` / `ParticleHuman` / `usePhoneScreen` / `useHandTracking` / `useSegmentation`
