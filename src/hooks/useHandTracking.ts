import { useEffect, useRef, useState } from "react";
import {
  HandLandmarker,
  FilesetResolver,
  type HandLandmarkerResult,
} from "@mediapipe/tasks-vision";

export type HandResults = HandLandmarkerResult | null;

/**
 * Webカメラ + MediaPipe HandLandmarker をセットアップし、
 * 毎フレームの手のランドマークを ref で返す。
 *
 * - 結果は state ではなく ref に入れる（毎フレーム再レンダーを避けるため）。
 * - wasm / モデルは public/mediapipe にローカル同梱（オフラインでも動く）。
 */
export function useHandTracking() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const resultsRef = useRef<HandResults>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let handLandmarker: HandLandmarker | null = null;
    let stream: MediaStream | null = null;
    let rafId = 0;
    let stopped = false;
    let lastVideoTime = -1;

    function loop() {
      if (stopped) return;
      const video = videoRef.current;
      if (
        video &&
        handLandmarker &&
        video.readyState >= 2 &&
        video.currentTime !== lastVideoTime
      ) {
        lastVideoTime = video.currentTime;
        resultsRef.current = handLandmarker.detectForVideo(
          video,
          performance.now(),
        );
      }
      rafId = requestAnimationFrame(loop);
    }

    async function init() {
      try {
        const vision = await FilesetResolver.forVisionTasks("/mediapipe/wasm");
        handLandmarker = await HandLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: "/mediapipe/hand_landmarker.task",
            delegate: "GPU",
          },
          runningMode: "VIDEO",
          numHands: 2,
        });

        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "user", width: 1280, height: 720 },
          audio: false,
        });

        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        await video.play();

        setReady(true);
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
      handLandmarker?.close();
    };
  }, []);

  return { videoRef, resultsRef, ready, error };
}
