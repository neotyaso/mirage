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

### Phase 1 ─ Off-axis 3Dカメラ（最優先・最大差別化）【着手中】
> 来場者の顔位置にカメラが追従 → フラットな画面が「3Dの窓」に見える（Johnny Lee方式）

- `faceCenterRef.x/y` → `camera.position` を ±lerp でリアルタイム更新
- `OrbitControls` を展示モードでは無効化
- 対象ファイル: `src/App.tsx`（Canvas カメラ制御）、`src/components/Avatar.tsx`

### Phase 2 ─ 距離推定 → 呼び込み強度変化
> BBサイズ（顔の大きさ）で遠近を判定し、モードを切り替える

- `useFaceDetection.ts` に `distanceRef`（BB面積から推定）を追加
- 遠い → 手招きアニメ＋大声呼び込み
- 近い → 会話モードへ遷移

### Phase 3 ─ 複数人対応 + 視線スキャン
> `faceCountRef`（すでにある）を使い切る

- 2人以上 → 「お二人ですね！」系セリフ
- 複数顔の間でlookAtTargetをスキャン

### Phase 4 ─ 来場者表情検出 → キャラ共感
> `@mediapipe/tasks-vision`（すでに導入済み）で笑顔スコアを取得

- 笑顔 → VRM `happy` 表情に反映
- 驚き → VRM `surprised` 表情に反映

---

## 次にやること（Aの仕上げ）

1. **Phase 1 実装** ← いまここ
2. **人間味の声**: AivisSpeech 導入済み（`localhost:10101`）、音量ベースリップシンク実装済み
3. 呼び込みの演出（手を振る・表情）
4. 展示用にデバッグUI（右上小窓・HUD・ボタン）を隠す/整理
5. 待機状態（誰もいない時）のアイドル挙動

## その後（B）
- STT(Whisper) → LLM(Ollama) → TTS(AivisSpeech) で双方向会話

---

## 技術メモ
- フロント: Vite + React + R3F + three-vrm（**Next.js不採用**）
- AIの脳・声は **Python ローカルサーバーを React から fetch 直叩き**
  （VOICEVOX/AivisSpeech は localhost にHTTP APIを持つ）
- 旧コード（`Scene` / `ParticleHuman` / `usePhoneScreen` / `useHandTracking`
  / `useSegmentation`）は退役・未使用（掃除予定）
