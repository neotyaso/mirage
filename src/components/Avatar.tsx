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
const SIT_URL = "/avatar/sit.vrma";

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
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
  actionRef?: MutableRefObject<{ tag: "nod" | "tilt"; id: number } | null>;
  // 座りモーション(手動プレビュー用)。trueの間sit.vrmaへ重みをブレンドし、椅子の位置に固定する
  sittingRef?: MutableRefObject<boolean>;
  // 座り姿勢(腕・肘・肩)のライブ調整用。未指定ならDEFAULT_SIT_POSEを使う
  sitPoseRef?: MutableRefObject<{ armX: number; armZ: number; elbowZ: number; shoulderX: number; shoulderZ: number }>;
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
// 範囲・障害物座標はBlenderで作った部屋(public/scene/room.glb)の実測レイアウトに合わせた値
const WANDER_BOUNDS = { xMin: -1.5, xMax: 1.5, zMin: -1.6, zMax: 0.5 };
const TABLE_OBSTACLE = { x: 0.8, z: -0.55, r: 0.75 };
const CHAIR_OBSTACLE = { x: 1.25, z: -1.15, r: 0.75 };
const WANDER_OBSTACLES = [TABLE_OBSTACLE, CHAIR_OBSTACLE];
const WANDER_SPEED = 0.35; // m/s
const WANDER_ARRIVE_DIST = 0.12;
const WANDER_PAUSE_MIN = 2;
const WANDER_PAUSE_MAX = 5;

// 椅子(room.glbのChair_Seat実測値: Blender座標 x=1.25,y=1.15,座面高0.46m → three.js座標に変換)
// 椅子の背もたれが-Z側にあるため、+Z(部屋の中央・来場者側)を向いて座る
const CHAIR_POS = { x: 1.25, z: -1.15 };
const CHAIR_YAW = 0;
// 椅子の物理的な大きさ(座面0.5m四方+背もたれ)より手前で止まり、歩いて貫通しないようにする。
// 最後の詰めは着席モーションに合わせて滑らかにスライドさせる(SIT_SETTLE_LERP)
const CHAIR_ARRIVE_DIST = 0.55;
const SIT_SETTLE_LERP = 0.08;
const SIT_Y_OFFSET = -0.35; // Mixamo側の椅子とroom.glbの椅子で座面高さが違うための補正(実機確認で調整)
const SIT_DURATION_MIN = 6; // 秒。座ってから立ち上がるまでの長さ
const SIT_DURATION_MAX = 14;
const GO_SIT_CHANCE = 0.35; // 徘徊の一時停止のたびに椅子へ向かう確率

// 徘徊・移動中に障害物(机・椅子)へ直進してめり込まないよう、近づいたら押し返す。
// 椅子に座りに行く時は椅子自体は避けたい障害物から除外する(obstaclesで切り替え)
function avoidObstacles(
  px: number, pz: number, dirX: number, dirZ: number,
  obstacles: { x: number; z: number; r: number }[]
): { x: number; z: number } {
  let ax = dirX;
  let az = dirZ;
  for (const o of obstacles) {
    const dx = px - o.x;
    const dz = pz - o.z;
    const dist = Math.hypot(dx, dz);
    const margin = o.r + 0.3;
    if (dist < margin && dist > 0.001) {
      const push = (margin - dist) / margin;
      ax += (dx / dist) * push * 1.5;
      az += (dz / dist) * push * 1.5;
    }
  }
  const len = Math.hypot(ax, az);
  return len > 0.001 ? { x: ax / len, z: az / len } : { x: dirX, z: dirZ };
}

function pickWanderTarget(): { x: number; z: number } {
  for (let i = 0; i < 20; i++) {
    const x = lerp(WANDER_BOUNDS.xMin, WANDER_BOUNDS.xMax, Math.random());
    const z = lerp(WANDER_BOUNDS.zMin, WANDER_BOUNDS.zMax, Math.random());
    const blocked = WANDER_OBSTACLES.some((o) => Math.hypot(x - o.x, z - o.z) < o.r);
    if (!blocked) return { x, z };
  }
  return { x: 0, z: APPROACH_Z_BACK };
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

// 座り中の腕(手続き型・固定ポーズ)。Mixamoの座りモーションは腕に「髪を触る」ような
// ジェスチャーが入っていて不自然だったため、腕だけは膝の上に置く固定ポーズで上書きする
// Playgroundの座り姿勢調整スライダーで実機確認しながら決定した値(2026-07-10)
const SIT_ARM = { z: 1.34, x: -0.91 };  // 右腕基準。左は z を反転
const SIT_ELBOW = { z: 0.56 };          // 右肘基準。左は z を反転
const SIT_SHOULDER = { x: -0.25, z: 0.18 }; // 右肩基準。左は z を反転
// 座り姿勢の初期値(Playgroundのスライダーで上書きされていない時のデフォルト)
export const DEFAULT_SIT_POSE = {
  armX: SIT_ARM.x,
  armZ: SIT_ARM.z,
  elbowZ: SIT_ELBOW.z,
  shoulderX: SIT_SHOULDER.x,
  shoulderZ: SIT_SHOULDER.z,
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

export function Avatar({ speakingRef, volumeRef, faceCenterRef, allFaceCentersRef, expressionRef, faceSizeRef, actionRef, sittingRef, sitPoseRef }: AvatarProps) {
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
  // 座りモーション(手動プレビュー用)
  const sitMixer = useRef<THREE.AnimationMixer | null>(null);
  const sitAction = useRef<THREE.AnimationAction | null>(null);
  const sitWeight = useRef(0);
  const wanderTarget = useRef({ x: 0, z: APPROACH_Z_BACK });
  const wanderPauseUntil = useRef(0);
  const bodyYaw = useRef(0);
  // 椅子に座る行動(不在時のみ)。roam=徘徊 / toChair=椅子へ移動中 / sitting=着席中
  const chairState = useRef<"roam" | "toChair" | "sitting">("roam");
  const sitClock = useRef(0);
  const sitDuration = useRef(SIT_DURATION_MIN);
  const autoSitting = useRef(false); // 行動AIが決めた着席状態(手動プレビューのsittingRefとは別)
  const wasManualSitting = useRef(false); // 手動座りプレビューをOFFにした瞬間を検知し、AI徘徊へ復帰させるため
  const wasSittingForArms = useRef(false); // isSittingがtrue→falseになった瞬間を検知し、腕を強制リセットするため
  // "head"はVRMのLookAt(視線追従)が毎フレーム上書きするため、代わりに"neck"を使う
  const neckBone = useRef<THREE.Object3D | null>(null);
  const lastActionId = useRef(0);
  const activeAction = useRef<{ tag: "nod" | "tilt"; t: number; dir: 1 | -1 } | null>(null);

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

  // 座りモーションの読み込み(手動プレビュー用)。walkと同じ作り
  useEffect(() => {
    if (!vrm) return;
    let alive = true;
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMAnimationLoaderPlugin(parser));

    loader.load(
      SIT_URL,
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

        sitMixer.current = mixer;
        sitAction.current = action;
      },
      undefined,
      (e) => console.error("sit VRMA load error:", e)
    );

    return () => {
      alive = false;
    };
  }, [vrm]);

  useFrame((state, delta) => {
    if (!vrm) return;
    const t = state.clock.elapsedTime;

    // 歩行クリップ(腰・脚・背骨)の再生。手続き型の各処理より先に評価し、
    // 腕など手続き型が管理するボーンは後段の処理で上書きされるようにする
    walkMixer.current?.update(delta);

    // 座りモーション。手動プレビュー(sittingRef)か行動AI(autoSitting)のどちらかがtrueなら重みを乗せる
    const manualSitting = sittingRef?.current ?? false;
    const isSitting = manualSitting || autoSitting.current;
    sitWeight.current = lerp(sitWeight.current, isSitting ? 1 : 0, 0.08);
    sitAction.current?.setEffectiveWeight(sitWeight.current);
    sitMixer.current?.update(delta);

    // 行動タグ由来のアクション（頷く／首をかしげる）: 新規トリガーを検知したら開始
    const action = actionRef?.current;
    if (action && action.id !== lastActionId.current) {
      lastActionId.current = action.id;
      // tiltは左右どちらに傾げるかを毎回ランダムに決める（nodは前後のみなので常に1）
      const dir: 1 | -1 = action.tag === "tilt" && Math.random() < 0.5 ? -1 : 1;
      activeAction.current = { tag: action.tag, t: 0, dir };
    }
    if (activeAction.current && neckBone.current) {
      activeAction.current.t += delta;
      const p = activeAction.current.t / ACTION_DURATION_S;
      if (p >= 1) {
        neckBone.current.rotation.x = 0;
        neckBone.current.rotation.z = 0;
        activeAction.current = null;
      } else {
        // 0→1→0の三角波（往復）でモーションの山を作る
        const wave = Math.sin(p * Math.PI);
        if (activeAction.current.tag === "nod") {
          neckBone.current.rotation.x = wave * NOD_ANGLE;
        } else {
          neckBone.current.rotation.z = wave * TILT_ANGLE * activeAction.current.dir;
        }
      }
    }

    let isWalking = false;
    let retreating = false;

    if (manualSitting) {
      // 常時座りプレビュー(Playground手動): AIの徘徊/接近ロジックを止めて椅子の位置に固定し、
      // 姿勢調整に集中できるようにする(ワープではなく毎フレーム直接代入で完全に静止させる)
      vrm.scene.position.x = CHAIR_POS.x;
      vrm.scene.position.z = CHAIR_POS.z;
      bodyYaw.current = CHAIR_YAW;
      vrm.scene.rotation.y = CHAIR_YAW;
      chairState.current = "sitting";
      autoSitting.current = false;
      sitClock.current = 0;
      wasManualSitting.current = true;
    } else {
      if (wasManualSitting.current) {
        // 手動プレビューOFFの瞬間: AI徘徊へ自然に復帰させる
        wasManualSitting.current = false;
        chairState.current = "roam";
        wanderTarget.current = pickWanderTarget();
        wanderPauseUntil.current = t + lerp(WANDER_PAUSE_MIN, WANDER_PAUSE_MAX, Math.random());
      }

      // 接近演出: 来場者が近いほどキャラが「覗き込む」
      // 体ごとの前後移動は控えめ＋上半身の前傾で寄る → 頭が見切れない
      const zone = getDistanceZone(faceSizeRef?.current ?? 0);

      if (zone === "absent") {
        // 誰もいない間は部屋の中をランダムに歩き回り、時々椅子に座って一息つく
        approach.current = lerp(approach.current, 0, APPROACH_LERP);

        if (chairState.current === "sitting") {
          isWalking = false;
          autoSitting.current = true;
          // 立ち止まった位置から座面の正確な位置まで滑らかにスライドさせる(貫通を避けるため手前で止まっているギャップを埋める)
          vrm.scene.position.x = lerp(vrm.scene.position.x, CHAIR_POS.x, SIT_SETTLE_LERP);
          vrm.scene.position.z = lerp(vrm.scene.position.z, CHAIR_POS.z, SIT_SETTLE_LERP);
          bodyYaw.current = lerpAngle(bodyYaw.current, CHAIR_YAW, 0.1);
          vrm.scene.rotation.y = bodyYaw.current;

          sitClock.current += delta;
          if (sitClock.current > sitDuration.current) {
            chairState.current = "roam";
            // ここで即座にfalseにしないと、次フレーム冒頭のisSitting計算(autoSitting参照)が
            // 古い値を読んでしまい、chairStateはもう"roam"なのにisSittingだけ1フレーム
            // 遅れてtrueのまま残ってしまう(腕が座り姿勢のまま固定される一因になっていた)
            autoSitting.current = false;
            wanderTarget.current = pickWanderTarget();
            wanderPauseUntil.current = t + lerp(WANDER_PAUSE_MIN, WANDER_PAUSE_MAX, Math.random());
          }
        } else if (chairState.current === "toChair") {
          autoSitting.current = false;
          const dx = CHAIR_POS.x - vrm.scene.position.x;
          const dz = CHAIR_POS.z - vrm.scene.position.z;
          const dist = Math.hypot(dx, dz);

          if (dist < CHAIR_ARRIVE_DIST) {
            isWalking = false;
            chairState.current = "sitting";
            sitClock.current = 0;
            sitDuration.current = lerp(SIT_DURATION_MIN, SIT_DURATION_MAX, Math.random());
          } else {
            isWalking = true;
            // 椅子自体は避ける対象から除外(そこへ向かっているので)。机だけは避ける
            const avoided = avoidObstacles(vrm.scene.position.x, vrm.scene.position.z, dx / dist, dz / dist, [TABLE_OBSTACLE]);
            const step = Math.min(WANDER_SPEED * delta, dist);
            vrm.scene.position.x += avoided.x * step;
            vrm.scene.position.z += avoided.z * step;
            const targetYaw = Math.atan2(dx, dz);
            bodyYaw.current = lerpAngle(bodyYaw.current, targetYaw, 0.08);
            vrm.scene.rotation.y = bodyYaw.current;
          }
        } else {
          // roam: 通常の徘徊。一時停止のたびに一定確率で椅子へ向かう
          autoSitting.current = false;
          const dx = wanderTarget.current.x - vrm.scene.position.x;
          const dz = wanderTarget.current.z - vrm.scene.position.z;
          const dist = Math.hypot(dx, dz);

          if (dist < WANDER_ARRIVE_DIST) {
            isWalking = false;
            if (t > wanderPauseUntil.current) {
              if (Math.random() < GO_SIT_CHANCE) {
                chairState.current = "toChair";
              } else {
                wanderPauseUntil.current = t + lerp(WANDER_PAUSE_MIN, WANDER_PAUSE_MAX, Math.random());
                wanderTarget.current = pickWanderTarget();
              }
            }
          } else {
            isWalking = true;
            const avoided = avoidObstacles(vrm.scene.position.x, vrm.scene.position.z, dx / dist, dz / dist, WANDER_OBSTACLES);
            const step = Math.min(WANDER_SPEED * delta, dist);
            vrm.scene.position.x += avoided.x * step;
            vrm.scene.position.z += avoided.z * step;
            const targetYaw = Math.atan2(dx, dz);
            bodyYaw.current = lerpAngle(bodyYaw.current, targetYaw, 0.08);
            vrm.scene.rotation.y = bodyYaw.current;
          }
        }
      } else {
        // 来場者検知中: 座っていれば中断して立ち上がりつつ、正面(中央)へ戻りながら既存の接近演出を行う。
        // 徘徊中はscene.position.x/zが部屋のどこにあるか分からないため、
        // 目標値へ直接代入せずlerpで滑らかに近づける(でないと検知した瞬間にワープして見える)
        if (chairState.current !== "roam") {
          chairState.current = "roam";
          sitClock.current = 0;
        }
        autoSitting.current = false;
        const approachTarget = ZONE_APPROACH[zone];
        approach.current = lerp(approach.current, approachTarget, APPROACH_LERP);
        const a = approach.current;
        const targetZ = lerp(APPROACH_Z_BACK, APPROACH_Z_FRONT, a);
        vrm.scene.position.z = lerp(vrm.scene.position.z, targetZ, 0.05);
        vrm.scene.position.x = lerp(vrm.scene.position.x, 0, 0.05);
        bodyYaw.current = lerpAngle(bodyYaw.current, 0, 0.05);
        vrm.scene.rotation.y = bodyYaw.current;

        const approaching = approachTarget > approach.current + 0.03;
        retreating = approachTarget < approach.current - 0.03;
        const returningFromWander = Math.abs(vrm.scene.position.x) > 0.05 || Math.abs(vrm.scene.position.z - targetZ) > 0.05;
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
    // 座高補正: Mixamo側の椅子とroom.glbの椅子で座面の高さが違うため、座り重みに応じて沈める
    vrm.scene.position.y = Math.sin(t * 1.1) * 0.004 + walkBob + SIT_Y_OFFSET * sitWeight.current;

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
      // isSittingがtrue→falseになった"その瞬間"だけ、腕・肘・肩を基本姿勢へ強制的にハードリセットする。
      // walkWeightのタイミングに依存する補正(このすぐ下のisWalking分岐)だけでは、環境によって
      // 収束が間に合わず座り姿勢の値が一瞬残ってしまうケースがあったための保険
      if (wasSittingForArms.current && !isSitting) {
        lArm.rotation.set(0.1, 0, -1.2);
        lElbow.rotation.set(0, 0, -0.15);
        rArm.rotation.set(0.1, 0, 1.2);
        rElbow.rotation.set(0, 0, 0.15);
        if (lShoulder) lShoulder.rotation.set(0, 0, 0);
        if (rShoulder) rShoulder.rotation.set(0, 0, 0);
      }
      wasSittingForArms.current = isSitting;

      if (speaking) {
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
      } else if (isSitting && sitAction.current) {
        gestureClock.current = 0;
        if (chest) chest.rotation.z = lerp(chest.rotation.z, 0, 0.05);
        // sitクリップ自体の腕モーション(髪を触る仕草)は不自然だったため、
        // 腕だけは膝の上に置く固定ポーズで上書きする(脚・腰・背骨はクリップのまま)。
        // sitMixerが毎フレームこのボーンをidentityに書き戻すため、lerpの基準にすると
        // 蓄積されず戻ってしまう→直接代入で毎フレーム上書きする
        const pose = sitPoseRef?.current ?? DEFAULT_SIT_POSE;
        lArm.rotation.set(pose.armX, 0, -pose.armZ);
        lElbow.rotation.set(0, 0, -pose.elbowZ);
        rArm.rotation.set(pose.armX, 0, pose.armZ);
        rElbow.rotation.set(0, 0, pose.elbowZ);
        // sitクリップは肩(鎖骨)ボーンも動かしており、upperArm/lowerArmだけ上書きしても
        // 肩が持ち上がったまま→腕全体が横に流れて見える原因になっていたのでゼロ付近に戻す
        // (Playgroundのスライダーで微調整できるようshoulderX/Zも上書き対象にしている)
        if (lShoulder) lShoulder.rotation.set(pose.shoulderX, 0, -pose.shoulderZ);
        if (rShoulder) rShoulder.rotation.set(pose.shoulderX, 0, pose.shoulderZ);
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
