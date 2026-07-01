import { useEffect, useRef, useState } from "react";
import { FaceLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";

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

export function useFaceDetection() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const presentRef = useRef(false);
  const faceCountRef = useRef(0);
  const faceCenterRef = useRef<FaceCenter | null>(null);
  const faceSizeRef = useRef(0);
  const allFaceCentersRef = useRef<FaceCenter[]>([]);
  const expressionRef = useRef<FaceExpression>({ smile: 0, surprised: 0 });
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let detector: FaceLandmarker | null = null;
    let stream: MediaStream | null = null;
    let rafId = 0;
    let stopped = false;
    let lastVideoTime = -1;
    let lastSeen = 0;

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
        const count = landmarks.length;
        faceCountRef.current = count;

        if (count > 0) {
          lastSeen = now;
          const vw = video.videoWidth || 640;
          const vh = video.videoHeight || 480;

          // 各顔の中心をランドマークのバウンディングボックスから計算
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

          // 1人目のfaceSize（横幅）
          const lm0 = landmarks[0];
          const xs0 = lm0.map((p) => p.x);
          const faceWidth = Math.max(...xs0) - Math.min(...xs0);

          allFaceCentersRef.current = centers;
          faceCenterRef.current = centers[0] ?? null;
          faceSizeRef.current = faceWidth;

          // blendshapesから表情スコアを抽出（1人目）
          if (blendshapes.length > 0) {
            const cats = blendshapes[0].categories;
            expressionRef.current = {
              smile: blendshapeScore(cats, "mouthSmileLeft", "mouthSmileRight"),
              surprised: blendshapeScore(cats, "browInnerUp", "eyeWideLeft", "eyeWideRight"),
            };
          }
        } else {
          faceCenterRef.current = null;
          faceSizeRef.current = 0;
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
  }, []);

  return {
    videoRef,
    presentRef,
    faceCountRef,
    faceCenterRef,
    faceSizeRef,
    allFaceCentersRef,
    expressionRef,
    ready,
    error,
  };
}
