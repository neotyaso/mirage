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
  allFaceCentersRef?: MutableRefObject<FaceCenter[]>;
  expressionRef?: MutableRefObject<FaceExpression>;
  faceSizeRef?: MutableRefObject<number>;
  // 行動タグ(useConversation.ts)。idが変わるたびに新規トリガーとして扱う
  actionRef?: MutableRefObject<{ tag: "nod" | "tilt" | "surprise" | "stretch" | "beckon"; id: number } | null>;
  // デバッグ用「⏸ 停止」ボタンでtrueになる。歩行・接近/徘徊などの移動だけを止めて
  // その場に固まらせる（瞬き・呼吸・リップシンク等の待機アニメは止めない）
  paused?: boolean;
  // 会話中(convState !== "idle")はtrue。話している最中に来場者の姿勢のわずかな変化で
  // 距離ゾーンがmid/near間を行き来し、勝手に歩き出す/後ずさりするのを防ぐため、
  // 会話中は接近/徘徊の位置更新を止める（頷く等の身振りは止めない）
  conversing?: boolean;
  // 手招みポーズのライブ上書き（Playgroundのスライダー用）。未指定ならDEFAULT_BECKON_POSE
  beckonPoseRef?: MutableRefObject<BeckonPose>;
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

function pickWanderTarget(): { x: number; z: number } {
  const x = lerp(WANDER_BOUNDS.xMin, WANDER_BOUNDS.xMax, Math.random());
  const z = lerp(WANDER_BOUNDS.zMin, WANDER_BOUNDS.zMax, Math.random());
  return { x, z };
}

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

export function Avatar({ speakingRef, volumeRef, faceCenterRef, allFaceCentersRef, expressionRef, faceSizeRef, actionRef, paused, conversing, beckonPoseRef }: AvatarProps) {
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
  const bodyYaw = useRef(0);
  // "head"はVRMのLookAt(視線追従)が毎フレーム上書きするため、代わりに"neck"を使う
  const neckBone = useRef<THREE.Object3D | null>(null);
  const lastActionId = useRef(0);
  const activeAction = useRef<{ tag: "nod" | "tilt"; t: number; dir: 1 | -1 } | null>(null);
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
  const absentSince = useRef(0);        // 「不在」が始まった時刻（0=在席中）
  const noticeCooldownUntil = useRef(0);// 連続発火防止

  useEffect(() => {
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));

    let alive = true;
    loader.load(
      MODEL_URL,
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
    function triggerAction(tag: "stretch" | "nod" | "tilt" | "surprise" | "beckon") {
      if (tag === "surprise") {
        // 相手がすごいことを言った時の驚き。表情(surprised)だけ一定時間出す（体は動かさない）
        reactSurpriseUntil.current = t + 1.2;
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
          neckBone.current.rotation.x = wave * NOD_ANGLE;
        } else {
          neckBone.current.rotation.z = wave * TILT_ANGLE * activeAction.current.dir;
        }
      }
    }

    let isWalking = false;
    let retreating = false;

    // 現在の距離ゾーン（気づき演出の検知・接近演出の両方で使う）
    const zoneNow = getDistanceZone(faceSizeRef?.current ?? 0);

    // 「気づき」演出のトリガー: 一定時間の不在のあと来場者を検知した“その瞬間”だけ発火する。
    // （顔検出が一瞬途切れて戻るたびに再発火しないよう、NOTICE_ABSENT_MIN_S以上の不在を要求）
    if (zoneNow === "absent") {
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
      // 気づき/手招き中: その場に固まり、来場者(正面=yaw0)へ素早く振り向く。
      // 位置は更新せず“いま居る場所から呼び込む”（＝広い会場で人を見つけて手招きする呼び込み嬢の動き）。
      // 手招みの腕モーションは後段のアーム処理が担当する
      approach.current = lerp(approach.current, ZONE_APPROACH[zoneNow], APPROACH_LERP);
      bodyYaw.current = lerpAngle(bodyYaw.current, 0, damp(NOTICE_TURN_LERP, delta));
      vrm.scene.rotation.y = bodyYaw.current;
      isWalking = false;
    } else if (isGesturing) {
      // 伸び再生中は静止し、クリップ自身(腰・脚・腕)に専念させる。
      // isWalkingをtrueにしないことでwalkWeightは自然に0へ収束する
    } else {
      // 接近演出: 来場者が近いほどキャラが「覗き込む」
      // 体ごとの前後移動は控えめ＋上半身の前傾で寄る → 頭が見切れない
      const zone = zoneNow;

      if (zone === "absent") {
        // 誰もいない間は部屋の中をランダムに歩き回る(「生活感」演出)
        approach.current = lerp(approach.current, 0, APPROACH_LERP);

        const dx = wanderTarget.current.x - vrm.scene.position.x;
        const dz = wanderTarget.current.z - vrm.scene.position.z;
        const dist = Math.hypot(dx, dz);

        if (dist < WANDER_ARRIVE_DIST) {
          // 歩いていた状態から止まった瞬間だけ、低確率で伸び/頷く/首かしげるのどれかを挟む
          // (「ただ突っ立ってるだけ」を防ぐ生活感演出。waveは対象外)
          if (prevWanderWalking.current && Math.random() < IDLE_GESTURE_CHANCE) {
            const pick = IDLE_GESTURE_TAGS[Math.floor(Math.random() * IDLE_GESTURE_TAGS.length)];
            triggerAction(pick);
          }
          isWalking = false;
          if (t > wanderPauseUntil.current) {
            wanderPauseUntil.current = t + lerp(WANDER_PAUSE_MIN, WANDER_PAUSE_MAX, Math.random());
            wanderTarget.current = pickWanderTarget();
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
    let fc = faceCenterRef?.current ?? null;
    if (all.length >= 2) {
      const now = t * 1000;
      if (now - lastScan.current > SCAN_INTERVAL) {
        scanIndex.current = (scanIndex.current + 1) % all.length;
        lastScan.current = now;
      }
      fc = all[scanIndex.current] ?? fc;
    }
    // 視線サッケード: 不規則な間隔で小さなオフセットを取り直す。lerpで滑らかに反映されるので
    // 目標に張り付かず微妙に揺れる＝生きた目に見える（気づき演出中はロック感を優先し揺らぎを抑える）
    if (t > nextSaccadeAt.current) {
      const scale = noticing ? 0.3 : 1;
      saccade.current.x = (Math.random() * 2 - 1) * SACCADE_X * scale;
      saccade.current.y = (Math.random() * 2 - 1) * SACCADE_Y * scale;
      nextSaccadeAt.current = t + lerp(SACCADE_MIN_S, SACCADE_MAX_S, Math.random());
    }
    const targetX = (fc ? lerp(-1.5, 1.5, 1 - fc.x) : 0) + saccade.current.x; // カメラは鏡像なので反転
    const targetY = (fc ? lerp(2.5, 0.5, fc.y) : 1.5) + saccade.current.y;
    const targetZ = 2;
    // 気づいた瞬間は視線を素早く来場者にロック（「私を見てる」を強く感じさせる）。普段は緩やかに追う
    const gazeLerp = noticing ? damp(NOTICE_GAZE_LERP, delta) : GAZE_LERP;
    lookAtTarget.current.position.x = lerp(lookAtTarget.current.position.x, targetX, gazeLerp);
    lookAtTarget.current.position.y = lerp(lookAtTarget.current.position.y, targetY, gazeLerp);
    lookAtTarget.current.position.z = targetZ;

    // 首(neck)の追従: 目/頭のLookAtに加えて首も来場者へ向ける＝「吸い付いて追う」感。
    // nod/tiltは neck.x/z を使うので、ここでは干渉しない neck.y(ヨー) だけを動かす。
    // 首は向き全体の一部(NECK_FOLLOW_FRAC)だけこなし、残りは頭のLookAtが補うので回りすぎない
    if (neckBone.current) {
      let neckYawTarget = 0;
      if (fc) {
        const dx = targetX - vrm.scene.position.x;
        const dz = targetZ - vrm.scene.position.z;
        const rel = Math.atan2(dx, dz) - bodyYaw.current; // 体の向きに対する相対ヨー
        const relNorm = Math.atan2(Math.sin(rel), Math.cos(rel)); // 最短経路へ正規化
        neckYawTarget = Math.max(-NECK_FOLLOW_MAX, Math.min(NECK_FOLLOW_MAX, relNorm * NECK_FOLLOW_FRAC));
      }
      const neckLerp = noticing ? damp(NOTICE_GAZE_LERP, delta) : NECK_FOLLOW_LERP;
      neckBone.current.rotation.y = lerp(neckBone.current.rotation.y, neckYawTarget, neckLerp);
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

    vrm.update(delta);
  });

  if (!vrm) return null;
  return <primitive object={vrm.scene} />;
}
