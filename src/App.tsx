import { useEffect, useRef, type CSSProperties } from "react";
import { useHandTracking } from "./hooks/useHandTracking";

/**
 * 第一スライス: トラッキング検証ビュー。
 * Webカメラ（ミラー表示）の上に、手の21ランドマークと
 * ピンチ判定を Canvas2D で描く。
 *
 * パイプライン（カメラ→手検出→ピンチ）が動くことを確認するのが目的。
 * 本命の「空中スマホ UI」はこの後 R3F で作る。
 */
export default function App() {
  const { videoRef, resultsRef, ready, error } = useHandTracking();
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let raf = 0;

    function draw() {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (canvas && ctx) {
        const w = (canvas.width = window.innerWidth);
        const h = (canvas.height = window.innerHeight);
        ctx.clearRect(0, 0, w, h);

        const results = resultsRef.current;
        if (results) {
          // x はミラー表示に合わせて反転
          const px = (lm: { x: number }) => (1 - lm.x) * w;
          const py = (lm: { y: number }) => lm.y * h;

          for (const hand of results.landmarks) {
            // 21点
            ctx.fillStyle = "#4af";
            for (const lm of hand) {
              ctx.beginPath();
              ctx.arc(px(lm), py(lm), 4, 0, Math.PI * 2);
              ctx.fill();
            }

            // ピンチ判定（親指先=4, 人差し指先=8）
            const thumb = hand[4];
            const index = hand[8];
            const tx = px(thumb);
            const ty = py(thumb);
            const ix = px(index);
            const iy = py(index);
            const dist = Math.hypot(tx - ix, ty - iy);
            const pinched = dist < 40;

            ctx.strokeStyle = pinched ? "#0f8" : "rgba(255,255,255,0.6)";
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(tx, ty);
            ctx.lineTo(ix, iy);
            ctx.stroke();

            const mx = (tx + ix) / 2;
            const my = (ty + iy) / 2;
            ctx.beginPath();
            ctx.arc(mx, my, pinched ? 26 : 12, 0, Math.PI * 2);
            ctx.fillStyle = pinched
              ? "rgba(0,255,136,0.35)"
              : "rgba(255,255,255,0.12)";
            ctx.fill();
          }
        }
      }
      raf = requestAnimationFrame(draw);
    }

    draw();
    return () => cancelAnimationFrame(raf);
  }, [resultsRef]);

  return (
    <div style={{ position: "fixed", inset: 0, background: "#000" }}>
      <video
        ref={videoRef}
        playsInline
        muted
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          objectFit: "cover",
          transform: "scaleX(-1)",
        }}
      />
      <canvas
        ref={canvasRef}
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
      />

      {!ready && !error && (
        <div style={overlayStyle}>
          カメラを起動中… ブラウザのカメラ許可を押してください
        </div>
      )}
      {error && (
        <div style={{ ...overlayStyle, color: "#f66" }}>エラー: {error}</div>
      )}

      <div style={hintStyle}>
        親指と人差し指をくっつける = ピンチ（タップ） / 最大2手まで認識
      </div>
    </div>
  );
}

const overlayStyle: CSSProperties = {
  position: "absolute",
  top: "50%",
  left: "50%",
  transform: "translate(-50%, -50%)",
  padding: "12px 20px",
  background: "rgba(0,0,0,0.6)",
  borderRadius: 8,
  fontSize: 14,
};

const hintStyle: CSSProperties = {
  position: "absolute",
  bottom: 16,
  left: "50%",
  transform: "translateX(-50%)",
  padding: "6px 14px",
  background: "rgba(0,0,0,0.5)",
  borderRadius: 6,
  fontSize: 12,
  color: "#bbb",
  whiteSpace: "nowrap",
};
