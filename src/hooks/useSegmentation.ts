import { useEffect, useRef, useState } from "react";
import { ImageSegmenter, FilesetResolver } from "@mediapipe/tasks-vision";

export interface SegMask {
  /** Category mask. Person pixels are non-zero (background = 0). */
  data: Uint8Array;
  width: number;
  height: number;
}

/**
 * Webカメラ + MediaPipe ImageSegmenter（selfie segmenter）。
 * 毎フレームの人物マスクを ref で返す。
 *
 * - マスクは category mask（Uint8、背景=0 / 人物=非0）。
 * - モデルは public/mediapipe にローカル同梱（オフライン可）。
 */
export function useSegmentation() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const maskRef = useRef<SegMask | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let segmenter: ImageSegmenter | null = null;
    let stream: MediaStream | null = null;
    let rafId = 0;
    let stopped = false;
    let lastVideoTime = -1;
    let buf: Uint8Array | null = null;

    function loop() {
      if (stopped) return;
      const video = videoRef.current;
      if (
        video &&
        segmenter &&
        video.readyState >= 2 &&
        video.currentTime !== lastVideoTime
      ) {
        lastVideoTime = video.currentTime;
        segmenter.segmentForVideo(video, performance.now(), (result) => {
          const cat = result.categoryMask;
          if (cat) {
            const src = cat.getAsUint8Array();
            if (!buf || buf.length !== src.length) buf = new Uint8Array(src.length);
            buf.set(src);
            maskRef.current = { data: buf, width: cat.width, height: cat.height };
          }
          result.close();
        });
      }
      rafId = requestAnimationFrame(loop);
    }

    async function init() {
      try {
        const vision = await FilesetResolver.forVisionTasks("/mediapipe/wasm");
        segmenter = await ImageSegmenter.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: "/mediapipe/selfie_segmenter.tflite",
            delegate: "GPU",
          },
          runningMode: "VIDEO",
          outputCategoryMask: true,
          outputConfidenceMasks: false,
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
      segmenter?.close();
    };
  }, []);

  return { videoRef, maskRef, ready, error };
}
