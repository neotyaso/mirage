import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { useFrame } from "@react-three/fiber";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { VRM, VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";
import * as THREE from "three";
import { getDistanceZone } from "../hooks/useFaceDetection";
import type { FaceCenter, FaceExpression, DistanceZone } from "../hooks/useFaceDetection";

const MODEL_URL = "/avatar/sample.vrm";

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

export interface AvatarProps {
  speakingRef?: MutableRefObject<boolean>;
  volumeRef?: MutableRefObject<number>;
  faceCenterRef?: MutableRefObject<FaceCenter | null>;
  allFaceCentersRef?: MutableRefObject<FaceCenter[]>;
  expressionRef?: MutableRefObject<FaceExpression>;
  faceSizeRef?: MutableRefObject<number>;
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
// 不足分は「上半身の前傾（覗き込み）」で出す。頭は必ずフレーム内に残る
// 逆に反っちゃう場合は符号を反転（-0.22）
const LEAN_MAX = 0.22; // ラジアン（約13°）

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

export function Avatar({ speakingRef, volumeRef, faceCenterRef, allFaceCentersRef, expressionRef, faceSizeRef }: AvatarProps) {
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
  }>({});
  const gestureClock = useRef(0);
  const gestureSeed = useRef(Math.random() * 10);

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
        if (lArm) { lArm.rotation.z = -1.2; lArm.rotation.x = 0.1; }
        if (rArm) { rArm.rotation.z =  1.2; rArm.rotation.x = 0.1; }
        // 肘を軽く曲げる（より自然に）
        if (lElbow) lElbow.rotation.z = -0.15;
        if (rElbow) rElbow.rotation.z =  0.15;
        gestureBones.current = { lArm, rArm, lElbow, rElbow };

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

  useFrame((state, delta) => {
    if (!vrm) return;
    const t = state.clock.elapsedTime;

    // 呼吸（わずかに上下）
    vrm.scene.position.y = Math.sin(t * 1.1) * 0.004;

    // 接近演出: 来場者が近いほどキャラが「覗き込む」
    // 体ごとの前後移動は控えめ＋上半身の前傾で寄る → 頭が見切れない
    const zone = getDistanceZone(faceSizeRef?.current ?? 0);
    approach.current = lerp(approach.current, ZONE_APPROACH[zone], APPROACH_LERP);
    const a = approach.current;
    vrm.scene.position.z = lerp(APPROACH_Z_BACK, APPROACH_Z_FRONT, a);
    const spine = vrm.humanoid?.getNormalizedBoneNode("spine");
    if (spine) spine.rotation.x = a * LEAN_MAX;

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

    // 発話中のジェスチャー: 喋ってる間だけ腕を揺らす。周波数を左右・複数重ねて機械的な繰り返しを避ける
    const speaking = speakingRef?.current ?? false;
    const { lArm, rArm, lElbow, rElbow } = gestureBones.current;
    if (lArm && rArm && lElbow && rElbow) {
      if (speaking) {
        gestureClock.current += delta;
        const gt = gestureClock.current;
        const lWave = Math.sin(gt * 1.6 + gestureSeed.current) * 0.5 + Math.sin(gt * 0.7) * 0.2;
        const rWave = Math.sin(gt * 1.3 + gestureSeed.current + 1.7) * 0.5 + Math.sin(gt * 0.5 + 2) * 0.2;
        lArm.rotation.z = -1.2 + lWave * 0.25;
        lArm.rotation.x = 0.1 - Math.max(0, lWave) * 0.3;
        lElbow.rotation.z = -0.15 + lWave * 0.35;
        rArm.rotation.z = 1.2 - rWave * 0.25;
        rArm.rotation.x = 0.1 - Math.max(0, rWave) * 0.3;
        rElbow.rotation.z = 0.15 - rWave * 0.35;
      } else {
        gestureClock.current = 0;
        // 喋ってない間は基本姿勢へ滑らかに戻す
        lArm.rotation.z = lerp(lArm.rotation.z, -1.2, 0.05);
        lArm.rotation.x = lerp(lArm.rotation.x, 0.1, 0.05);
        lElbow.rotation.z = lerp(lElbow.rotation.z, -0.15, 0.05);
        rArm.rotation.z = lerp(rArm.rotation.z, 1.2, 0.05);
        rArm.rotation.x = lerp(rArm.rotation.x, 0.1, 0.05);
        rElbow.rotation.z = lerp(rElbow.rotation.z, 0.15, 0.05);
      }
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
      const expr = expressionRef?.current;
      if (expr) {
        // リップシンク中はhappyを控えめに（口モーフと競合するため）
        const smileTarget = speaking ? expr.smile * 0.4 : expr.smile * 0.9;
        em.setValue("happy", clamp01(smileTarget));
        em.setValue("surprised", clamp01(expr.surprised * 0.8));
      }
    }

    vrm.update(delta);
  });

  if (!vrm) return null;
  return <primitive object={vrm.scene} />;
}
