import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { useFrame } from "@react-three/fiber";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { VRM, VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";
import { VRMAnimationLoaderPlugin, createVRMAnimationClip } from "@pixiv/three-vrm-animation";
import type { VRMAnimation } from "@pixiv/three-vrm-animation";
import * as THREE from "three";
import { getDistanceZone } from "../hooks/useFaceDetection";
import type { FaceCenter, FaceExpression, DistanceZone } from "../hooks/useFaceDetection";

const MODEL_URL = "/avatar/sample.vrm";
const WALK_URL = "/avatar/walk.vrma";

// 口隠しパッチ(hideMouthLine)のneckボーン静止姿勢での基準オフセット。
// neckが回転(nod等)している間は、この基準位置をneckの現在の回転で逆補正して
// 位置・向きを維持する(単に子として乗せるだけだと回転の弧を描いてズレてしまうため)
const MOUTH_PATCH_Y = 0.09;
const MOUTH_PATCH_Z = 0.088;

// 単発ジェスチャー(Mixamoからリターゲットしたフルボディの手続き型ではない本物のモーション)。
// walkと違い「常時ループして重みだけ変える」のではなく、トリガーの度に最初から1回再生する
type GestureTag = "stretch";
const GESTURE_URLS: Record<GestureTag, string> = {
  stretch: "/avatar/stretch.vrma",
};
// クリップの入り/抜けにかける時間(秒)。歩行と同じ理由(重みが低い間はbind pose寄りに流れる)で
// 腕だけは低weightの間、基本姿勢へスナップする
const GESTURE_FADE_S = 0.25;
const GESTURE_ARM_SNAP_THRESHOLD = 0.3;

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
// タブがバックグラウンドで長時間放置されると次にフォアグラウンドに戻った瞬間のdeltaが
// 数秒単位に膨れ上がり、AnimationMixerのクリップ時間が一気に飛んで(ジェスチャーが一瞬で
// 終了直前まで進む等)、フリーズしたように見える不具合があった。1フレームあたりの経過時間を
// 上限でクランプし、以降のlerp/mixer.updateすべてに波及しないようにする
const MAX_DELTA_S = 1 / 20;
// 角度の最短経路補間(-π〜π境界をまたぐ時に大回りしないようにする)
function lerpAngle(a: number, b: number, t: number): number {
  let diff = ((b - a + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
  return a + diff * t;
}
// 「1フレームあたりrate60ずつ近づける」という60fps前提の率を、実際のdelta(秒)に応じた
// 率へ変換する。気づき演出の振り向き/視線ロックは音声合成等と同時に走ってフレームレートが
// 落ちやすく、delta非依存のまま低fps下だと「演出時間内にほとんど回転しない」ことがあった
// （フレーム数そのものが足りないため）。実時間で収束速度を保証するために使う
function damp(rate60: number, delta: number): number {
  return 1 - Math.pow(1 - rate60, delta * 60);
}

export interface AvatarProps {
  speakingRef?: MutableRefObject<boolean>;
  volumeRef?: MutableRefObject<number>;
  faceCenterRef?: MutableRefObject<FaceCenter | null>;
  eyeCenterRef?: MutableRefObject<FaceCenter | null>;
  allFaceCentersRef?: MutableRefObject<FaceCenter[]>;
  allEyeCentersRef?: MutableRefObject<FaceCenter[]>;
  expressionRef?: MutableRefObject<FaceExpression>;
  faceSizeRef?: MutableRefObject<number>;
  // 行動タグ(useConversation.ts)。idが変わるたびに新規トリガーとして扱う。
  // "glance"はLLM/自動トリガーの通常フローには乗らず、Playgroundの手動デモ発火専用
  actionRef?: MutableRefObject<{ tag: "nod" | "tilt" | "surprise" | "stretch" | "beckon" | "glance"; id: number } | null>;
  // デバッグ用「⏸ 停止」ボタンでtrueになる。歩行・接近/徘徊などの移動だけを止めて
  // その場に固まらせる（瞬き・呼吸・リップシンク等の待機アニメは止めない）
  paused?: boolean;
  // 会話中(convState !== "idle")はtrue。話している最中に来場者の姿勢のわずかな変化で
  // 距離ゾーンがmid/near間を行き来し、勝手に歩き出す/後ずさりするのを防ぐため、
  // 会話中は接近/徘徊の位置更新を止める（頷く等の身振りは止めない）
  conversing?: boolean;
  // 手招みポーズのライブ上書き（Playgroundのスライダー用）。未指定ならDEFAULT_BECKON_POSE
  beckonPoseRef?: MutableRefObject<BeckonPose>;
  // チラ見パラメータのライブ上書き（Playgroundのスライダー用）。未指定ならDEFAULT_GLANCE_PARAMS
  glanceParamsRef?: MutableRefObject<GlanceParams>;
  // 「意味のある徘徊」パラメータのライブ上書き（Playgroundのスライダー用）。未指定ならDEFAULT_ANCHOR_GAZE_PARAMS
  anchorGazeParamsRef?: MutableRefObject<AnchorGazeParams>;
  // Playground手動デモ発火専用: idが変わるたびに、徘徊中でなくても即座に指定の目的地(窓/プラント)へ
  // 向かわせる（本番の自動抽選フローには乗らない。チラ見の"glance"手動発火と同じパターン）
  forceAnchorRef?: MutableRefObject<{ key: WanderAnchorKey; id: number } | null>;
  // Playground手動デモ発火専用: 気づいた瞬間の体の向きを強制指定してから気づき演出を発火する
  // （振り向き3パターンをそれぞれ単独でテストできるようにするため）
  forceNoticeRef?: MutableRefObject<{ tier: "front" | "side" | "back"; id: number } | null>;
  // 読み込むVRMファイルのパス。未指定ならレム本体のMODEL_URL(sample.vrm)を使う。
  // 「どしたんモード」等、別ページで別のアバターを表示するための拡張点
  modelUrl?: string;
  // trueなら口が関わる表情(リップシンク/happy/surprised)を一切動かさない。
  // マスク装着モデルは口を動かすとマスクのテクスチャが裂けて見えるため、
  // 「どしたんモード」で無効化する(まばたきなど口以外の表情は生かす)
  disableLipSync?: boolean;
  // trueなら口の位置(neckボーンからの相対位置)に薄い黒パッチを追加する。
  // マスクより口のポリゴンが手前に来て、閉じた口の線がマスク越しに透けて見えるため、
  // その一点だけを覆って隠す(disableLipSyncとセットで使う想定)
  hideMouthLine?: boolean;
  // 頷き(nod)でneckを倒す角度(ラジアン)。未指定ならNOD_ANGLE(0.35=約20°)。
  // マスク装着モデルは大きく倒すほどheadのLookAt追従が追いつかず口元に隙間が
  // 見えるため、「どしたんモード」では小さめの値を渡して首だけの控えめな
  // 頷きにする
  nodAngle?: number;
  // trueなら「奥から歩いて近づく」演出を飛ばし、最初から接近済みの位置に固定して表示する。
  // 「どしたんモード」は机上アップ想定で歩かせる必要がなく、歩行中に口隠しパッチ等の
  // 位置がずれて見える問題も避けられる
  startSettled?: boolean;
}

// 距離ゾーン別の「接近度」0〜1。ここから Z移動量と前傾を導く
const ZONE_APPROACH: Record<DistanceZone, number> = {
  absent: 0,    // 誰もいない → 奥で待機
  far: 0.15,    // 遠くにいる → まだ奥
  mid: 0.5,     // 気づいて少し前へ
  near: 1.0,    // 目の前 → 覗き込む
};
const APPROACH_LERP = 0.02; // 近づく速さ（小さいほどゆっくり優雅に）

// 体ごとの前後移動は控えめに（大きくすると頭が見切れる）
const APPROACH_Z_BACK = -0.4;  // 接近度0：奥で待機
const APPROACH_Z_FRONT = 0.35; // 接近度1：少しだけ手前

// 誰もいない間、部屋の中をランダムに歩き回る(「生活感」演出)。
// 範囲はBlenderで作った部屋(public/scene/room.glb)の実測レイアウトに合わせた値。
// 奥右コーナー(x=1.82, z=-1.78付近)に観葉植物(DecoPlant)を置いているため、
// 個別の障害物回避はせずxMax/zMinをその分小さくしてキャラが近寄らないようにしている
const WANDER_BOUNDS = { xMin: -1.5, xMax: 1.2, zMin: -1.3, zMax: 0.5 };
const WANDER_SPEED = 0.35; // m/s
const WANDER_ARRIVE_DIST = 0.12;
const WANDER_PAUSE_MIN = 2;
const WANDER_PAUSE_MAX = 5;
// 徘徊の一時停止のたびに低確率でこのどれかを挟む(「ただ突っ立ってるだけ」を防ぐ生活感演出)
const IDLE_GESTURE_CHANCE = 0.4;
const IDLE_GESTURE_TAGS = ["stretch", "nod", "tilt"] as const;

// 「意味のある徘徊」: 完全ランダムな徘徊点の代わりに、低確率でこの2つの目的地(窓/プラント)
// のどちらかへ向かわせる（NEXT.md「徘徊を意味のある行動に変える」参照）。
export type WanderAnchorKey = "window" | "plant";
// 実際に歩いて行ける床座標(WANDER_BOUNDS内)。窓はWindow.tsxのWIN_POS(x=0,z=-1.98)の手前・
// 徘徊範囲の奥ギリギリ(zMin付近)。プラントは実物(コメント上部参照、x=1.82,z=-1.78=範囲外の
// 障害物)へ近寄りすぎず、WANDER_BOUNDS内でそれらしい立ち位置(x=1.1,z=-1.1)を使う
const WANDER_ANCHORS: Record<WanderAnchorKey, { x: number; z: number }> = {
  window: { x: 0, z: -1.25 },
  plant: { x: 1.1, z: -1.1 },
};
// 到着後に向く先(視線・胸/首のヨー計算用のワールドXZ)。上のWANDER_ANCHORS(足を止める床位置)
// とは別に、実物自体の位置(窓=外を眺める先、プラント=葉を見下ろす先)を使う
const ANCHOR_LOOK_WORLD: Record<WanderAnchorKey, { x: number; z: number }> = {
  window: { x: 0, z: -1.98 },
  plant: { x: 1.82, z: -1.78 },
};

function pickWanderTarget(anchorChance: number): { x: number; z: number; anchor: WanderAnchorKey | null } {
  if (Math.random() < anchorChance) {
    const key: WanderAnchorKey = Math.random() < 0.5 ? "window" : "plant";
    const p = WANDER_ANCHORS[key];
    return { x: p.x, z: p.z, anchor: key };
  }
  const x = lerp(WANDER_BOUNDS.xMin, WANDER_BOUNDS.xMax, Math.random());
  const z = lerp(WANDER_BOUNDS.zMin, WANDER_BOUNDS.zMax, Math.random());
  return { x, z, anchor: null };
}

// 目的地(窓/プラント)に着いた時の振る舞い。Playgroundでライブ調整できるよう、値は定数でなく
// オブジェクトにする(手招みポーズ・チラ見と同じ方式)
export interface AnchorGazeParams {
  chance: number;      // 徘徊の目標を選び直す時、完全ランダムの代わりにこの確率でどちらかの目的地へ向かう
  lingerMinS: number;  // 到着後に留まる秒数(最短)。通常の徘徊停止(WANDER_PAUSE_MIN/MAX)より長くして「用があって来た」感を出す
  lingerMaxS: number;  // 同(最長)
  neckMax: number;     // 向き直る時の首の最大ヨー(チラ見と同じ胸→首の分担方式)
  chestMax: number;    // 同・胸
  turnLerp: number;    // 向き直る速さ
  pitch: number;       // 縦の傾き(ラジアン)。プラントではこの値だけ見下ろし、窓ではこの値だけ見上げる
}
export const DEFAULT_ANCHOR_GAZE_PARAMS: AnchorGazeParams = {
  chance: 0.35, lingerMinS: 4, lingerMaxS: 7, neckMax: 0.5, chestMax: 0.45, turnLerp: 0.12, pitch: 0.12,
};

// 表情は中間値を使わず二値判定（しきい値以上でON=1、未満でOFF=0）
const SMILE_THRESHOLD = 0.3; // 仮値。低いと真顔でも笑顔判定されやすい→playgroundで要調整
const SURPRISED_THRESHOLD = 0.69; // 計測値。これ未満は誤検出扱い

// 歩行中の上下バウンス(体重移動)。回転のみリターゲットしているため位置側は手続き型で補う
const WALK_BOB_AMOUNT = 0.012;

// 発話中: 腕を交互に上げる仕草は不自然だったので撤去。腕は基本姿勢のまま、体の横揺れのみで表現する
const SWAY_AMOUNT = 0.1; // ラジアン。胸を左右にひねる横揺れの振幅

// 行動タグ由来の手続き型アクション（頷く／首をかしげる）。頭のボーンを一時的に動かして戻すだけの単発モーション
const ACTION_DURATION_S = 0.7;
const NOD_ANGLE = 0.35;  // ラジアン。頭を下げる角度
const TILT_ANGLE = 0.3;  // ラジアン。頭を傾ける角度

// 手招き(procedural): 「やあ！こっち！」と手を振る呼び込み動作。
// Mixamoリターゲット(Blender)を避け、右腕・肘・手首の回転を直接算出する手続き型で実装する。
// 棒立ちで腕全体を振るのでなく、肘を曲げて手のひらを来場者に向け、前腕〜手をゆっくり振る自然なwave。
// 入り(ramp up)→保持(手を振る)→抜け(基本姿勢へ)の台形エンベロープ
const BECKON_IN_S = 0.4;
const BECKON_HOLD_S = 1.7;
const BECKON_OUT_S = 0.45;
const BECKON_DURATION_S = BECKON_IN_S + BECKON_HOLD_S + BECKON_OUT_S;
// 手招みのポーズ値。Playgroundのスライダーからライブ上書きできるよう、定数でなくオブジェクトにする
// （座り/伸びポーズと同じ方式）。App本番はDEFAULTがそのまま使われる
export interface BeckonPose {
  armZ: number;      // 上腕の上下（基本1.2=下ろした状態→負で水平より上へ）
  armX: number;      // 上腕の前後（正で前へ）
  elbowZ: number;    // 肘の曲げ（大きいほど深く曲がる）
  foreTwist: number; // 前腕のひねり（手のひらの向き。rElbow.y）
  handRoll: number;  // 手首のひねり（手のひらの向き微調整。rHand.z）
  sway: number;      // 手を振る振幅（上腕を左右に振る）
  hz: number;        // 手を振る速さ(Hz)
  shoulderZ: number; // 肩の持ち上げ
}
export const DEFAULT_BECKON_POSE: BeckonPose = {
  armZ: -0.96, armX: 0.22, elbowZ: -0.66, foreTwist: 1.1, handRoll: -1.26, sway: 0.38, hz: 0.68, shoulderZ: 0.22,
};
// 棒立ち回避: 手を振る間の上体のゆるい揺れ・わずかな前傾（呼び込む姿勢）
const BECKON_BODY_SWAY = 0.05;      // 胸の左右揺れ
const BECKON_LEAN = 0.06;           // わずかに前傾

// 来場者を検知した瞬間の「気づき」演出（その場でピタッ→正面へ振り向く→驚き→笑顔→手招き）。
// このコンセプトの心臓部: 自分の生活をしていた子が"あなた"に気づく瞬間を明確なドラマにする
const NOTICE_DURATION_S = 2.0;      // 演出全体の長さ（手招きと揃える）
const NOTICE_ABSENT_MIN_S = 1.0;    // これだけ「不在」が続いた後の検知だけを新規来場とみなす（顔検出のチラつき再発火を防ぐ）
const NOTICE_COOLDOWN_S = 8.0;      // 連続発火防止
const NOTICE_SURPRISE_S = 0.45;     // 最初のこの秒数は surprised、その後 happy に切り替え
const NOTICE_TURN_LERP = 0.16;      // 振り向きの速さ（通常の接近時より速くピボットさせ「ハッと振り向く」印象に）
const NOTICE_GAZE_LERP = 0.2;       // 気づいた瞬間は視線を素早く来場者にロックする（普段は下記の緩やかな値）

// 気づいた瞬間の体の向きによって振り向き方を3パターンに分ける（一律で同じ速度で正面へ回すと、
// 「もう正面向いてる時」まで無駄に体を揺らしたり、「真後ろ向いてる時」の瞬間スピンが不自然だったため）
const NOTICE_YAW_FRONT_MAX = Math.PI / 4.5;  // 約40°以内=もう大体こっち向いてる→体は回さず首の反応だけ
const NOTICE_YAW_BACK_MIN = Math.PI * 0.78;  // 約140°以上=背中向き→通常より速く勢いよく振り向く
const NOTICE_TURN_LERP_BACK = 0.28;          // 背中向きから気づいた時の振り向く速さ（通常より速い）
const NOTICE_FRONT_PITCH = 0.14;             // 正面向きで気づいた時、首だけで見せる上目遣いの角度(ラジアン)
const GAZE_LERP = 0.08;             // 通常時の視線追従の滑らかさ（0.06→0.08で少し「吸い付く」感）
// 視線のサッケード（微小な揺らぎ）: 目標にピタッと固定すると人形っぽく死んで見えるので、
// lookAtの目標に小さなランダムオフセットを不規則な間隔で乗せて「生きてる目」にする
const SACCADE_X = 0.07;             // 横の揺らぎ幅（lookAt空間）
const SACCADE_Y = 0.045;            // 縦の揺らぎ幅
const SACCADE_MIN_S = 0.5;          // 次の揺らぎまでの最短
const SACCADE_MAX_S = 1.9;          // 同・最長
// 首の追従: 目/頭のLookAtに加えて首(neck)も来場者へ向ける＝「ぬるっと吸い付いて追う」の肝。
// 首が向き全体の一部だけをこなし、残りは目/頭のLookAtが補う（首が回りすぎると不自然なため）
const NECK_FOLLOW_FRAC = 0.55;      // 首がこなす向きの割合
const NECK_FOLLOW_MAX = 0.42;       // 首の最大ヨー(ラジアン、約24°)。振り向きすぎ防止
const NECK_FOLLOW_LERP = 0.09;      // 首追従の滑らかさ

// 「チラ見」演出: far(検知はできるがまだ気づき演出には入らない距離)にいる間、
// 通常時の首追従(NECK_FOLLOW_MAX/LERPで常時ゆるく効いている)だけだと角度が浅く動きも
// 遅いため、遠目には「見られてる」と気づきにくい。そこで不規則な間隔で一瞬だけ首を
// 大きく・素早く来場者へ向けてすぐ戻す「ハッ→視線を外す」を挟み、歩き（徘徊）は止めずに
// 続けたまま「今、目が合った？」という体感を作る。気づき演出(noticing/beckoning)には
// 昇格させない＝まだ気づいてないフリを保ったまま、視線だけ一瞬お漏らしする作戦
// Playgroundでライブ調整できるよう、値は定数でなくオブジェクトにする（手招みポーズと同じ方式）
export interface GlanceParams {
  durationS: number;    // 一回のチラ見の長さ
  intervalMinS: number; // 次のチラ見までの間隔（最短）
  intervalMaxS: number; // 同（最長）。ランダムにして機械的に見せない
  neckMax: number;      // チラ見中の首の最大ヨー(ラジアン)。通常追従より深く回す
  lerp: number;         // チラ見の首の振り向き速さ（通常より素早く「ハッ」とさせる）
  // 徘徊が「歩いている→止まった」瞬間は、立ち止まってふと振り返る動きとして特に自然に見える
  // タイミングなので、この確率でランダムタイマーを待たずにチラ見を前倒しで誘発する
  pauseChance: number;
  // 体(胸)が来場者の方をどれだけ一緒にひねるか(ラジアン)。首だけでは最大43°程度が限界で、
  // 体が真後ろ(180°)を向いている時は首を振っても来場者側にほぼ届かず「チラ見」に見えない
  // （実際に人が肩越しに振り返る時も、首だけでなく上半身をひねっている）。
  // 胸→首の順で角度を分担する(胸が回した分だけ首の負担が減る)ので、合計でneckMax+chestMaxまで回せる
  chestMax: number;
}
export const DEFAULT_GLANCE_PARAMS: GlanceParams = {
  durationS: 0.8, intervalMinS: 3.5, intervalMaxS: 8.0, neckMax: 0.75, lerp: 0.22, pauseChance: 0.6, chestMax: 0.55,
};

/**
 * VRMアバターを全身表示する。
 * - まばたき（ランダム間隔）
 * - 軽い呼吸モーション
 * - 発話中のリップシンク（簡易: 口を波で開閉）
 * - SpringBone / 表情の毎フレーム更新（vrm.update）
 *
 * いまのリップシンクは音声波形に同期しない簡易版。
 * 人間味TTS（VOICEVOX等）導入時に音量ベースの本物に差し替える。
 */
// 複数人いる時に視線を切り替えるインターバル（ms）
const SCAN_INTERVAL = 2500;

export function Avatar({ speakingRef, volumeRef, faceCenterRef, eyeCenterRef, allFaceCentersRef, allEyeCentersRef, expressionRef, faceSizeRef, actionRef, paused, conversing, beckonPoseRef, glanceParamsRef, anchorGazeParamsRef, forceAnchorRef, forceNoticeRef, modelUrl, disableLipSync, hideMouthLine, startSettled, nodAngle }: AvatarProps) {
  const [vrm, setVrm] = useState<VRM | null>(null);
  const blinkClock = useRef(0);
  const nextBlink = useRef(2 + Math.random() * 3);
  const mouth = useRef(0);
  const lookAtTarget = useRef(new THREE.Object3D());
  const scanIndex = useRef(0);
  const lastScan = useRef(0);
  const approach = useRef(0); // 現在の接近度 0〜1
  const gestureBones = useRef<{
    lArm?: THREE.Object3D | null;
    rArm?: THREE.Object3D | null;
    lElbow?: THREE.Object3D | null;
    rElbow?: THREE.Object3D | null;
    lShoulder?: THREE.Object3D | null;
    rShoulder?: THREE.Object3D | null;
    rHand?: THREE.Object3D | null;
  }>({});
  const gestureClock = useRef(0);
  const wasSpeaking = useRef(false);
  // 発話中の横揺れ: 喋り始めるたびに再抽選（毎回リズムが変わるように）
  const swayProfile = useRef({ freq: 0.5, phase: 0 });
  // 歩行アニメーション(脚のみ。腕はこの下の手続き型ジェスチャーが担当)
  const walkMixer = useRef<THREE.AnimationMixer | null>(null);
  const walkAction = useRef<THREE.AnimationAction | null>(null);
  const walkClipDuration = useRef(1);
  const walkWeight = useRef(0);
  const wanderTarget = useRef({ x: 0, z: APPROACH_Z_BACK });
  const wanderPauseUntil = useRef(0);
  // 徘徊が「歩いている→止まった」に切り替わった瞬間を検知するための前フレーム値
  const prevWanderWalking = useRef(true);
  // 現在のwanderTargetが「意味のある目的地」(窓/プラント)かどうか。nullなら従来通りの完全ランダム点
  const wanderAnchor = useRef<WanderAnchorKey | null>(null);
  // Playgroundの強制デモ発火(forceAnchorRef)の連番。idが変わった時だけ新規トリガーとして扱う
  const lastForceAnchorId = useRef(0);
  const lastForceNoticeId = useRef(0);
  const bodyYaw = useRef(0);
  // "head"はVRMのLookAt(視線追従)が毎フレーム上書きするため、代わりに"neck"を使う
  const neckBone = useRef<THREE.Object3D | null>(null);
  const lastActionId = useRef(0);
  const activeAction = useRef<{ tag: "nod" | "tilt"; t: number; dir: 1 | -1 } | null>(null);
  // 口隠しパッチ(hideMouthLine)への参照。nod中はneckのpitchをそのまま受けると
  // 実際の口(headのlookAt補正で首ほど傾かない)とズレて口が覗くため、
  // nod分だけ逆回転させて打ち消す
  const mouthPatch = useRef<THREE.Object3D | null>(null);
  // 単発ジェスチャー(伸び)。フルボディのMixamoリターゲット済みクリップを一度だけ再生する
  const gestureMixers = useRef<Partial<Record<GestureTag, THREE.AnimationMixer>>>({});
  const gestureActions = useRef<Partial<Record<GestureTag, THREE.AnimationAction>>>({});
  const gestureDurations = useRef<Partial<Record<GestureTag, number>>>({});
  const activeGesture = useRef<GestureTag | null>(null);
  const gestureWeight = useRef(0);
  // 手招き(procedural)の再生位置。BECKON_DURATION_S以上＝非アクティブ
  const beckonT = useRef(BECKON_DURATION_S + 1);
  // 視線サッケード（微小な揺らぎ）の現在オフセットと次の切り替え時刻
  const saccade = useRef({ x: 0, y: 0 });
  const nextSaccadeAt = useRef(0);
  // LLM由来の「驚き」リアクション（相手がすごいことを言った時）。この時刻まで surprised 表情を出す
  const reactSurpriseUntil = useRef(0);
  // 「気づき」演出の状態管理
  const noticeUntil = useRef(0);        // この時刻まで気づき演出中
  const noticeStart = useRef(0);        // 演出開始時刻（surprised→happyの切替判定用）
  const noticeStartYaw = useRef(0);     // 気づいた瞬間の体の向き(絶対値)。振り向き方の場合分けに使う
  const absentSince = useRef(0);        // 「不在」が始まった時刻（0=在席中）
  const noticeCooldownUntil = useRef(0);// 連続発火防止
  // 「チラ見」演出の状態管理（far距離での一瞬の首振り向き）
  const glanceUntil = useRef(0);        // この時刻までチラ見中
  const nextGlanceAt = useRef(0);       // 次にチラ見していい最短時刻

  useEffect(() => {
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));

    let alive = true;
    loader.load(
      modelUrl ?? MODEL_URL,
      (gltf) => {
        const loaded = gltf.userData.vrm as VRM;
        if (loaded.meta?.metaVersion === "0") VRMUtils.rotateVRM0(loaded);
        loaded.scene.traverse((o) => (o.frustumCulled = false));
        if (loaded.lookAt) loaded.lookAt.target = lookAtTarget.current;

        // 整列ポーズ: T/A-poseから腕を自然に下ろす
        const h = loaded.humanoid;
        const lArm = h?.getNormalizedBoneNode("leftUpperArm");
        const rArm = h?.getNormalizedBoneNode("rightUpperArm");
        const lElbow = h?.getNormalizedBoneNode("leftLowerArm");
        const rElbow = h?.getNormalizedBoneNode("rightLowerArm");
        const lShoulder = h?.getNormalizedBoneNode("leftShoulder");
        const rShoulder = h?.getNormalizedBoneNode("rightShoulder");
        const rHand = h?.getNormalizedBoneNode("rightHand"); // 手招きで手のひらの向きを調整するのに使う
        if (lArm) { lArm.rotation.z = -1.2; lArm.rotation.x = 0.1; }
        if (rArm) { rArm.rotation.z =  1.2; rArm.rotation.x = 0.1; }
        // 肘を軽く曲げる（より自然に）
        if (lElbow) lElbow.rotation.z = -0.15;
        if (rElbow) rElbow.rotation.z =  0.15;
        gestureBones.current = { lArm, rArm, lElbow, rElbow, lShoulder, rShoulder, rHand };
        neckBone.current = h?.getNormalizedBoneNode("neck") ?? null;

        if (hideMouthLine && neckBone.current) {
          // マスクより口のポリゴンが手前にあるため、口の位置だけ薄い黒パッチで覆う。
          // headではなくneckに付けるのは、headはVRMのLookAtが毎フレーム上書きするため
          // (↑309行目のコメント参照)、マスク本体を付けた時と同じ理由
          // 胸の横揺れアイドルモーション(SWAY_AMOUNT)や頷きでneck以下が揺れても
          // 口の線が隠れるよう少し余裕を持たせる(ただし大きすぎるとマスク上端から
          // はみ出して肌の上に黒く見えてしまうため控えめに)。
          // カメラが斜めから見るため、薄い板だと側面から隙間が見えることがあるので
          // Z方向にも厚みを持たせて角度が付いても覆えるようにする
          const geo = new THREE.BoxGeometry(0.036, 0.04, 0.02);
          // マスク本体と同じライティング応答の質感にして継ぎ目を目立たなくする
          // (単色の非ライティング素材だと、寄りのカメラでは平坦な板が浮いて見えていた)
          const mat = new THREE.MeshStandardMaterial({ color: 0x08080a, roughness: 1, metalness: 0, depthTest: false });
          const patch = new THREE.Mesh(geo, mat);
          patch.renderOrder = 999;
          patch.position.set(0, MOUTH_PATCH_Y, MOUTH_PATCH_Z);
          neckBone.current.add(patch);
          mouthPatch.current = patch;
        }

        if (startSettled) {
          // 奥から歩いて近づく演出をスキップし、最初から接近済みの位置に直接置く
          approach.current = 1;
          bodyYaw.current = 0;
          loaded.scene.position.set(0, 0, APPROACH_Z_FRONT);
        }

        if (alive) setVrm(loaded);
        else VRMUtils.deepDispose(loaded.scene);
      },
      undefined,
      (e) => console.error("VRM load error:", e)
    );

    return () => {
      alive = false;
    };
  }, []);

  // 歩行モーション(脚のみ)の読み込み。VRM本体のロード後、VRMインスタンスに合わせてクリップを作る
  useEffect(() => {
    if (!vrm) return;
    let alive = true;
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMAnimationLoaderPlugin(parser));

    loader.load(
      WALK_URL,
      (gltf) => {
        if (!alive) return;
        const vrmAnimations = gltf.userData.vrmAnimations as VRMAnimation[] | undefined;
        const vrmAnimation = vrmAnimations?.[0];
        if (!vrmAnimation) return;

        const clip = createVRMAnimationClip(vrmAnimation, vrm);
        const mixer = new THREE.AnimationMixer(vrm.scene);
        const action = mixer.clipAction(clip);
        action.setLoop(THREE.LoopRepeat, Infinity);
        action.play();
        action.setEffectiveWeight(0);

        walkMixer.current = mixer;
        walkAction.current = action;
        walkClipDuration.current = clip.duration || 1;
      },
      undefined,
      (e) => console.error("walk VRMA load error:", e)
    );

    return () => {
      alive = false;
    };
  }, [vrm]);

  // 単発ジェスチャー(伸び等)クリップの読み込み。walkと違いLoopOnceで、
  // トリガーの度にreset()して最初から再生する
  useEffect(() => {
    if (!vrm) return;
    let alive = true;
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMAnimationLoaderPlugin(parser));

    (Object.entries(GESTURE_URLS) as [GestureTag, string][]).forEach(([tag, url]) => {
      loader.load(
        url,
        (gltf) => {
          if (!alive) return;
          const vrmAnimations = gltf.userData.vrmAnimations as VRMAnimation[] | undefined;
          const vrmAnimation = vrmAnimations?.[0];
          if (!vrmAnimation) return;

          const clip = createVRMAnimationClip(vrmAnimation, vrm);
          const mixer = new THREE.AnimationMixer(vrm.scene);
          const action = mixer.clipAction(clip);
          action.setLoop(THREE.LoopOnce, 1);
          action.clampWhenFinished = true;
          action.setEffectiveWeight(0);

          gestureMixers.current[tag] = mixer;
          gestureActions.current[tag] = action;
          gestureDurations.current[tag] = clip.duration || 1;
        },
        undefined,
        (e) => console.error(`${tag} VRMA load error:`, e)
      );
    });

    return () => {
      alive = false;
    };
  }, [vrm]);

  useFrame((state, rawDelta) => {
    if (!vrm) return;
    const delta = Math.min(rawDelta, MAX_DELTA_S);
    const t = state.clock.elapsedTime;

    // 歩行クリップ(腰・脚・背骨)の再生。手続き型の各処理より先に評価し、
    // 腕など手続き型が管理するボーンは後段の処理で上書きされるようにする
    // ジェスチャー再生中は止める: walkクリップも同じ正規化ボーンを毎フレーム上書きするため、
    // weightがほぼ0でも動かし続けるとジェスチャークリップの姿勢が完全に打ち消されて見えなくなる
    if (!activeGesture.current) walkMixer.current?.update(delta);

    // 単発アクションの発火処理（外部トリガー・徘徊中の生活感演出・気づき演出のどれからも呼ぶ共通処理）
    function triggerAction(tag: "stretch" | "nod" | "tilt" | "surprise" | "beckon" | "glance") {
      if (tag === "surprise") {
        // 相手がすごいことを言った時の驚き。表情(surprised)だけ一定時間出す（体は動かさない）
        reactSurpriseUntil.current = t + 1.2;
      } else if (tag === "glance") {
        // Playgroundの手動デモ発火専用。通常のfarゾーンの自動スケジュールを介さず、
        // 今すぐ一回分のチラ見を開始する（zoneNowがfarでなくても見た目の動きは起きる）
        const gp = glanceParamsRef?.current ?? DEFAULT_GLANCE_PARAMS;
        glanceUntil.current = t + gp.durationS;
      } else if (tag === "beckon") {
        beckonT.current = 0; // 手招きを頭から再生
        // 伸び等のクリップが再生中だと脚・体が競合するので止める（手招みは上体だけの動作）
        if (activeGesture.current) {
          gestureActions.current[activeGesture.current]?.stop();
          activeGesture.current = null;
          gestureWeight.current = 0;
        }
        activeAction.current = null;
      } else if (tag === "stretch") {
        const clipAction = gestureActions.current[tag];
        if (clipAction) {
          clipAction.reset();
          clipAction.setEffectiveWeight(0);
          clipAction.play();
          activeGesture.current = tag;
        }
      } else {
        // tiltは左右どちらに傾げるかを毎回ランダムに決める（nodは左右対称なので常に1）
        const dir: 1 | -1 = tag === "tilt" && Math.random() < 0.5 ? -1 : 1;
        activeAction.current = { tag, t: 0, dir };
      }
    }

    // 行動タグ由来のアクション（頷く／首をかしげる／伸び）: 新規トリガーを検知したら開始
    const action = actionRef?.current;
    if (action && action.id !== lastActionId.current) {
      lastActionId.current = action.id;
      triggerAction(action.tag);
    }

    // Playground手動デモ発火: 「窓へ」「プラントへ」ボタンで即座に徘徊目標を切り替える。
    // prevWanderWalkingを立てておくことで、この後の徘徊移動ロジックが「歩いていて今まさに
    // 到着した」扱いで処理し、到着時の滞在演出(リンガー上書き)を確実に発火させる
    // （zoneが不在/遠いの時のみ実際に反映される。それ以外は次にwander branchへ戻った時に有効）
    const forceAnchor = forceAnchorRef?.current;
    if (forceAnchor && forceAnchor.id !== lastForceAnchorId.current) {
      lastForceAnchorId.current = forceAnchor.id;
      wanderAnchor.current = forceAnchor.key;
      wanderTarget.current = { ...WANDER_ANCHORS[forceAnchor.key] };
      prevWanderWalking.current = true;
    }

    // Playground手動デモ発火: 気づいた瞬間の体の向きを指定の角度に強制してから、
    // 通常の気づき発火と全く同じ処理(noticeUntil等)を直接叩く。振り向き3パターンを
    // 個別に呼べるようにするためのデバッグ専用経路（本番の自動発火フローは変更しない）
    const forceNotice = forceNoticeRef?.current;
    if (forceNotice && forceNotice.id !== lastForceNoticeId.current) {
      lastForceNoticeId.current = forceNotice.id;
      const testYaw = forceNotice.tier === "front" ? Math.PI / 9 // 約20°
        : forceNotice.tier === "side" ? Math.PI / 2              // 90°
        : Math.PI * 0.94;                                        // 約170°
      bodyYaw.current = testYaw;
      noticeUntil.current = t + NOTICE_DURATION_S;
      noticeStart.current = t;
      noticeStartYaw.current = testYaw;
      noticeCooldownUntil.current = t + NOTICE_COOLDOWN_S;
      triggerAction("beckon");
    }

    // ジェスチャークリップの再生・重み計算（入り/抜けをフェード、終了したら自動停止）
    let isGesturing = false;
    if (activeGesture.current) {
      const tag = activeGesture.current;
      const mixer = gestureMixers.current[tag];
      const clipAction = gestureActions.current[tag];
      const duration = gestureDurations.current[tag] ?? 1;
      if (mixer && clipAction) {
        mixer.update(delta);
        const elapsed = clipAction.time;
        const fade = Math.min(GESTURE_FADE_S, duration / 4);
        let w = 1;
        if (elapsed < fade) w = elapsed / fade;
        else if (elapsed > duration - fade) w = Math.max(0, (duration - elapsed) / fade);
        gestureWeight.current = w;
        clipAction.setEffectiveWeight(w);
        isGesturing = true;
        if (elapsed >= duration - 0.001) {
          activeGesture.current = null;
          gestureWeight.current = 0;
        }
      } else {
        activeGesture.current = null;
      }
    }
    // nod/tiltの進行度。"neck"ボーンだけを動かす単発モーションなのでここで完結する
    if (activeAction.current) {
      const tag = activeAction.current.tag;
      activeAction.current.t += delta;
      const p = activeAction.current.t / ACTION_DURATION_S;
      if (p >= 1) {
        if (neckBone.current) {
          neckBone.current.rotation.x = 0;
          neckBone.current.rotation.z = 0;
        }
        activeAction.current = null;
      } else if (neckBone.current) {
        // 0→1→0の三角波（往復）でモーションの山を作る
        const wave = Math.sin(p * Math.PI);
        if (tag === "nod") {
          neckBone.current.rotation.x = wave * (nodAngle ?? NOD_ANGLE);
        } else {
          neckBone.current.rotation.z = wave * TILT_ANGLE * activeAction.current.dir;
        }
      }
    }

    let isWalking = false;
    let retreating = false;
    // 徘徊で窓/プラントへ向かい、到着して佇んでいる間だけtrue（毎フレーム下の徘徊ブロックで
    // 設定し直す。他ブロックに入った時は自然にfalseへ戻る＝refでなくローカル変数で十分）
    let atAnchor = false;

    // 現在の距離ゾーン（気づき演出の検知・接近演出の両方で使う）
    const zoneNow = getDistanceZone(faceSizeRef?.current ?? 0);

    // 「気づき」演出のトリガー: farはまだ「気づいてないフリ(チラ見)」の段階とし、
    // mid/nearまで寄ってきた“その瞬間”に初めて発火する。遠目の人にいきなり手招みして
    // 押し売り感を出すのを避け、「近づいてくれたら初めてハッと気づく」自然な二段にする。
    // （顔検出が一瞬途切れて戻るたびの再発火は、NOTICE_ABSENT_MIN_S以上の“気づいてない時間”で防ぐ）
    const reachedInteractive = zoneNow === "mid" || zoneNow === "near";
    if (!reachedInteractive) {
      // absent(誰もいない)も far(遠くにいる)も「まだ気づいていない」扱いで、気づくまでの
      // 経過時間を刻み続ける（この蓄積がNOTICE_ABSENT_MIN_Sを超えていればmid到達で発火する）
      if (absentSince.current === 0) absentSince.current = t;
    } else {
      if (
        absentSince.current > 0 &&
        t - absentSince.current > NOTICE_ABSENT_MIN_S &&
        t > noticeCooldownUntil.current &&
        !paused && !conversing
      ) {
        noticeUntil.current = t + NOTICE_DURATION_S;
        noticeStart.current = t;
        noticeStartYaw.current = Math.abs(bodyYaw.current); // 気づいた瞬間どれだけそっぽを向いていたか（bodyYawは常に-π〜πに正規化済み）
        noticeCooldownUntil.current = t + NOTICE_COOLDOWN_S;
        triggerAction("beckon"); // ハッと気づいて「おいで」と手招き
      }
      absentSince.current = 0;
    }
    const noticing = t < noticeUntil.current;

    // 手招きの再生位置。notice演出・手動トリガーのどちらからでも動く。beckonTimeは進める前の値
    const beckoning = beckonT.current < BECKON_DURATION_S;
    const beckonTime = beckonT.current;
    if (beckoning) beckonT.current += delta;

    // 「チラ見」のトリガー: farで検知できている間だけ、不規則な間隔で一瞬首を大きく振り向ける。
    // 気づき演出(noticing/beckoning)に入ったらチラ見の意味がなくなる（もう気づいてるので）ため対象外
    const glanceParams = glanceParamsRef?.current ?? DEFAULT_GLANCE_PARAMS;
    if (
      zoneNow === "far" && !paused && !conversing && !noticing && !beckoning &&
      t > nextGlanceAt.current
    ) {
      glanceUntil.current = t + glanceParams.durationS;
      nextGlanceAt.current = t + glanceParams.durationS + lerp(glanceParams.intervalMinS, glanceParams.intervalMaxS, Math.random());
    }
    // zoneNowの制約は付けない: Playgroundの手動デモ発火(triggerAction("glance"))はどのゾーンでも
    // 見た目の動きを確認できるようにするため。自動発火自体は上のfar限定条件でしかスケジュールされない
    const glancing = t < glanceUntil.current;

    // 「意味のある徘徊」パラメータ（Playgroundのライブ上書き。未指定なら既定値）
    const agp = anchorGazeParamsRef?.current ?? DEFAULT_ANCHOR_GAZE_PARAMS;

    if (paused) {
      // デバッグの「⏸ 停止」中: 歩行・接近/徘徊・向きすべて更新せずその場に完全に固める
      // (isWalkingをfalseのままにしておくことでwalkWeightが自然に0へ収束する)
    } else if (conversing) {
      // 会話中(conversing): 会話は「中央・真正面」でしたいので、固定の会話位置(中央・手前)へ
      // 歩いて寄ってから正面を向く。
      // 端で会話が始まっても隅で喋り続けないように寄せる。ターゲットは常に固定点(中央)なので、
      // 距離ゾーンがmid/near間を行き来しても振動しない（＝ゾーン依存の接近/後退で勝手に前後する
      // 元の不具合は起こさない。だから「位置を丸ごと止める」必要はなく、固定点へ寄せる方が自然）。
      // 【重要バグ修正】以前は位置と向きをまとめて止めていたため、徘徊で後ろを向いた瞬間に
      // 「不在→near」で一気に会話が始まると(気づき演出とほぼ同時にApp側がnearゾーンで会話開始)、
      // 背中を向けたまま驚き表情＋手招み(どちらも別セクションで再生される)だけが出て、
      // 体が一切こちらを向かない状態になっていた。
      approach.current = lerp(approach.current, 1, APPROACH_LERP);
      const dx = 0 - vrm.scene.position.x;
      const dz = APPROACH_Z_FRONT - vrm.scene.position.z;
      const dist = Math.hypot(dx, dz);
      if (dist > 0.05) {
        // 端にいたら中央へ歩いて寄る（徘徊と同じ速度・進行方向を向く）
        const step = Math.min(WANDER_SPEED * delta, dist);
        vrm.scene.position.x += (dx / dist) * step;
        vrm.scene.position.z += (dz / dist) * step;
        bodyYaw.current = lerpAngle(bodyYaw.current, Math.atan2(dx, dz), 0.08);
        isWalking = true;
      } else {
        // 中央に着いたら来場者(正面=yaw0)を向いて喋る
        bodyYaw.current = lerpAngle(bodyYaw.current, 0, damp(NOTICE_TURN_LERP, delta));
        isWalking = false;
      }
      vrm.scene.rotation.y = bodyYaw.current;
    } else if (noticing || beckoning) {
      // 気づき/手招き中: その場に固まり、来場者(正面=yaw0)へ振り向く。
      // 位置は更新せず“いま居る場所から呼び込む”（＝広い会場で人を見つけて手招きする呼び込み嬢の動き）。
      // 手招みの腕モーションは後段のアーム処理が担当する。
      // 気づいた瞬間の体の向き(noticeStartYaw)で振り向き方を変える(一律だと不自然だったため):
      //   もう大体正面(NOTICE_YAW_FRONT_MAX未満)→体は回さない(下の首ピッチで上目遣いだけ演出)
      //   真後ろ(NOTICE_YAW_BACK_MIN以上)→通常より速く勢いよく振り向く
      //   それ以外(横向き)→従来通りの速さで振り向く
      approach.current = lerp(approach.current, ZONE_APPROACH[zoneNow], APPROACH_LERP);
      const startYaw = noticeStartYaw.current;
      if (startYaw >= NOTICE_YAW_FRONT_MAX) {
        const turnLerp = startYaw >= NOTICE_YAW_BACK_MIN ? NOTICE_TURN_LERP_BACK : NOTICE_TURN_LERP;
        bodyYaw.current = lerpAngle(bodyYaw.current, 0, damp(turnLerp, delta));
      }
      // startYaw < NOTICE_YAW_FRONT_MAX の時はbodyYawを動かさない(体を回さない)が、
      // rotation.yへの反映自体は毎フレーム必要（Playgroundの強制発火で直前にbodyYawだけ
      // 書き換えた場合、ここで反映しないと見た目の向きがフリーズしたまま更新されなかったため）
      vrm.scene.rotation.y = bodyYaw.current;
      isWalking = false;
    } else if (isGesturing) {
      // 伸び再生中は静止し、クリップ自身(腰・脚・腕)に専念させる。
      // isWalkingをtrueにしないことでwalkWeightは自然に0へ収束する
    } else {
      // 接近演出: 来場者が近いほどキャラが「覗き込む」
      // 体ごとの前後移動は控えめ＋上半身の前傾で寄る → 頭が見切れない
      const zone = zoneNow;

      if (zone === "absent" || zone === "far") {
        // 誰もいない間、および検知はできてもまだ気づいてないフリを保つfar距離の間は、
        // 部屋の中をランダムに歩き回る(「生活感」演出)。以前はfarも下のelse(接近演出)に入り
        // 正面を向いて立ち止まっていたが、それだと「チラ見」演出(不規則に一瞬だけ首を大きく
        // 振り向けてすぐ戻す)の前提である「まだ気づいてないフリ」と矛盾していた
        // （常に正面を向いた状態にチラ見を足しても変化がほぼ見えない）ため、mid/nearに
        // 到達するまでは体の向き・位置ともに徘徊のまま保つよう変更した
        approach.current = lerp(approach.current, 0, APPROACH_LERP);

        const dx = wanderTarget.current.x - vrm.scene.position.x;
        const dz = wanderTarget.current.z - vrm.scene.position.z;
        const dist = Math.hypot(dx, dz);

        if (dist < WANDER_ARRIVE_DIST) {
          // 歩いていた状態から止まった瞬間の演出。目的地(窓/プラント)に着いた場合と、
          // ただの通過点に着いた場合とで振る舞いを分ける
          if (prevWanderWalking.current) {
            if (wanderAnchor.current) {
              // 目的地に着いた: 「用があって来た」ことが伝わるよう、通常の徘徊停止より長く
              // 留まらせる。ここで滞在終了時刻を上書きするので、経路が短くwanderPauseUntilが
              // 既に過去になっていた場合でも確実に見える長さの滞在になる
              wanderPauseUntil.current = t + lerp(agp.lingerMinS, agp.lingerMaxS, Math.random());
            } else {
              // ただの通過点: 低確率で伸び/頷く/首かしげるのどれかを挟む
              // (「ただ突っ立ってるだけ」を防ぐ生活感演出。waveは対象外)
              if (Math.random() < IDLE_GESTURE_CHANCE) {
                const pick = IDLE_GESTURE_TAGS[Math.floor(Math.random() * IDLE_GESTURE_TAGS.length)];
                triggerAction(pick);
              }
              // 立ち止まって「ふと振り返る」のはチラ見が最も自然に見えるタイミングなので、
              // 止まった瞬間だけランダムタイマー(nextGlanceAt)を待たずに前倒しで誘発する。
              // 直接glanceUntilを書き換えず「次フレームで即発火する」よう仕込むだけなので、
              // 通常のチラ見発火ロジック(このフレームの少し上)と経路が分かれず一本化される
              if (zone === "far" && !glancing && Math.random() < glanceParams.pauseChance) {
                nextGlanceAt.current = t - 1;
              }
            }
          }
          // 目的地に留まっている間は毎フレームtrue（下の視線処理で「窓の外を眺める/プラントを
          // 見下ろす」向きに使う）
          atAnchor = wanderAnchor.current !== null;
          isWalking = false;
          if (t > wanderPauseUntil.current) {
            const pick = pickWanderTarget(agp.chance);
            wanderAnchor.current = pick.anchor;
            wanderTarget.current = { x: pick.x, z: pick.z };
            wanderPauseUntil.current = t + lerp(WANDER_PAUSE_MIN, WANDER_PAUSE_MAX, Math.random());
          }
        } else {
          isWalking = true;
          const step = Math.min(WANDER_SPEED * delta, dist);
          vrm.scene.position.x += (dx / dist) * step;
          vrm.scene.position.z += (dz / dist) * step;
          const targetYaw = Math.atan2(dx, dz);
          bodyYaw.current = lerpAngle(bodyYaw.current, targetYaw, 0.08);
          vrm.scene.rotation.y = bodyYaw.current;
        }
        prevWanderWalking.current = isWalking;
      } else {
        // 来場者検知中: 正面(中央)へ戻りながら接近演出を行う
        const approachTarget = ZONE_APPROACH[zone];
        approach.current = lerp(approach.current, approachTarget, APPROACH_LERP);
        const a = approach.current;
        const targetZ = lerp(APPROACH_Z_BACK, APPROACH_Z_FRONT, a);

        const dx = 0 - vrm.scene.position.x;
        const dz = targetZ - vrm.scene.position.z;
        const dist = Math.hypot(dx, dz);
        const returningFromWander = dist > 0.05;

        if (returningFromWander) {
          // 徘徊位置が部屋のどこにあるか分からないため、目標値へ直接lerpすると
          // 移動方向と体の向きが噛み合わず「滑って瞬間移動したように」見えてしまう。
          // 徘徊時と同じく、実際に歩く速度(WANDER_SPEED)で移動方向を向いて歩かせる
          const step = Math.min(WANDER_SPEED * delta, dist);
          vrm.scene.position.x += (dx / dist) * step;
          vrm.scene.position.z += (dz / dist) * step;
          const targetYaw = Math.atan2(dx, dz);
          bodyYaw.current = lerpAngle(bodyYaw.current, targetYaw, 0.08);
        } else {
          // 中央付近に着いたら、来場者の方(正面)を向いてわずかな前後（覗き込み）だけ滑らかに
          vrm.scene.position.z = lerp(vrm.scene.position.z, targetZ, 0.05);
          vrm.scene.position.x = lerp(vrm.scene.position.x, 0, 0.05);
          bodyYaw.current = lerpAngle(bodyYaw.current, 0, 0.05);
        }
        vrm.scene.rotation.y = bodyYaw.current;

        const approaching = approachTarget > approach.current + 0.03;
        retreating = approachTarget < approach.current - 0.03;
        isWalking = approaching || retreating || returningFromWander;
      }
    }

    walkWeight.current = lerp(walkWeight.current, isWalking ? 1 : 0, 0.06);
    walkAction.current?.setEffectiveWeight(walkWeight.current);
    if (walkAction.current) walkAction.current.timeScale = retreating ? -1 : 1;

    // 呼吸（わずかに上下）+ 歩行中の上下バウンス（体重移動の近似）
    // バウンスは脚クリップの位相(2倍周波数=着地2回/サイクル)に同期させる
    const walkPhase = walkClipDuration.current > 0
      ? (walkAction.current?.time ?? 0) / walkClipDuration.current * Math.PI * 2
      : 0;
    const walkBob = -Math.abs(Math.sin(walkPhase)) * WALK_BOB_AMOUNT * walkWeight.current;
    vrm.scene.position.y = Math.sin(t * 1.1) * 0.004 + walkBob;

    // 接近時の前傾(覗き込み)演出は、歩行が止まった後に「ピタッと止まって曲がる」ように見えて
    // 違和感が強かったため撤去。spineは歩行クリップ由来の動き以外は基本姿勢のまま
    const chest = vrm.humanoid?.getNormalizedBoneNode("chest");

    // 視線追従: 複数人いれば順番にスキャン、1人ならその人を見る
    const all = allFaceCentersRef?.current ?? [];
    const allEyes = allEyeCentersRef?.current ?? [];
    let fc = faceCenterRef?.current ?? null;
    // LookAt(視線)の目標だけは顔全体の中心でなく目の位置を使う。顔中心は鼻付近で、
    // 特に会話の近距離だと「目の少し下」を見ているように見えてしまうため
    let ec = eyeCenterRef?.current ?? fc;
    if (all.length >= 2) {
      const now = t * 1000;
      if (now - lastScan.current > SCAN_INTERVAL) {
        scanIndex.current = (scanIndex.current + 1) % all.length;
        lastScan.current = now;
      }
      fc = all[scanIndex.current] ?? fc;
      ec = allEyes[scanIndex.current] ?? fc;
    }
    // 視線サッケード: 不規則な間隔で小さなオフセットを取り直す。lerpで滑らかに反映されるので
    // 目標に張り付かず微妙に揺れる＝生きた目に見える（気づき演出中はロック感を優先し揺らぎを抑える）
    if (t > nextSaccadeAt.current) {
      const scale = noticing ? 0.3 : 1;
      saccade.current.x = (Math.random() * 2 - 1) * SACCADE_X * scale;
      saccade.current.y = (Math.random() * 2 - 1) * SACCADE_Y * scale;
      nextSaccadeAt.current = t + lerp(SACCADE_MIN_S, SACCADE_MAX_S, Math.random());
    }
    const targetX = (ec ? lerp(-1.5, 1.5, 1 - ec.x) : 0) + saccade.current.x; // カメラは鏡像なので反転
    const targetY = (ec ? lerp(2.5, 0.5, ec.y) : 1.5) + saccade.current.y;
    const targetZ = 2;
    // 気づいた瞬間は視線を素早く来場者にロック（「私を見てる」を強く感じさせる）。普段は緩やかに追う
    const gazeLerp = noticing ? damp(NOTICE_GAZE_LERP, delta) : GAZE_LERP;
    lookAtTarget.current.position.x = lerp(lookAtTarget.current.position.x, targetX, gazeLerp);
    lookAtTarget.current.position.y = lerp(lookAtTarget.current.position.y, targetY, gazeLerp);
    lookAtTarget.current.position.z = targetZ;

    // 「意味のある徘徊」の視線: 目的地(窓/プラント)に佇んでいる間・誰もいない(absent)時だけ、
    // 来場者ではなくその目的地の方を向く。far中(誰か検知はできている)はチラ見/通常追従を
    // 優先させたいので対象外にする（この演出とチラ見の役割が被らないようにするための線引き）
    const anchorGazing = atAnchor && zoneNow === "absent" && !glancing;

    // 首(neck)の追従: 目/頭のLookAtに加えて首も来場者へ向ける＝「吸い付いて追う」感。
    // nod/tiltは neck.x/z を使うので、ここでは干渉しない neck.y(ヨー) だけを動かす。
    // 首は向き全体の一部(NECK_FOLLOW_FRAC)だけこなし、残りは頭のLookAtが補うので回りすぎない
    if (neckBone.current) {
      let neckYawTarget = 0;
      let chestYawTarget = 0;
      if (fc) {
        const dx = targetX - vrm.scene.position.x;
        const dz = targetZ - vrm.scene.position.z;
        const rel = Math.atan2(dx, dz) - bodyYaw.current; // 体の向きに対する相対ヨー
        const relNorm = Math.atan2(Math.sin(rel), Math.cos(rel)); // 最短経路へ正規化
        if (glancing) {
          // チラ見中は首(最大でもneckMax、約43°)だけでは体が来場者の真後ろを向いている時に
          // 全く届かない（首を目一杯振っても、まだ100°以上そっぽを向いたまま）。実際に人が
          // 肩越しに振り返る時も首だけでなく上半身をひねっているのに倣い、胸(chest)にも
          // 優先的に角度を分担させ、残りを首が追加でカバーする（胸→首の順で角度を消化）
          chestYawTarget = Math.max(-glanceParams.chestMax, Math.min(glanceParams.chestMax, relNorm));
          const remaining = relNorm - chestYawTarget;
          neckYawTarget = Math.max(-glanceParams.neckMax, Math.min(glanceParams.neckMax, remaining));
        } else {
          // 通常時は浅い追従のまま(常時ゆるく効いてるだけでは遠目に気づきにくいため)、胸は動かさない
          neckYawTarget = Math.max(-NECK_FOLLOW_MAX, Math.min(NECK_FOLLOW_MAX, relNorm * NECK_FOLLOW_FRAC));
        }
      } else if (anchorGazing) {
        // 目的地の実物(窓/プラント)のワールド座標へ、チラ見と同じ胸→首の分担方式で向き直る
        const world = ANCHOR_LOOK_WORLD[wanderAnchor.current!];
        const dx = world.x - vrm.scene.position.x;
        const dz = world.z - vrm.scene.position.z;
        const rel = Math.atan2(dx, dz) - bodyYaw.current;
        const relNorm = Math.atan2(Math.sin(rel), Math.cos(rel));
        chestYawTarget = Math.max(-agp.chestMax, Math.min(agp.chestMax, relNorm));
        const remaining = relNorm - chestYawTarget;
        neckYawTarget = Math.max(-agp.neckMax, Math.min(agp.neckMax, remaining));
      }
      if (chest) {
        const chestLerp = glancing || anchorGazing ? damp(anchorGazing ? agp.turnLerp : glanceParams.lerp, delta) : NECK_FOLLOW_LERP;
        chest.rotation.y = lerp(chest.rotation.y, chestYawTarget, chestLerp);
      }
      const neckLerp = noticing ? damp(NOTICE_GAZE_LERP, delta)
        : glancing || anchorGazing ? damp(anchorGazing ? agp.turnLerp : glanceParams.lerp, delta)
        : NECK_FOLLOW_LERP;
      neckBone.current.rotation.y = lerp(neckBone.current.rotation.y, neckYawTarget, neckLerp);

      // 縦の傾き: nod/tilt(activeAction)がneck.xを使っている間は干渉しないよう手を出さない。
      // プラントでは見下ろす(+)、窓では見上げる(-)方向へagp.pitchだけ傾ける。それ以外は0へ戻す
      if (!activeAction.current) {
        // もう正面向きで気づいた時(noticeStartYaw < NOTICE_YAW_FRONT_MAX)は、体を回さない代わりに
        // 首だけ軽く上げて上目遣いにする(「気づいた」を伝える最小限の反応)
        const noticingFront = noticing && noticeStartYaw.current < NOTICE_YAW_FRONT_MAX;
        const pitchTarget = anchorGazing
          ? (wanderAnchor.current === "plant" ? agp.pitch : -agp.pitch)
          : noticingFront ? -NOTICE_FRONT_PITCH
          : 0;
        const pitchLerp = anchorGazing || noticingFront ? damp(NOTICE_TURN_LERP, delta) : NECK_FOLLOW_LERP;
        neckBone.current.rotation.x = lerp(neckBone.current.rotation.x, pitchTarget, pitchLerp);
      }
    }

    // 発話中のジェスチャー: 腕は基本姿勢のまま、体だけ横揺れさせる
    // (腕を交互に上げる仕草・腕組み等のポーズ切替はどちらも不自然だったため撤去)
    const speaking = speakingRef?.current ?? false;
    const { lArm, rArm, lElbow, rElbow, lShoulder, rShoulder, rHand } = gestureBones.current;
    if (lArm && rArm && lElbow && rElbow) {
      if (beckoning) {
        // 手招き（procedural）: 上腕で肘を上げ(静的)、肘を曲げて前腕を立て、その前腕〜手をゆっくり振る。
        // 手のひらは手首のひねりで来場者へ向ける。左腕は基本姿勢のまま。
        // 入り/抜けは台形エンベロープ(w)で基本姿勢との間を補間するので突然ポーズが飛ばない
        gestureClock.current = 0;
        let w: number;
        if (beckonTime < BECKON_IN_S) w = beckonTime / BECKON_IN_S;
        else if (beckonTime > BECKON_IN_S + BECKON_HOLD_S) w = Math.max(0, (BECKON_DURATION_S - beckonTime) / BECKON_OUT_S);
        else w = 1;
        const bp = beckonPoseRef?.current ?? DEFAULT_BECKON_POSE;
        const holdT = Math.max(0, beckonTime - BECKON_IN_S);
        const swing = Math.sin(holdT * bp.hz * Math.PI * 2); // -1〜1
        // 上腕を上げてZ軸で左右にゆっくり振る＝手を振る。肘を曲げ、前腕/手首のひねりで手のひらを来場者へ
        rArm.rotation.set(lerp(0.1, bp.armX, w), 0, lerp(1.2, bp.armZ + swing * bp.sway, w));
        rElbow.rotation.set(0, lerp(0, bp.foreTwist, w), lerp(0.15, bp.elbowZ, w));
        if (rHand) rHand.rotation.set(0, 0, lerp(0, bp.handRoll, w)); // 手のひらを来場者へ
        lArm.rotation.set(0.1, 0, -1.2);
        lElbow.rotation.set(0, 0, -0.15);
        if (rShoulder) rShoulder.rotation.set(0, 0, lerp(0, bp.shoulderZ, w));
        if (lShoulder) lShoulder.rotation.set(0, 0, 0);
        // 棒立ち回避: 上体をゆるく揺らし、わずかに前傾して呼び込む
        if (chest) {
          chest.rotation.z = Math.sin(holdT * bp.hz * Math.PI) * BECKON_BODY_SWAY * w;
          chest.rotation.x = lerp(chest.rotation.x, BECKON_LEAN * w, 0.1);
        }
      } else if (isGesturing) {
        gestureClock.current = 0;
        if (chest) chest.rotation.z = lerp(chest.rotation.z, 0, 0.05);
        // 重みが低い間(入り/抜け)は歩行と同じ理由でbind pose寄りに流れて腕が伸びて見えるため、
        // 基本姿勢へスナップする。重みが十分高い間はクリップ自身が腕・肩を駆動するので何もしない
        if (gestureWeight.current < GESTURE_ARM_SNAP_THRESHOLD) {
          lArm.rotation.set(0.1, 0, -1.2);
          lElbow.rotation.set(0, 0, -0.15);
          rArm.rotation.set(0.1, 0, 1.2);
          rElbow.rotation.set(0, 0, 0.15);
          if (lShoulder) lShoulder.rotation.set(0, 0, 0);
          if (rShoulder) rShoulder.rotation.set(0, 0, 0);
        }
      } else if (speaking) {
        if (!wasSpeaking.current) {
          // 喋り始めた瞬間にリズムを再抽選 → 毎回違う揺れ方になる
          gestureClock.current = 0;
          swayProfile.current = { freq: 1.6 + Math.random() * 0.8, phase: Math.random() * Math.PI * 2 };
        }
        gestureClock.current += delta;
        const gt = gestureClock.current;

        // 体の横揺れ（胸をZ軸でひねる）
        const { freq, phase } = swayProfile.current;
        if (chest) chest.rotation.z = Math.sin(gt * freq + phase) * SWAY_AMOUNT;

        lArm.rotation.z = lerp(lArm.rotation.z, -1.2, 0.05);
        lArm.rotation.x = lerp(lArm.rotation.x, 0.1, 0.05);
        lElbow.rotation.z = lerp(lElbow.rotation.z, -0.15, 0.05);
        rArm.rotation.z = lerp(rArm.rotation.z, 1.2, 0.05);
        rArm.rotation.x = lerp(rArm.rotation.x, 0.1, 0.05);
        rElbow.rotation.z = lerp(rElbow.rotation.z, 0.15, 0.05);
        if (lShoulder) { lShoulder.rotation.x = lerp(lShoulder.rotation.x, 0, 0.05); lShoulder.rotation.z = lerp(lShoulder.rotation.z, 0, 0.05); }
        if (rShoulder) { rShoulder.rotation.x = lerp(rShoulder.rotation.x, 0, 0.05); rShoulder.rotation.z = lerp(rShoulder.rotation.z, 0, 0.05); }
      } else if (isWalking && walkAction.current) {
        gestureClock.current = 0;
        if (chest) chest.rotation.z = lerp(chest.rotation.z, 0, 0.05);
        // 歩行中の腕振りは歩行クリップ自体にリターゲット済みのMixamoモーションが
        // 入っている(walkMixer.update()で既に反映済み)ので、基本的にはここでは何もしない。
        // ただし歩行クリップの重み(walkWeight)が低い間、three.jsのAnimationMixerは
        // クリップ値と「バインド時点の元の姿勢」を重みで按分するが、その元の姿勢は
        // 期待していた「腕を下ろした基本姿勢」ではなくT-pose寄りの値になっており、
        // 歩行が始まった直後(weightが0から立ち上がる間、座りからに限らずページ読み込み
        // 直後の初回徘徊でも同様)は腕が一瞬水平近くまで伸びて見える不具合があった。
        // lerpでの緩和だけでは低fps環境や初回フレームで収束が間に合わないことがあったため、
        // 重みが十分低い間は基本姿勢へ直接スナップし、閾値を超えたらlerpに切り替える
        const STAND_SNAP_THRESHOLD = 0.25;
        if (walkWeight.current < STAND_SNAP_THRESHOLD) {
          lArm.rotation.set(0.1, 0, -1.2);
          lElbow.rotation.set(0, 0, -0.15);
          rArm.rotation.set(0.1, 0, 1.2);
          rElbow.rotation.set(0, 0, 0.15);
        } else {
          const standPull = Math.max(0, 1 - walkWeight.current) * 0.6;
          lArm.rotation.z = lerp(lArm.rotation.z, -1.2, standPull);
          lArm.rotation.x = lerp(lArm.rotation.x, 0.1, standPull);
          lElbow.rotation.z = lerp(lElbow.rotation.z, -0.15, standPull);
          rArm.rotation.z = lerp(rArm.rotation.z, 1.2, standPull);
          rArm.rotation.x = lerp(rArm.rotation.x, 0.1, standPull);
          rElbow.rotation.z = lerp(rElbow.rotation.z, 0.15, standPull);
        }
        // 肩(鎖骨)は歩行クリップに含まれておらず、座り姿勢の角度が残ったままになる
        // バグもあったため、ここで基本姿勢へ戻す
        if (lShoulder) { lShoulder.rotation.x = lerp(lShoulder.rotation.x, 0, 0.08); lShoulder.rotation.z = lerp(lShoulder.rotation.z, 0, 0.08); }
        if (rShoulder) { rShoulder.rotation.x = lerp(rShoulder.rotation.x, 0, 0.08); rShoulder.rotation.z = lerp(rShoulder.rotation.z, 0, 0.08); }
      } else {
        gestureClock.current = 0;
        if (chest) chest.rotation.z = lerp(chest.rotation.z, 0, 0.05);
        // 喋ってない・歩いてない間は基本姿勢へ滑らかに戻す
        lArm.rotation.z = lerp(lArm.rotation.z, -1.2, 0.05);
        lArm.rotation.x = lerp(lArm.rotation.x, 0.1, 0.05);
        lElbow.rotation.z = lerp(lElbow.rotation.z, -0.15, 0.05);
        rArm.rotation.z = lerp(rArm.rotation.z, 1.2, 0.05);
        rArm.rotation.x = lerp(rArm.rotation.x, 0.1, 0.05);
        rElbow.rotation.z = lerp(rElbow.rotation.z, 0.15, 0.05);
        if (lShoulder) { lShoulder.rotation.x = lerp(lShoulder.rotation.x, 0, 0.05); lShoulder.rotation.z = lerp(lShoulder.rotation.z, 0, 0.05); }
        if (rShoulder) { rShoulder.rotation.x = lerp(rShoulder.rotation.x, 0, 0.05); rShoulder.rotation.z = lerp(rShoulder.rotation.z, 0, 0.05); }
      }
      wasSpeaking.current = speaking;
    }

    const em = vrm.expressionManager;
    if (em) {
      // まばたき
      blinkClock.current += delta;
      const since = blinkClock.current - nextBlink.current;
      if (since >= 0) {
        const p = since / 0.12; // まばたき所要 0.12秒
        if (p >= 1) {
          em.setValue("blink", 0);
          blinkClock.current = 0;
          nextBlink.current = 2 + Math.random() * 3;
        } else {
          em.setValue("blink", Math.sin(p * Math.PI));
        }
      }

      if (disableLipSync) {
        // マスク装着モデルは口(や口を含むhappy/surprised等の複合表情)を動かすと
        // テクスチャが裂けて見えるため、口に関わる表情は一切動かさない(まばたきのみ生かす)
        mouth.current = 0;
        em.setValue("aa", 0);
        em.setValue("happy", 0);
        em.setValue("surprised", 0);
      } else {
        // リップシンク
        const vol = volumeRef?.current ?? 0;
        // volumeRef がある（AivisSpeech）なら音量ベース、なければ簡易波
        const target = speaking
          ? (vol > 0 ? clamp01(vol * 1.4) : clamp01(0.2 + 0.6 * Math.abs(Math.sin(t * 16)) + 0.15 * (Math.random() - 0.5)))
          : 0;
        mouth.current = lerp(mouth.current, target, 0.35);
        em.setValue("aa", mouth.current);

        if (noticing) {
          // 気づき演出中は来場者の表情に関係なく強制上書き:
          // 最初のNOTICE_SURPRISE_S秒は「ハッ」と驚き、その後は「見つけた！」の笑顔にパッと切り替える
          const nt = t - noticeStart.current;
          const surprisePhase = nt < NOTICE_SURPRISE_S;
          em.setValue("surprised", surprisePhase ? 0.9 : 0);
          // 呼び込みセリフ発話中は口モーフ(aa)と競合するのでhappyを控えめに
          em.setValue("happy", surprisePhase ? 0 : (speaking ? 0.5 : 0.9));
        } else {
          // 来場者の表情に共感：笑顔→happy、驚き→surprised（しきい値二値判定）。
          // さらにLLM由来の「驚き」リアクション（相手がすごいことを言った時）を surprised に重ねる。
          // LLM驚きは来場者の顔とは独立に出したいので expr が無くても効く
          const expr = expressionRef?.current;
          const smileOn = !!expr && expr.smile >= SMILE_THRESHOLD;
          const visitorSurprised = !!expr && expr.surprised >= SURPRISED_THRESHOLD;
          // LLM驚きリアクションのフェード（残り0.9秒で徐々に抜けて自然に戻す）
          const reactSurprise = reactSurpriseUntil.current > t
            ? Math.min(1, (reactSurpriseUntil.current - t) / 0.9)
            : 0;
          // リップシンク中はhappyを控えめに（口モーフと競合するため）
          em.setValue("happy", smileOn ? (speaking ? 0.4 : 0.9) : 0);
          em.setValue("surprised", Math.max(visitorSurprised ? 0.8 : 0, reactSurprise * 0.9));
        }
      }
    }

    // 口隠しパッチ: neckの子として乗せているだけだと、neckが回転(nod等)した時に
    // 基準位置が回転の弧を描いて動いてしまい、実際の口(headのlookAt補正であまり
    // 傾かない)とズレて隙間が見えてしまう。neckの現在のpitchぶんだけ逆回転させた
    // 位置・向きを毎フレーム計算し直すことで、回転量によらず一定の見た目を保つ
    if (mouthPatch.current && neckBone.current) {
      const a = -neckBone.current.rotation.x;
      const cosA = Math.cos(a);
      const sinA = Math.sin(a);
      mouthPatch.current.position.set(
        0,
        MOUTH_PATCH_Y * cosA - MOUTH_PATCH_Z * sinA,
        MOUTH_PATCH_Y * sinA + MOUTH_PATCH_Z * cosA
      );
      mouthPatch.current.rotation.x = a;
    }

    vrm.update(delta);
  });

  if (!vrm) return null;
  return <primitive object={vrm.scene} />;
}
