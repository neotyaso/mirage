import { useEffect, useRef, useState, type RefObject } from "react";
import * as ort from "onnxruntime-web";

const MODEL_URL = "/models/yolov8n.onnx";
const INPUT_SIZE = 640;
const DETECT_INTERVAL_MS = 800; // YOLOはMediaPipeより重いので毎フレームではなく間引いて実行
const CONF_THRESHOLD = 0.45;
const IOU_THRESHOLD = 0.45; // NMS(重複検出の間引き)のIoU閾値

// YOLOv8(COCOデータセット)の80クラス。学習時のクラスID順そのまま（並び替え厳禁）
const COCO_CLASSES = [
  "person", "bicycle", "car", "motorcycle", "airplane", "bus", "train", "truck", "boat",
  "traffic light", "fire hydrant", "stop sign", "parking meter", "bench", "bird", "cat",
  "dog", "horse", "sheep", "cow", "elephant", "bear", "zebra", "giraffe", "backpack",
  "umbrella", "handbag", "tie", "suitcase", "frisbee", "skis", "snowboard", "sports ball",
  "kite", "baseball bat", "baseball glove", "skateboard", "surfboard", "tennis racket",
  "bottle", "wine glass", "cup", "fork", "knife", "spoon", "bowl", "banana", "apple",
  "sandwich", "orange", "broccoli", "carrot", "hot dog", "pizza", "donut", "cake", "chair",
  "couch", "potted plant", "bed", "dining table", "toilet", "tv", "laptop", "mouse",
  "remote", "keyboard", "cell phone", "microwave", "oven", "toaster", "sink", "refrigerator",
  "book", "clock", "vase", "scissors", "teddy bear", "hair drier", "toothbrush",
] as const;

export interface DetectedObject {
  className: string;
  score: number;
  // 0〜1正規化座標（動画フレーム基準）
  x: number;
  y: number;
  width: number;
  height: number;
}

function iou(a: DetectedObject, b: DetectedObject): number {
  const ax2 = a.x + a.width, ay2 = a.y + a.height;
  const bx2 = b.x + b.width, by2 = b.y + b.height;
  const ix1 = Math.max(a.x, b.x), iy1 = Math.max(a.y, b.y);
  const ix2 = Math.min(ax2, bx2), iy2 = Math.min(ay2, by2);
  const iw = Math.max(0, ix2 - ix1), ih = Math.max(0, iy2 - iy1);
  const inter = iw * ih;
  const union = a.width * a.height + b.width * b.height - inter;
  return union > 0 ? inter / union : 0;
}

// クラスごとにグループ化し、スコア降順で貪欲法NMS
function nms(boxes: DetectedObject[]): DetectedObject[] {
  const byClass = new Map<string, DetectedObject[]>();
  for (const b of boxes) {
    if (!byClass.has(b.className)) byClass.set(b.className, []);
    byClass.get(b.className)!.push(b);
  }
  const kept: DetectedObject[] = [];
  for (const group of byClass.values()) {
    group.sort((a, b) => b.score - a.score);
    const used = new Array(group.length).fill(false);
    for (let i = 0; i < group.length; i++) {
      if (used[i]) continue;
      kept.push(group[i]);
      for (let j = i + 1; j < group.length; j++) {
        if (!used[j] && iou(group[i], group[j]) > IOU_THRESHOLD) used[j] = true;
      }
    }
  }
  return kept;
}

export function useObjectDetection(videoRef: RefObject<HTMLVideoElement | null>, enabled: boolean) {
  const objectsRef = useRef<DetectedObject[]>([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    let session: ort.InferenceSession | null = null;
    let timerId: ReturnType<typeof setTimeout> | undefined;

    const canvas = document.createElement("canvas");
    canvas.width = INPUT_SIZE;
    canvas.height = INPUT_SIZE;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });

    async function detectOnce() {
      const video = videoRef.current;
      if (!session || !ctx || !video || video.readyState < 2) return;

      const vw = video.videoWidth, vh = video.videoHeight;
      if (vw === 0 || vh === 0) return;

      // レターボックス: アスペクト比を保って640x640にリサイズ、余白は埋める
      const scale = Math.min(INPUT_SIZE / vw, INPUT_SIZE / vh);
      const rw = Math.round(vw * scale), rh = Math.round(vh * scale);
      const dx = (INPUT_SIZE - rw) / 2, dy = (INPUT_SIZE - rh) / 2;
      ctx.fillStyle = "#727272";
      ctx.fillRect(0, 0, INPUT_SIZE, INPUT_SIZE);
      ctx.drawImage(video, 0, 0, vw, vh, dx, dy, rw, rh);

      const { data } = ctx.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE);
      // HWC(RGBA) -> CHW(RGB)、0-255 -> 0-1 正規化
      const chw = new Float32Array(3 * INPUT_SIZE * INPUT_SIZE);
      const plane = INPUT_SIZE * INPUT_SIZE;
      for (let i = 0; i < plane; i++) {
        chw[i] = data[i * 4] / 255;
        chw[plane + i] = data[i * 4 + 1] / 255;
        chw[plane * 2 + i] = data[i * 4 + 2] / 255;
      }
      const inputTensor = new ort.Tensor("float32", chw, [1, 3, INPUT_SIZE, INPUT_SIZE]);

      let outputMap: ort.InferenceSession.OnnxValueMapType;
      try {
        outputMap = await session.run({ [session.inputNames[0]]: inputTensor });
      } catch (e) {
        console.error("YOLO inference error:", e);
        return;
      }
      const output = outputMap[session.outputNames[0]];
      // 出力形状 [1, 84, 8400]: 84 = box(cx,cy,w,h) + 80クラススコア。8400 = アンカー数
      const dims = output.dims;
      const numAttrs = dims[1]; // 84
      const numAnchors = dims[2]; // 8400
      const buf = output.data as Float32Array;

      const candidates: DetectedObject[] = [];
      for (let a = 0; a < numAnchors; a++) {
        let bestScore = 0, bestClass = -1;
        for (let c = 0; c < numAttrs - 4; c++) {
          const s = buf[(4 + c) * numAnchors + a];
          if (s > bestScore) { bestScore = s; bestClass = c; }
        }
        if (bestScore < CONF_THRESHOLD || bestClass < 0) continue;

        const cx = buf[0 * numAnchors + a];
        const cy = buf[1 * numAnchors + a];
        const w = buf[2 * numAnchors + a];
        const h = buf[3 * numAnchors + a];
        // letterbox座標(640基準) -> 元動画の0-1正規化座標へ逆変換
        const x0 = (cx - w / 2 - dx) / scale / vw;
        const y0 = (cy - h / 2 - dy) / scale / vh;
        const bw = w / scale / vw;
        const bh = h / scale / vh;

        candidates.push({
          className: COCO_CLASSES[bestClass] ?? `class_${bestClass}`,
          score: bestScore,
          x: x0, y: y0, width: bw, height: bh,
        });
      }
      objectsRef.current = nms(candidates);
    }

    async function init() {
      try {
        // onnxruntime-webはwasmのグルーコード(.mjs)を実行時に動的importする独自の仕組みを持っており、
        // Vite dev serverの「/public配下のJSモジュールをimport()経由で読むことを禁止する」ガードと衝突する
        // (本番ビルド`vite build`では発生しない、dev server特有の制限。確認済み)。
        // 開発中だけCDNへ逃がす。本番は明示的にpathを指定せず、Viteのビルドが
        // node_modulesから自動でバンドル・ハッシュ付きURL解決してくれるデフォルト挙動に任せる
        if (import.meta.env.DEV) {
          ort.env.wasm.wasmPaths = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.27.0/dist/";
        }
        ort.env.wasm.numThreads = 1; // COOP/COEPヘッダー無しでも動くようスレッド無効化
        session = await ort.InferenceSession.create(MODEL_URL, {
          executionProviders: ["wasm"],
        });
        if (stopped) return;
        setReady(true);

        const tick = async () => {
          if (stopped) return;
          await detectOnce();
          if (!stopped) timerId = setTimeout(tick, DETECT_INTERVAL_MS);
        };
        tick();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    }

    init();

    return () => {
      stopped = true;
      if (timerId) clearTimeout(timerId);
      session?.release().catch(() => {});
    };
  }, [videoRef, enabled]);

  return { objectsRef, ready, error };
}
