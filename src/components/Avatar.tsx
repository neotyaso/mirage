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

export interface AvatarProps {
  speakingRef?: MutableRefObject<boolean>;
  volumeRef?: MutableRefObject<number>;
  faceCenterRef?: MutableRefObject<FaceCenter | null>;
  allFaceCentersRef?: MutableRefObject<FaceCenter[]>;
  expressionRef?: MutableRefObject<FaceExpression>;
  faceSizeRef?: MutableRefObject<number>;
  // 行動タグ(useConversation.ts)。idが変わるたびに新規トリガーとして扱う
  actionRef?: MutableRefObject<{ tag: "nod" | "tilt" | "stretch"; id: number } | null>;
  // デバッグ用「⏸ 停止」ボタンでtrueになる。歩行・接近/徘徊などの移動だけを止めて
  // その場に固まらせる（瞬き・呼吸・リップシンク等の待機アニメは止めない）
  paused?: boolean;
  // 会話中(convState !== "idle")はtrue。話している最中に来場者の姿勢のわずかな変化で
  // 距離ゾーンがmid/near間を行き来し、勝手に歩き出す/後ずさりするのを防ぐため、
  // 会話中は接近/徘徊の位置更新を止める（頷く等の身振りは止めない）
  conversing?: boolean;
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

export function Avatar({ speakingRef, volumeRef, faceCenterRef, allFaceCentersRef, expressionRef, faceSizeRef, actionRef, paused, conversing }: AvatarProps) {
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
        if (lArm) { lArm.rotation.z = -1.2; lArm.rotation.x = 0.1; }
        if (rArm) { rArm.rotation.z =  1.2; rArm.rotation.x = 0.1; }
        // 肘を軽く曲げる（より自然に）
        if (lElbow) lElbow.rotation.z = -0.15;
        if (rElbow) rElbow.rotation.z =  0.15;
        gestureBones.current = { lArm, rArm, lElbow, rElbow, lShoulder, rShoulder };
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

    // 単発アクションの発火処理（外部トリガー・徘徊中の生活感演出のどちらからも呼ぶ共通処理）
    function triggerAction(tag: "stretch" | "nod" | "tilt") {
      if (tag === "stretch") {
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

    if (paused || conversing) {
      // デバッグの「⏸ 停止」中、または会話中(conversing): 歩行・接近/徘徊は一切更新せず
      // その場に固まらせる(isWalkingをfalseのままにしておくことでwalkWeightが自然に0へ収束する)。
      // 会話中に止めるのは、来場者の姿勢のわずかな変化で距離ゾーンがmid/near間を行き来し、
      // 勝手に歩き出す/後ずさりするのを防ぐため
    } else if (isGesturing) {
      // 伸び再生中は静止し、クリップ自身(腰・脚・腕)に専念させる。
      // isWalkingをtrueにしないことでwalkWeightは自然に0へ収束する
    } else {
      // 接近演出: 来場者が近いほどキャラが「覗き込む」
      // 体ごとの前後移動は控えめ＋上半身の前傾で寄る → 頭が見切れない
      const zone = getDistanceZone(faceSizeRef?.current ?? 0);

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
    const targetX = fc ? lerp(-1.5, 1.5, 1 - fc.x) : 0; // カメラは鏡像なので反転
    const targetY = fc ? lerp(2.5, 0.5, fc.y) : 1.5;
    const targetZ = 2;
    lookAtTarget.current.position.x = lerp(lookAtTarget.current.position.x, targetX, 0.05);
    lookAtTarget.current.position.y = lerp(lookAtTarget.current.position.y, targetY, 0.05);
    lookAtTarget.current.position.z = targetZ;

    // 発話中のジェスチャー: 腕は基本姿勢のまま、体だけ横揺れさせる
    // (腕を交互に上げる仕草・腕組み等のポーズ切替はどちらも不自然だったため撤去)
    const speaking = speakingRef?.current ?? false;
    const { lArm, rArm, lElbow, rElbow, lShoulder, rShoulder } = gestureBones.current;
    if (lArm && rArm && lElbow && rElbow) {
      if (isGesturing) {
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

      // 来場者の表情に共感：笑顔→happy、驚き→surprised
      // どちらも中間値は使わず、しきい値を超えたら1・それ以外は0の二値判定にする
      const expr = expressionRef?.current;
      if (expr) {
        const smileOn = expr.smile >= SMILE_THRESHOLD;
        const surprisedOn = expr.surprised >= SURPRISED_THRESHOLD;
        // リップシンク中はhappyを控えめに（口モーフと競合するため）
        em.setValue("happy", smileOn ? (speaking ? 0.4 : 0.9) : 0);
        em.setValue("surprised", surprisedOn ? 0.8 : 0);
      }
    }

    vrm.update(delta);
  });

  if (!vrm) return null;
  return <primitive object={vrm.scene} />;
}
