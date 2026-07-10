# 再開メモ

> 最終更新: 2026-07-03
> 方向確定: **AITuber受付嬢（呼び込み展示）**

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

## 現フェーズ（2026-07-02〜）: 機能追加を止めて「本番で人前に出せる状態」にする

会話ループ（呼び込み→接近で自動会話開始→STT/LLM/TTS→フォールバック）は完成。
ここからはMVP的に「壊れないこと」「見た目」を優先し、新機能は後回しにする。

### 優先順位順

> 2026-07-08更新: アニメーション（座る等）を最優先にする方針。クリーンアップ・リハーサルはその後。
> 2026-07-09更新: アニメーションの細部調整（座り腕の位置等）はBlender/実機確認が要るため出先では厳しいと判断。
> 家で時間がある時にまとめて詰める前提に変更し、それまではコードだけで完結する他タスクを進める。

1. **本番VRMモデルへの差し替え** ← ✅完了（2026-07-05）
   - VRoid Studio自作モデル（VRM1.0）に差し替え済み。`VRMUtils.rotateVRM0`はVRM0限定に条件分岐済み
   - `happy`/`surprised`/`aa`/`blink`等の標準プリセットは確認済み、コード側とそのまま噛み合っている
   - 方針転換の経緯: リアル系3D（TripoSG経由）は不気味の谷が出やすくリグも作りにくいため、メインキャラはVRoid（アニメ調・パラメトリック生成）に一本化。TripoSGは静的な小道具・背景用のサブパイプラインへ格下げ（詳細は下部「キャラクター構想」参照）

2. **アニメーション追加（座る等）** ← ✅完了（2026-07-10）
   - 歩行・発話ジェスチャー・部屋徘徊・接近/後退・座る（椅子まで歩く→着席→起立）まで実装済み
   - 座り中の腕の位置は本人が実機で解決済み。立ち上がり直後の腕の乱れバグも発見・修正済み（詳細は下記）

3. **展示本番用クリーンアップ** ← ✅完了確認（2026-07-09）
   - デバッグ用の小窓カメラ・HUD・手動呼び込み/停止ボタン群 → `debugMode`ゲートで全て隠れていることをPlaywrightで再確認（`prod_before_start.png`/`prod_after_start.png`相当）。開始前・開始後どちらもデバッグ要素の漏れなし
   - 会話ログ（チャットバブル）は`debugMode`に関わらず常時表示だが、これは来場者向けの字幕的機能として意図的な仕様と判断（意図的に隠す指示があれば別途対応）
   - 接近時の見切れ問題は前回セッションで対策済み（`Avatar.tsx`: Z移動を0.35に抑え、不足分は上半身の前傾`LEAN_MAX`で表現）。実機（実際のカメラ・照明）での最終確認のみ残課題
   - ~~`room.glb`未接続~~ ← 2026-07-08完了。`src/components/Room.tsx`として共通化し`App.tsx`本番シーンにも接続済み（Playwrightで見た目確認済み）。徘徊の`WANDER_BOUNDS`が前提にしているこの部屋がようやく本番でも見える状態に

4. **通しリハーサル** ← 未着手
   - 実際の会場・雑音環境に近い状態で「来場者役」に試してもらう
   - Groqのレート制限・会場Wi-Fi状況・ローカルフォールバックの実地確認もここで

5. 時間が余ったら「アイデア」節の差別化要素（手招き・空間オーディオ・視線を外すと構う等）に着手

---

## 詰める課題（接近演出）【✅対策済み・実機再確認のみ】

- 接近時にキャラのZ移動を`APPROACH_Z_FRONT=0.35`まで抑え、不足分は上半身の前傾（`LEAN_MAX`）で表現する方式で対応済み（`Avatar.tsx`）
- 計算上はカメラFOV35°・接近時距離2.65mで可視高さ約1.67m確保できており頭は収まるはずだが、実機での最終目視確認はまだ

---

## アニメーション実装

`@pixiv/three-vrm-animation` 導入済み。VRMAファイルを `public/avatar/` に置けば即実装可。

### 発話中のジェスチャー【✅完了・2026-07-05】
`Avatar.tsx`に手続き型で実装済み。喋り始めるたびに揺れの周波数・位相を再抽選し、
さらに不規則な間隔で左手/右手/両手からランダムに選んだ「バースト」（強調の身振り）を発生させる方式。
毎回同じリズムに見えないよう、常時の揺れは控えめにしてバーストで変化をつけている。

### 歩行アニメーション【✅ほぼ完成・2026-07-06】

Mixamo「Walking」FBX（In Placeチェック済み）→ Blender MCP経由でVRoidモデルにリターゲット → `public/avatar/walk.vrma`として書き出し → `Avatar.tsx`に統合。手動検証用に`playground.html`（`src/playground/Playground.tsx`）も新設、カメラ/LLM無しで距離ゾーン・発話・表情を手動トリガーして見た目だけ確認できる。

**やったこと（手順の記録）**
1. Mixamoから`X Bot@Walk.fbx`をダウンロード（Adobeアカウント無料、クレジット不要、In Place必須）
2. Blender 5.1.2に「VRM Add-on for Blender」を導入（Get Extensionsから検索インストール）
3. blender-mcp経由でVRoidモデル＋MixamoFBXを同一シーンに読み込み（`tools/walk_retarget.blend`に保存）
4. VRM1.0の`vrm_addon_extension.vrm1.humanoid.human_bones`から標準ボーン名を取得（推測でなく実データから対応表を作成）
5. 腰・両脚をCopy Rotation（**World空間**）でリターゲット
6. 背骨(spine/chest/upperChest)も同様にWorld空間でリターゲット追加（腰・脚と同じくAポーズ/Tポーズの差が小さいため）
7. 腕(上腕・前腕)は、MixamoがAポーズ・VRMがTポーズで基準姿勢が大きくズレるため、**Local/Local空間**のCopy Rotationでリターゲット（「自分の基準姿勢からの差分」を渡す方式なのでポーズ差を吸収できる）
8. 足首(Foot)にY軸±180°の誤オフセットバグを発見・データ補正で修正（Mixamo→VRMの座標変換に起因）
9. `nla.bake`（`temp_override`でcontext.area無しのMCP実行環境でも動くようパッチ）でMixamo依存を切り離し、`export_scene.vrma`でVRMA書き出し
10. Blenderのビューポートスクリーンショットでframe 1/8/16/24を実際に目視確認（脚と腕が正しく逆位相で振れている、肘の曲がりも自然）
11. `Avatar.tsx`側の手続き型ハック（腰カウンター回転・脚データからの疑似腕振り）を全撤去。spine/chest/腕とも歩行クリップ自体の実モーションで動く

**2026-07-06 追加バグ修正**
- `spine.rotation.x += ...`が毎フレーム無条件加算で無限蓄積し、上半身だけ折れ曲がる重大バグを修正（`=`の絶対代入に変更、歩行中は触らない設計に）
- 腕のワールド空間delta計算で乗算順序が逆だった（`rest.inverted() @ world`ではなく`world @ rest.inverted() @ target_rest`が正しい）バグを修正。上から見て腕が横に開かず体に沿うことを確認
- **エクスポート時に一部ボーンしか選択されておらず、未選択ボーン(脚・腰)が現在フレームの静止ポーズに凍結される**バグを発見・修正（全174ボーン選択してから再エクスポート、reimportで全ボーンが全フレーム動くことを確認）
- 「近づいて止まった後に前傾でお辞儀するように曲がる」演出(`LEAN_MAX`)が違和感が強いとのフィードバックで完全撤去

**残課題**
- ~~後退の見え方チェック~~ ← 2026-07-08、Playwright+スクリーンショットで`playground.html`を目視確認。徘徊・接近の歩行は自然。後退（`timeScale=-1`逆再生）は静止画1枚では足の接地が少し不自然に見えるコマがあった。同じクリップの逆再生なので体重移動が本来の後ろ歩きと異なる可能性あり、動いてる状態での目視確認はまだ（気になるようならMixamoの後ろ歩き専用クリップを別途検討）
- Mac側での実機確認（カメラ込みの人物検知→歩行トリガーの一連の流れ）

### 部屋シーン・徘徊・植物【2026-07-07実装】
`public/scene/room.glb`（Blenderで作成した部屋。机・椅子・観葉植物、いずれも簡易ジオメトリのプレースホルダー）を追加し、`Avatar.tsx`に「誰もいない間、部屋の中をランダムに歩き回る」徘徊ロジック（`WANDER_BOUNDS`/`WANDER_OBSTACLES`、机・椅子を障害物として回避）を実装。来場者を検知すると徘徊を中断し、位置・向きをlerpで滑らかに中央へ戻しながら既存の接近演出に合流する。
- 現状`Playground.tsx`にのみ`room.glb`をプレビュー読み込み（`RoomPreview`コンポーネント）。`App.tsx`本番シーンには未接続、コード内コメントに「採用が決まったら本実装に移す」とある通り採用可否の判断待ち
- 徘徊時の座標(`WANDER_BOUNDS`)・障害物座標はこの`room.glb`の実測レイアウトに直接依存しているため、部屋のモデルを差し替える場合はこれらの定数も要調整

| ファイル | 用途 | 状態 |
|---------|------|------|
| `walk.vrma` | 来場者検知→歩いてくる／徘徊／後退 | ✅腰・脚・背骨・腕すべてリターゲット済み |
| `sit.vrma` | 徘徊中に椅子へ座って一息つく | ✅腰・脚・背骨リターゲット済み（腕は手続き型で上書き） |
| `idle.vrma` | 誰もいない時のループ（お茶・伸び等） | アイデア段階 |

### 座るアニメーション【✅完了・2026-07-09】

Mixamo「Sitting Idle」→ Blender MCPでVRoidモデルにリターゲット → `public/avatar/sit.vrma`として書き出し → `Avatar.tsx`に統合。`room.glb`の椅子(`Chair_Seat`)に実際に歩いて座り、しばらくして立って徘徊に戻る行動をAI無しで自律実装した。

**Mixamoの取得はPlaywrightでブラウザ操作**（ヘッドありChromiumを起動しCDP経由で接続、ユーザーがログインだけ手動→検索・ダウンロード設定はこちらで自動操作）。Mixamoログインは対話操作が必要なため、ダウンロードだけ自分でやってもらう運用より、実際にブラウザを見せながら進める方がスムーズだった。

**リターゲット手順**
1. Mixamoから`X Bot@Sitting Idle.fbx`をダウンロード（Format: FBX Binary, Skin: With Skin, FPS: 30。座りモーションは元々その場に留まるため歩行と違いIn Placeオプション自体が出ない）
2. `tools/walk_retarget.blend`（歩行と同じファイル）にVRoidモデル＋座りFBXを読み込み
3. 腰・脚・背骨(spine/chest/upperChest)はWorld空間、**腕は今回リターゲットしない**（後述の理由でMixamoの腕モーションは使わず手続き型に切り替え）
4. 全ボーンで`nla.bake`（`only_selected=False`。選択ボーンだけだと`bpy.context.selected_pose_bones`が0件になりベイクが空振りするBlender 5.1.2の挙動を確認、`channel_types`未指定だと「ベイクする物がありません」で無言失敗する点にも注意）
5. `export_scene.vrma`で書き出し

**踏んだ落とし穴と直し方**
- **足首が180°逆を向くバグ（再発）**: 歩行の時と同じ「Mixamo→VRMの座標変換に起因」のバグ。今回はBlenderの`matrix_world`でMixamo・VRM双方の足ボーンのレスト姿勢をワールド空間で数値比較し、X軸が正確に反転していることを確認してから補正（World空間でY軸180°回転を後乗算）。目視だけで補正方向を決めると何度も逆に転がる（Local空間に変えたら悪化、補正方向を間違えて二重に壊れる、を繰り返した）ので、**感覚ではなく実際の回転行列を比較して補正量を決めるべき**という教訓
- **腕はMixamoモーションを使わず手続き型に変更**: 「Sitting Idle」クリップは前髪や髪を触るような手のジェスチャーが入っており不自然だった。Blender側で腕ボーンを外す（コンストレイント削除＋identityで再ベイク）→`Avatar.tsx`側で`isSitting`時に腕だけ固定ポーズを直接代入（後述のバグにより`lerp`では効かない）
- **`lerp`で腕を制御すると全く動かないバグ**: `createVRMAnimationClip`が対象にするのは`Normalized_*`という正規化ボーン（`vrm.humanoid.getNormalizedBoneNode`と同一オブジェクト）で、sitMixerが毎フレームこのボーンをidentityへ強制的に書き戻す。`lerp(現在値, 目標値, 係数)`で基準にしていた「現在値」がその都度identityへリセットされるため、何フレーム経っても目標に近づかない（6%ずつ0から動いて0に戻るだけ）。**Mixerが触るボーンを手続き型で上書きする時はlerpではなく直接代入（`rotation.set(...)`）でないと蓄積しない**
- **腕の回転軸が直感と違い調整に苦戦**: Z軸=T-poseから体側に下ろす動き、X軸=前後の振り、という基本は合っていたが、Euler回転順序(XYZ)の影響でXとZの値が独立に効かず、値を変えるたびに大きく姿勢が変わって収束しづらかった。最終的に「前に出す」調整は不安定なため断念し、**直立時と同じ`z=1.2, x=0.1`（体の横に自然に下ろす）に近い値へ落ち着けた**
- **座高が高すぎる**: MixamoとVRoid、双方の想定する椅子の高さが違うため、Hipsのワールド位置をそのまま使うと座面から浮く。`SIT_Y_OFFSET`（`Avatar.tsx`）でsitWeightに応じて沈める簡易対応
- **徘徊・着席移動中に机や椅子を貫通する**: 直進移動のみで障害物回避がなかったため。`avoidObstacles()`で近づいたら押し返す簡易ステアリングを追加。椅子へ向かう時は椅子自体を回避対象から除外（そこへ行きたいので）、机だけ避ける

**行動AI（コードのみ、LLM不要）**
`Avatar.tsx`に`chairState`（`roam`/`toChair`/`sitting`）を追加。徘徊の一時停止のたびに35%の確率で椅子へ向かい、着いたら6〜14秒座って起立→徘徊再開。来場者を検知したら（座っていても）中断して立ち上がりつつ中央へ戻る、という流れは徘徊→接近の既存の重みブレンド機構にそのまま乗せられた。

**残課題**
- 障害物回避は簡易的な反発ベースで経路探索はしていないため、配置によっては貫通が残る可能性

**座り中の腕の位置【✅本人が実機で解決・2026-07-10】**
Claude側のPlaywright確認と本人の実機で見た目が食い違っていた件は、本人が家のPC（Blender/実機が使える環境）で
Playgroundに「座り姿勢の調整」スライダー（腕前後・腕横・肘・肩前後・肩横、値をコピーするボタン付き）を追加し、
実際に目で見ながら数値を追い込んで解決。最終値は`SIT_ARM = { z: 1.34, x: -0.91 }`、`SIT_ELBOW = { z: 0.56 }`、
肩は`SIT_SHOULDER = { x: -0.25, z: 0.18 }`（`Avatar.tsx`の`DEFAULT_SIT_POSE`としてexport、`sitPoseRef`propで
Playgroundからライブ上書き可能）。Playwrightでの見た目確認が実機と食い違っていた根本原因は未特定のまま
（おそらくPlaywrightのスクリーンショット角度・ズーム由来の見え方の違い）だが、実機側の作り込みで解決済み。

**新規バグ: 座ってから立った直後、一瞬腕が変な方向に伸びる【✅修正・2026-07-10】**
本人が実機で発見。「座ってて立った直後」のスクリーンショットで片腕が横に伸びきって見える不具合。
- 原因1: 肩(shoulder)ボーンが`isSitting`分岐でしかリセットされておらず、「発話中」「歩行中」「それ以外」の
  各分岐では一切触られていなかった。一度座ると、その後ずっと肩だけ座り姿勢の角度に固定されたままになる
  実害のあるバグ（`Avatar.tsx`の該当3分岐すべてに肩リセットを追加して解消）
- 原因2（本命、Playwright+実際の回転値ログで特定）: three.jsの`AnimationMixer`は`effectiveWeight`が低い間、
  クリップの値と「バインド時点の元の姿勢」を重みで按分するが、その「元の姿勢」が期待していた
  基本姿勢（腕を下ろした状態）ではなくT-pose寄りの値になっていた。座り→歩行に遷移した直後は
  `walkWeight`が0から立ち上がる途中のため、腕が一瞬T-poseに近い水平位置まで伸びて見えていた
  （`console.log`で実際の`rArm.rotation`を5Hzで記録し、`walkWeight`と連動して値が変化する様子を確認して特定）
- 対策(第1弾): `isWalking`分岐にlerpベースの補正(`standPull`)を追加したが、本人から
  「座ってなくても、そもそも歩き始めの最初は毎回こうなる」と報告あり。実際に**一度も座らせず
  ページ読み込み直後の初回徘徊**をPlaywrightで連写して再現でき、座り→歩行に限らず
  **「isWalking が false→true に切り替わる瞬間全般」で起きる不具合**と判明。lerpによる緩和だけでは
  低fps環境や初回フレームで収束が間に合わないケースがあった
- 対策(第2弾・最終): `walkWeight < 0.25`の間は基本姿勢へ`.rotation.set()`で直接スナップし、
  閾値を超えたらlerpベースの`standPull`に切り替える二段構えに変更。Playwrightで(a)ページ読み込み直後の
  初回徘徊、(b)座る→立つ、両方を連写して改善を確認。歩行中の自然な腕振り自体は妨げていない
  （`walkWeight`が十分上がった後はスナップが発動しないため）

### 行動タグ（LLMが動きを選ぶ）システム【最小版✅完了・2026-07-08】
Blenderを使わずコードだけで完結する範囲でまず実装。「歩く/手を振る/頷く/腕組み/何もしない」の構想のうち、
`[nod]`（頷く）・`[tilt]`（首をかしげる）の2つを手続き型（neckボーンの一時回転）で実装。

- `useConversation.ts`: LLM応答ストリームの冒頭で`^\[(nod|tilt)\]`を検出・除去（`ACTION_TAG_RE`）。見つからなければ最大10文字待って諦める。検出したら`actionRef`に`{tag, id}`をセット、`id`はトリガーの度に増分（Avatar側は値の変化でなくid変化を見て新規トリガーと判定）
- `SYSTEM_PROMPT`にタグの使い方を一言追記（「絵文字・記号禁止」ルールの例外として明記しないとLLMが使ってくれないので注意）
- `Avatar.tsx`: `actionRef`のid変化を検知して0.7秒の単発モーション再生。**"head"ボーンはVRMのLookAt(視線追従)が毎フレーム上書きするため使えず、代わりに"neck"ボーンを使う**（three-vrm-coreのソースを`grep`し、LookAtが触るのは"headBone"のみと確認済み）
- `tilt`は左右どちらに傾げるかをトリガーの度に`Math.random()`でランダム決定（最初は右固定だったが偏りがあるとの指摘で修正）
- Playground.tsxに手動トリガーボタンを追加して動作確認（Playwright+スクリーンショットで頷き・首かしげ双方向の動きを目視確認済み）
- 残り（歩く/手を振る/腕組み等）は歩行同様Blenderでのリターゲットが必要なため、座るアニメーション等と合わせて後日

---

## キャラクター構想（3パターン）

> 2026-07-03 策定。リアル寄り3Dモデルで統一。img3d（**TripoSG**）→ Blender（テクスチャ・修正）→ GLB のパイプラインで生成。

| # | キャラ | 方向性 | 状態 |
|---|--------|--------|------|
| 1 | **女性（デフォルト）** | 呼び込み・陽気・コンカフェ系。現在の「レム」ポジション | 進行中 |
| 2 | **男性** | 要検討。爽やか系かクール系か未定 | 後回し |
| 3 | **「どしたん話聞こか」系** | 傾聴・共感特化。テンション低め・包容力系。呼び込みと真逆のLLMプロンプト | アイデア段階 |

- モデルスタイル: **リアル寄り3D**（アニメ寄りではなく）
- 生成パイプライン: 写真/イラスト → `img3d`（**TripoSG**+CUDA） → **Blender MCP**（テクスチャ・指修正） → GLB → Three.js
- キャラ3の差別化ポイント: 「話しかけてくる」でなく「話を聞いてくれる」。同じ技術で全く違う体験になる

### Blender MCPワークフロー（2026-07-05〜）
TripoSGは形状が優秀だがテクスチャなし・指がくっつくなどの問題がある。
自動テクスチャ投影はクオリティが出ないため、Blenderで手直しする方針。

- **Blender MCP** を使いClaudeがBlenderをPythonで直接操作
- 指の分離・メッシュ修正
- テクスチャ適用
- セットアップ: Blenderインストール + blender-mcp addon + Claude Code MCP設定（未着手）

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

1. **接近スピードへの反応（プロクセミクス）**【✅完了・2026-07-09】
   - `faceSize` の**変化速度**を見る。ゆっくり来る→何もしない、急に来る→「わっ、近い近い！」と驚くセリフ（`App.tsx`の`STARTLE_LINES`）
   - `prevFaceSizeRef`/`prevFaceSizeAtRef`で前回値との差分・経過時間から速度(faceSize/秒)を算出、`STARTLE_SPEED_THRESHOLD=0.35`超で発火。10秒クールダウン
   - 「仰け反る」等の物理アニメは今回未実装（発話のみ）。Blenderを使わない範囲でのスコープとして意図的に見送り。実機での閾値調整は必要

2. **接地・窓化で「本当にそこにいる」錯覚を完成させる**
   - 床の影・一貫したライティング・画面フチを“窓枠”として演出
   - Phase1 の視差は「窓」が信じられて初めて効く。接地感が土台

3. **手招き・身振りの呼び込み**（呼び込みコンセプトの核）
   - 遠い人に物理的に手招き（手を振る）。声だけでなく体で誘う＝キャッチらしさ

4. **空間オーディオ**【✅完了・2026-07-08】
   - 来場者が左にいれば声も左から。`useConversation.ts`の`speakAivis`に`StereoPannerNode`を追加（`source→panner→analyser→destination`）、`App.tsx`の`panRef`を150ms間隔で`faceCenterRef.x`から更新（`OffAxisCamera`と同じ符号規則、鏡像対応済み）。リバーブ・音量の距離減衰は未実装
   - `useConversation`のシグネチャが`(speakingRef, volumeRef, panRef?)`に変更。`panRef`省略時はセンター固定なので既存呼び出し側は壊れない

5. **視線を外すと構う**【✅完了・2026-07-08】
   - `useFaceDetection.ts`で`outputFacialTransformationMatrixes: true`を有効化し、主対象の顔変換行列からyawを抽出（`faceYawRef`、three.jsの`Matrix4.decompose`+`Euler(YXZ)`で算出）
   - `App.tsx`: mid/near接近中に`|yaw| > 0.5rad`が1.5秒継続したら「ねえねえ、こっち見てよ〜」系セリフ。会話中(`thinking`)や発話中には割り込まない、15秒クールダウンあり
   - 実機（実際の顔）でのyaw精度は未検証。Playwrightのフェイクカメラでは顔自体が検出されないため、クラッシュしないことのみ確認済み。行列が列優先/行優先どちらでも`|yaw|`の大きさ自体は変わらない（転置は回転を逆向きにするだけで角度の絶対値は保たれる）ため符号違いのリスクは低いが、実際の閾値(0.5rad)が適切かは要現地調整

6. **キャッチの人格を振り切る**【✅完了・2026-07-09】
   - 「視線を外すと構う」のセリフを`LOOK_AWAY_LINES_TIERED`（3段階配列）に変更。無視される回数が増えるほど軽い呼びかけ→拗ねる→可愛く食い下がる/開き直る、とエスカレートする
   - `lookAwayStreakRef`で今回の来場中の段階を保持、新規来場者（`isNewArrival`）でリセット
   - `SYSTEM_PROMPT`にも「塩対応されるほど構いたくなる（卑屈にはならない）」を一言追記し、LLM応答自体もこの気質を反映するように

7. **見つめ合いゲーム**【❌撤去・2026-07-09】
   - App.tsx自動発火→Playgroundコマンド起動制→Playground実カメラ対応、と方向転換を重ねた末に、本人の判断で機能ごと撤去。`gazeRatioRef`・虹彩ランドマーク計算(`computeGazeRatio`)も他に使い道が無いため`useFaceDetection.ts`から削除
   - 技術メモ（再挑戦する時のため）: MediaPipe FaceLandmarkerは追加ライブラリなしで478点（基本468点+虹彩10点）を常時返す（Tasks APIはlegacyのFaceMeshと違い`refineLandmarks`指定不要）。虹彩中心(468/473)と目の両端(33/133・362/263)から視線の水平比率を算出できる

### Playgroundに実カメラ・実会話を追加【✅完了・2026-07-09】
`Playground.tsx`は当初「カメラ・LLM無しで手動トリガーのみ」という設計だったが、見つめ合いゲーム等の
実データが絡む機能を精密にテストできないという指摘を受け、実カメラ・実会話を任意にON/OFFできる形に拡張。

- `useFaceDetection`に`enabled`引数を追加（デフォルト`true`でApp.tsx側は無変更）。Playgroundでは「カメラON」ボタンでこれを切り替える
- カメラON中は実検出値（顔中心・サイズ・向き・視線・表情・zone）をAvatarへの出力ref群に同期し、対応する手動コントロール（ゾーンボタン・笑顔/驚きスライダー）は自動的に無効化表示にする。カメラOFF中は今まで通り手動操作が効く（両方共存）
- `useConversation`をフル実装。「会話開始」ボタンでSTT→LLM→TTSの実会話ができ、ログ表示・状態表示（聴いてる/考え中/喋ってる）もApp.tsxの本番デバッグパネルと同等
- 行動タグ用の`actionRef`はLLM発火分（`useConversation`の内部連番）と手動ボタン発火分（`id: -Date.now()`で負数にして衝突回避）を同じrefで共有する設計に統一
- 実装中に見つけたバグ: `useEffect`の依存配列に`conv.actionRef.current`（refの中身）を直接指定していたが、ref変更はReactの再レンダリングを伴わないため検知されず事実上何も同期されない不具合があった。ref経由のブリッジをやめ、Avatarへ渡すactionRef自体を`conv.actionRef`に統一することで解消

### 物体検知・持ち物当てマジック【❌撤去・2026-07-09】
来場者の持ち物を検知して「心を読んでる」風に言い当てる演出として、YOLOv8n(`onnxruntime-web`)を導入・
Playground.tsxにコマンド起動モードとして実装したが、方向性の再検討の結果**機能ごと不要と判断し撤去**。
（キャラクター・会話シナリオ側の作り込みを優先する方針に変更したため）

- 撤去したもの: `src/hooks/useObjectDetection.ts`、`public/models/yolov8n.onnx`、`onnxruntime-web`依存、
  `vite.config.ts`のonnx関連設定（`assetsInclude`/`optimizeDeps.exclude`）、Playground.tsxのマジックモードUI一式
- 技術検証で分かったこと（再挑戦する時のためのメモ）:
  - YOLOv8nは`uv run --with ultralytics`で公式パッケージから直接エクスポートするのが確実（opset=12, simplify）
  - `onnxruntime-web`はwasmグルーコードの動的importがVite dev serverと衝突するが、**本番ビルド(`vite build`)では発生しない**上、`node_modules`から自動バンドルされるため自前でのwasmホスティングは不要（開発時だけCDNにフォールバックすれば足りる）
  - 出力形状`[1,84,8400]`（box4+COCO80クラス、objectness無し）のパース処理はPythonで素のonnxruntimeを使って先に検証してからJS移植する、という進め方が有効だった

### 会話シナリオ・来場者ジャーニー【2026-07-09見直し】
既存のセリフ群（呼び込みLINES/GROUP_LINES、NUDGE_LINES、LOOK_AWAY_LINES等）を並べて流れを確認したところ、
**離脱時に別れの一言がなかった**（4秒不在で無言のままリセット）という抜けを発見・修正。

- `App.tsx`に`FAREWELL_LINES`を追加。離脱（`AWAY_TIMEOUT_MS`超過）時、実際に会話ログがある場合のみ発話してからリセットする（呼び込みだけで素通りされた時は言わない）
- `hasLogRef`で`log.length > 0`をrefに同期して判定（setInterval側のクロージャがconvState変化時にしか再生成されず、`log`更新を都度拾えないための工夫）
- 現状の来場者ジャーニー全体:
  ```
  absent → far/mid/near: 呼び込み(LINES/GROUP_LINES、無視され続けるとエスカレート)
  急接近: STARTLE_LINESで驚く
  near: 会話自動開始
  会話中: LLM応答、視線を外すと構う、沈黙10秒でNUDGE_LINES
  離脱: 会話してたら一言挟んでからリセット(FAREWELL_LINES) ✅今回追加
  ```
- 展示ネタとしての「大学の研究展示であることのメタ的な受け答え」（何の展示？誰が作った？等）は`SYSTEM_PROMPT`のプロフィール/はぐらかし方針で一定カバーしているが、専用の想定問答集はまだ未整備。必要なら次の会話シナリオ強化テーマにする

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
- **Whisperハルシネーション対策【✅完了・2026-07-09】**: 誰も喋ってないのに「ご視聴ありがとうございました」等が出る不具合を確認。原因は空調ノイズ等の環境音が`SPEECH_THRESHOLD`をたまに超えてWhisperに送られ、無音・ノイズ入力に対してYouTube学習データ由来の定型文をでっち上げていたもの（Whisperの既知の癖）。2段構えで対策:
  1. `SPEECH_THRESHOLD` 18→28、`MIN_SPEECH_MS` 300→500に引き上げ、環境音での誤トリガーを抑制
  2. `WHISPER_HALLUCINATION_PATTERNS`（「ご視聴ありがとうございました」「チャンネル登録」等の定番フレーズ）にマッチしたSTT結果は`chat()`を呼ばず握り潰す。ただし「はい」「うん」等の短い相槌は普通の発話でも起こりうるためブロック対象に含めていない（今後も同様の誤爆が続くようなら閾値の追加調整で対応）

### キャラクター
- **名前**: レム
- **VRMモデル**: `public/avatar/sample.vrm`（暫定。本番はVRoid自作に差し替え）
- **システムプロンプト**: `src/hooks/useConversation.ts` の `SYSTEM_PROMPT`
  - コンカフェ・キャバ嬢系の陽気なキャッチ口調
  - ガハハ笑い、タメ口、相手をヨイショ、1〜2文以内

### 旧コード
`Scene` / `ParticleHuman` / `usePhoneScreen` / `useHandTracking` / `useSegmentation` は2026-07-02に削除済み（未使用の空中スマホ／パーティクル人体コンセプトの残骸。関連モデルファイルも削除）

---

## 3Dモデル生成（img3d）— **稼働中**

> 2026-07-03〜05: `tools/img3d/` にTripoSGパイプラインを構築・稼働確認済み。

再開する場合のメモ（判断済みの結論を詳しく残す）:

### 骨入れの方針: 手動Blenderはやらない、AIに任せる
教授いわく「3D生成は簡単、骨入れはBlenderでやったほうがいい」との助言。ただしGUIで手作業する意味ではなく、
元の`blender_rig.py`（縦棒ボーン3本＋高さで機械的に重み付けする自作の簡易ヒューリスティック）を、
学習済みモデルによるちゃんとした自動リグに置き換える方向で解決する。

- 候補: **RigAnything**（SIGGRAPH TOG 2025, テンプレート不要・任意ポーズ対応・推論2秒以下）
  - 公式実装: `github.com/Isabella98Liu/RigAnything`
  - 入出力: GLB/OBJ → リグ済みGLB。CUDA推奨だがCPUでも動作可、`bpy`ベースでBlenderアプリ不要
  - 未着手（cloneして繋ぐのは次のフェーズ）
- 参考（骨入れではなく動かし方の話）: VidAnimator (arXiv:2508.01878) — 実写動画からモーション転写する手法。Mixamoの既成モーションでは足りなくなったら参照

### 現フェーズだった: TripoSRのメッシュ生成クオリティ向上
骨入れは方針が決まった（AI任せ）ので後回しにし、まずは元となる3Dメッシュ自体の質を上げる方向で動いていた。

### 実行環境: MacではなくWindows(GTX 1080Ti)でやる方針に転換
M1 MacBook AirはGPUはあるがCUDA非対応（Apple GPUはそもそもCUDAというNVIDIA専用規格を実行できない）。
TripoSR/SF3D等のコードは`torch.cuda.is_available()`しか見ておらずMPS未対応のため、Mac上では常にCPU律速になる。
→ やるなら家のWindows機（**GTX 1080Ti, 11GB VRAM**）に作業を移す。11GBあれば以下がだいたい候補に入る:

- **Stable Fast 3D (SF3D)**: 6GB VRAM、TripoSRと同じStability AI製の後継、メッシュ品質+UV展開+マテリアル予測が強化。HFゲート付き（同意ボタンだけの即時パターン想定）
- **TripoSG**(VAST-AI＝TripoSRと同じ開発元): 8GB+ VRAM、ゲートなし、MIT license
- **InstantMesh**(TencentARC): ゲートなし、Apache-2.0、ただし多視点diffusion→再構成の2段構えでやや複雑
- ~~TRELLIS.2-4B~~（Microsoft, 24GB+ VRAM）は1080Tiでも厳しいので除外

`tools/img3d/`にあった内容（pyproject.tomlのMac向け修正、`to_gradio_3d_orientation`の向き補正）はMac専用の一時対応だった。ディレクトリごと削除済み。Windows機で再開する場合は元のrepoの構成（Linux/CUDA前提）にほぼ近いので、そのまま`uv sync`で通る可能性が高い。

`tools/img3d/`の内容（pyproject.tomlのMac向け修正、`to_gradio_3d_orientation`の向き補正）はMac専用の一時対応。Windows機でやる場合は元のrepoの構成（Linux/CUDA前提）にほぼ近いので、そのまま`uv sync`で通る可能性が高い。
