import { useEffect, useRef, useState } from "react";
import { FaceLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";
import { Matrix4, Quaternion, Euler, Vector3 } from "three";

const ABSENCE_GRACE_MS = 600;

export interface FaceCenter {
  x: number; // 0〜1（左→右）
  y: number; // 0〜1（上→下）
}

export interface FaceExpression {
  smile: number;    // 0〜1
  surprised: number; // 0〜1
}

// 顔の正規化幅（0〜1）→距離の代理指標
// 目安: <0.12 = 遠い, 0.12〜0.25 = 中距離, >0.25 = 近い
export type DistanceZone = "far" | "mid" | "near" | "absent";

export function getDistanceZone(faceSize: number): DistanceZone {
  if (faceSize <= 0) return "absent";
  if (faceSize < 0.12) return "far";
  if (faceSize < 0.25) return "mid";
  return "near";
}

export function useFaceDetection(enabled: boolean = true) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const presentRef = useRef(false);
  const faceCountRef = useRef(0);
  const faceCenterRef = useRef<FaceCenter | null>(null);
  const faceSizeRef = useRef(0);
  const faceYawRef = useRef(0); // 主対象の頭の左右向き（ラジアン。0=正面、絶対値が大きいほどそっぽを向いている）
  const allFaceCentersRef = useRef<FaceCenter[]>([]);
  const expressionRef = useRef<FaceExpression>({ smile: 0, surprised: 0 });
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) {
      setReady(false);
      return;
    }
    let detector: FaceLandmarker | null = null;
    let stream: MediaStream | null = null;
    let rafId = 0;
    let stopped = false;
    let lastVideoTime = -1;
    let lastSeen = 0;
    // yaw抽出用に使い回すワークオブジェクト（毎フレームnewしない）
    const yawMatrix = new Matrix4();
    const yawPos = new Vector3();
    const yawQuat = new Quaternion();
    const yawScale = new Vector3();
    const yawEuler = new Euler();
    // MediaPipeのfaceLandmarks配列は複数人検出時、フレームごとに並び順が入れ替わりうる
    // （landmarks[0]が別人になる）。素直にindex 0を使うと、2人目が現れた瞬間に
    // カメラ追従・距離判定・視線の基準が別人に急に切り替わってしまう。
    // 直前フレームで「話しかけてる相手」だった顔に最も近い顔を、今回も同一人物として追い続ける。
    let primaryCenter: FaceCenter | null = null;

    function blendshapeScore(
      categories: { categoryName: string; score: number }[],
      ...names: string[]
    ): number {
      let sum = 0;
      let count = 0;
      for (const c of categories) {
        if (names.includes(c.categoryName)) { sum += c.score; count++; }
      }
      return count > 0 ? sum / count : 0;
    }

    function loop() {
      if (stopped) return;
      const video = videoRef.current;
      if (
        video &&
        detector &&
        video.readyState >= 2 &&
        video.currentTime !== lastVideoTime
      ) {
        lastVideoTime = video.currentTime;
        const now = performance.now();
        const result = detector.detectForVideo(video, now);

        const landmarks = result.faceLandmarks ?? [];
        const blendshapes = result.faceBlendshapes ?? [];
        const transforms = result.facialTransformationMatrixes ?? [];
        const count = landmarks.length;
        faceCountRef.current = count;

        if (count > 0) {
          lastSeen = now;

          // 各顔の中心・横幅をランドマークのバウンディングボックスから計算
          const centers: FaceCenter[] = landmarks.map((lm) => {
            const xs = lm.map((p) => p.x);
            const ys = lm.map((p) => p.y);
            const minX = Math.min(...xs), maxX = Math.max(...xs);
            const minY = Math.min(...ys), maxY = Math.max(...ys);
            return {
              x: (minX + maxX) / 2,
              y: (minY + maxY) / 2,
            };
          });
          const widths = landmarks.map((lm) => {
            const xs = lm.map((p) => p.x);
            return Math.max(...xs) - Math.min(...xs);
          });

          // 「話しかけてる相手」の主対象を選ぶ。直前フレームで追っていた位置に一番近い顔を
          // 引き続き主対象にする（見失っていた/初回なら、一番大きい＝一番近い顔を選ぶ）
          let primaryIdx = 0;
          if (primaryCenter) {
            let bestDist = Infinity;
            centers.forEach((c, i) => {
              const d = Math.hypot(c.x - primaryCenter!.x, c.y - primaryCenter!.y);
              if (d < bestDist) { bestDist = d; primaryIdx = i; }
            });
          } else {
            let bestWidth = -Infinity;
            widths.forEach((w, i) => {
              if (w > bestWidth) { bestWidth = w; primaryIdx = i; }
            });
          }
          primaryCenter = centers[primaryIdx];

          allFaceCentersRef.current = centers;
          faceCenterRef.current = centers[primaryIdx] ?? null;
          faceSizeRef.current = widths[primaryIdx] ?? 0;

          // 頭の向き(yaw)を主対象の顔変換行列から抽出（そっぽを向いたか判定するため）
          const matrixData = transforms[primaryIdx]?.data;
          if (matrixData) {
            yawMatrix.fromArray(matrixData);
            yawMatrix.decompose(yawPos, yawQuat, yawScale);
            yawEuler.setFromQuaternion(yawQuat, "YXZ");
            faceYawRef.current = yawEuler.y;
          } else {
            faceYawRef.current = 0;
          }

          // blendshapesから表情スコアを抽出（主対象と同じ人物のインデックス）
          if (blendshapes.length > primaryIdx) {
            const cats = blendshapes[primaryIdx].categories;
            expressionRef.current = {
              smile: blendshapeScore(cats, "mouthSmileLeft", "mouthSmileRight"),
              surprised: blendshapeScore(cats, "browInnerUp", "eyeWideLeft", "eyeWideRight"),
            };
          }
        } else {
          primaryCenter = null;
          faceCenterRef.current = null;
          faceSizeRef.current = 0;
          faceYawRef.current = 0;
          allFaceCentersRef.current = [];
          expressionRef.current = { smile: 0, surprised: 0 };
        }

        presentRef.current = now - lastSeen < ABSENCE_GRACE_MS;
      }
      rafId = requestAnimationFrame(loop);
    }

    async function init() {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "user", width: 640, height: 480 },
          audio: false,
        });
        if (stopped) return;

        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        await video.play();
        setReady(true);

        const vision = await FilesetResolver.forVisionTasks("/mediapipe/wasm");
        detector = await FaceLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: "/mediapipe/face_landmarker.task",
            delegate: "GPU",
          },
          runningMode: "VIDEO",
          numFaces: 4,
          outputFaceBlendshapes: true,
          outputFacialTransformationMatrixes: true,
        });
        if (stopped) return;

        loop();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    }

    init();

    return () => {
      stopped = true;
      cancelAnimationFrame(rafId);
      stream?.getTracks().forEach((t) => t.stop());
      detector?.close();
    };
  }, [enabled]);

  return {
    videoRef,
    presentRef,
    faceCountRef,
    faceCenterRef,
    faceSizeRef,
    faceYawRef,
    allFaceCentersRef,
    expressionRef,
    ready,
    error,
  };
}
