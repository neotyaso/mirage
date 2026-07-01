import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";

// Canvas dimensions (iPhone proportions)
const CW = 390;
const CH = 844;

// App icon grid: 3 cols × 2 rows
const COL_X = [83, 195, 307];
const ROW_Y = [210, 390];
const ICN = 76;
const ICN_R = 18;
const HIT_R = 50; // generous hit radius for gesture control

export type ScreenId = "home" | "photos" | "music" | "about";

const APPS = [
  { id: "photos" as ScreenId, label: "写真",  symbol: "▣", bg: "#FF9500", row: 0, col: 0 },
  { id: "music"  as ScreenId, label: "音楽",  symbol: "♪", bg: "#FF2D55", row: 0, col: 1 },
  { id: "about"  as ScreenId, label: "About", symbol: "i", bg: "#007AFF", row: 0, col: 2 },
  { id: "about"  as ScreenId, label: "連絡",  symbol: "✉", bg: "#34C759", row: 1, col: 0 },
  { id: "about"  as ScreenId, label: "地図",  symbol: "◉", bg: "#5AC8FA", row: 1, col: 1 },
  { id: "about"  as ScreenId, label: "設定",  symbol: "⚙", bg: "#8E8E93", row: 1, col: 2 },
] as const;

// ─── draw helpers ────────────────────────────────────────────────

function rr(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

// Back button constants — large pill at bottom for easy gesture targeting
const BACK_BTN_Y = CH - 140; // top of button
const BACK_BTN_H = 54;
const BACK_BTN_W = 200;
const BACK_BTN_X = (CW - BACK_BTN_W) / 2;
/** v-coordinate threshold (canvas pixels): bottom of this value → back hit */
export const BACK_HIT_MIN_CY = CH - 170;

function drawStatusBar(ctx: CanvasRenderingContext2D) {
  const time = new Date().toLocaleTimeString("ja-JP", {
    hour: "2-digit",
    minute: "2-digit",
  });

  ctx.font = "bold 17px system-ui,-apple-system,sans-serif";
  ctx.textBaseline = "middle";

  // Time (center)
  ctx.fillStyle = "rgba(255,255,255,0.92)";
  ctx.textAlign = "center";
  ctx.fillText(time, CW / 2, 26);

  // Battery (right)
  const bx = CW - 42;
  ctx.strokeStyle = "rgba(255,255,255,0.65)";
  ctx.lineWidth = 1.5;
  ctx.strokeRect(bx, 18, 26, 13);
  ctx.fillStyle = "rgba(255,255,255,0.65)";
  ctx.fillRect(bx + 26, 22, 2.5, 5); // tip
  ctx.fillRect(bx + 2, 20, 18, 9); // charge level
}

function drawBackButton(ctx: CanvasRenderingContext2D, hovered: boolean) {
  // Pill background
  ctx.fillStyle = hovered
    ? "rgba(0,122,255,0.85)"
    : "rgba(255,255,255,0.12)";
  rr(ctx, BACK_BTN_X, BACK_BTN_Y, BACK_BTN_W, BACK_BTN_H, BACK_BTN_H / 2);
  ctx.fill();

  // Border
  ctx.strokeStyle = hovered
    ? "rgba(0,122,255,0.4)"
    : "rgba(255,255,255,0.25)";
  ctx.lineWidth = 1;
  rr(ctx, BACK_BTN_X, BACK_BTN_Y, BACK_BTN_W, BACK_BTN_H, BACK_BTN_H / 2);
  ctx.stroke();

  // Label
  ctx.fillStyle = hovered ? "#ffffff" : "rgba(255,255,255,0.75)";
  ctx.font = "bold 17px system-ui,-apple-system,sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("‹ ホーム", CW / 2, BACK_BTN_Y + BACK_BTN_H / 2);
}

function drawHomeScreen(
  ctx: CanvasRenderingContext2D,
  hoverIdx: number | undefined,
) {
  // Wallpaper gradient
  const bg = ctx.createLinearGradient(0, 0, 0, CH);
  bg.addColorStop(0, "#0c0c2a");
  bg.addColorStop(0.55, "#180828");
  bg.addColorStop(1, "#04040e");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, CW, CH);

  // Subtle star specks
  ctx.fillStyle = "rgba(255,255,255,0.25)";
  for (const [sx, sy] of [
    [40, 90], [130, 55], [260, 110], [340, 70],
    [70, 470], [310, 510], [175, 610], [90, 720],
    [330, 680], [210, 155],
  ]) {
    ctx.beginPath();
    ctx.arc(sx, sy, 1, 0, Math.PI * 2);
    ctx.fill();
  }

  drawStatusBar(ctx);

  // Separator under status bar
  ctx.fillStyle = "rgba(255,255,255,0.05)";
  ctx.fillRect(0, 44, CW, 1);

  // App icons
  for (let i = 0; i < APPS.length; i++) {
    const app = APPS[i];
    const cx = COL_X[app.col];
    const cy = ROW_Y[app.row];
    const hovered = i === hoverIdx;
    const scale = hovered ? 1.1 : 1.0;
    const s = ICN * scale;
    const r = ICN_R * scale;

    if (hovered) {
      ctx.shadowColor = app.bg;
      ctx.shadowBlur = 22;
    }
    ctx.fillStyle = app.bg;
    rr(ctx, cx - s / 2, cy - s / 2, s, s, r);
    ctx.fill();
    ctx.shadowBlur = 0;

    // Symbol
    ctx.fillStyle = "#ffffff";
    ctx.font = `bold 28px system-ui,-apple-system,sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(app.symbol, cx, cy + 1);

    // Label
    ctx.fillStyle = hovered
      ? "rgba(255,255,255,1)"
      : "rgba(255,255,255,0.85)";
    ctx.font = "13px system-ui,-apple-system,sans-serif";
    ctx.textBaseline = "top";
    ctx.fillText(app.label, cx, cy + ICN / 2 + 8);
  }

  // Home indicator
  ctx.fillStyle = "rgba(255,255,255,0.20)";
  rr(ctx, CW / 2 - 58, CH - 28, 116, 5, 3);
  ctx.fill();
}

function drawPhotosScreen(ctx: CanvasRenderingContext2D, backHover: boolean) {
  ctx.fillStyle = "#050510";
  ctx.fillRect(0, 0, CW, CH);
  drawStatusBar(ctx);
  ctx.fillStyle = "rgba(255,255,255,0.08)";
  ctx.fillRect(0, 44, CW, 1);

  // Title
  ctx.font = "bold 22px system-ui,-apple-system,sans-serif";
  ctx.fillStyle = "rgba(255,255,255,0.9)";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("写真", CW / 2, 80);

  // Photo grid (3×3)
  const gap = 3;
  const cell = (CW - gap * 4) / 3;
  const colors = [
    "#3A86FF", "#FF006E", "#8338EC",
    "#FB5607", "#FFBE0B", "#06D6A0",
    "#EF476F", "#118AB2", "#073B4C",
  ];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      const x = gap + c * (cell + gap);
      const y = 110 + r * (cell + gap);
      ctx.fillStyle = colors[r * 3 + c];
      rr(ctx, x, y, cell, cell, 4);
      ctx.fill();
    }
  }

  drawBackButton(ctx, backHover);
  ctx.fillStyle = "rgba(255,255,255,0.20)";
  rr(ctx, CW / 2 - 58, CH - 28, 116, 5, 3);
  ctx.fill();
}

function drawMusicScreen(ctx: CanvasRenderingContext2D, backHover: boolean) {
  ctx.fillStyle = "#050510";
  ctx.fillRect(0, 0, CW, CH);
  drawStatusBar(ctx);
  ctx.fillStyle = "rgba(255,255,255,0.08)";
  ctx.fillRect(0, 44, CW, 1);

  // Album art
  const artX = 60, artY = 100, artS = 270;
  const artGrad = ctx.createLinearGradient(artX, artY, artX + artS, artY + artS);
  artGrad.addColorStop(0, "#FF2D55");
  artGrad.addColorStop(1, "#FF9500");
  ctx.fillStyle = artGrad;
  rr(ctx, artX, artY, artS, artS, 20);
  ctx.fill();

  // Music note on art
  ctx.fillStyle = "rgba(255,255,255,0.4)";
  ctx.font = "80px system-ui,-apple-system,sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("♪", artX + artS / 2, artY + artS / 2);

  // Track info
  ctx.fillStyle = "rgba(255,255,255,0.9)";
  ctx.font = "bold 20px system-ui,-apple-system,sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("Track Title", CW / 2, 400);
  ctx.fillStyle = "rgba(255,255,255,0.5)";
  ctx.font = "16px system-ui,-apple-system,sans-serif";
  ctx.fillText("Artist", CW / 2, 428);

  // Progress bar
  ctx.fillStyle = "rgba(255,255,255,0.15)";
  rr(ctx, 40, 460, CW - 80, 4, 2);
  ctx.fill();
  ctx.fillStyle = "#FF2D55";
  rr(ctx, 40, 460, (CW - 80) * 0.35, 4, 2);
  ctx.fill();

  // Controls
  ctx.fillStyle = "rgba(255,255,255,0.7)";
  ctx.font = "36px system-ui,-apple-system,sans-serif";
  ctx.fillText("⏮", 80,  530);
  ctx.font = "48px system-ui,-apple-system,sans-serif";
  ctx.fillStyle = "rgba(255,255,255,0.95)";
  ctx.fillText("▶", CW / 2, 530);
  ctx.font = "36px system-ui,-apple-system,sans-serif";
  ctx.fillStyle = "rgba(255,255,255,0.7)";
  ctx.fillText("⏭", CW - 80, 530);

  drawBackButton(ctx, backHover);
  ctx.fillStyle = "rgba(255,255,255,0.20)";
  rr(ctx, CW / 2 - 58, CH - 28, 116, 5, 3);
  ctx.fill();
}

function drawAboutScreen(ctx: CanvasRenderingContext2D, backHover: boolean) {
  ctx.fillStyle = "#050510";
  ctx.fillRect(0, 0, CW, CH);
  drawStatusBar(ctx);
  ctx.fillStyle = "rgba(255,255,255,0.08)";
  ctx.fillRect(0, 44, CW, 1);

  // Avatar circle
  const grad = ctx.createRadialGradient(CW / 2, 160, 0, CW / 2, 160, 60);
  grad.addColorStop(0, "#5AC8FA");
  grad.addColorStop(1, "#007AFF");
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(CW / 2, 160, 60, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "rgba(255,255,255,0.5)";
  ctx.font = "50px system-ui,-apple-system,sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("👤", CW / 2, 163);

  // Name / info
  ctx.fillStyle = "rgba(255,255,255,0.95)";
  ctx.font = "bold 26px system-ui,-apple-system,sans-serif";
  ctx.textBaseline = "middle";
  ctx.fillText("KOKI", CW / 2, 255);

  ctx.fillStyle = "rgba(255,255,255,0.5)";
  ctx.font = "15px system-ui,-apple-system,sans-serif";
  ctx.fillText("大学生 / デザイン × テクノロジー", CW / 2, 288);

  // Divider
  ctx.fillStyle = "rgba(255,255,255,0.1)";
  ctx.fillRect(40, 315, CW - 80, 1);

  // Description
  ctx.fillStyle = "rgba(255,255,255,0.75)";
  ctx.font = "15px system-ui,-apple-system,sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";

  const lines = [
    "このデモについて",
    "",
    "WebカメラとAI手認識を使い、",
    "空中に浮かぶスマホUIをピンチ",
    "操作で動かすシステムです。",
    "",
    "実機ゼロ。指だけで操作。",
    "「SFのアレ」を現実にしました。",
  ];
  lines.forEach((line, i) => {
    if (i === 0) {
      ctx.fillStyle = "rgba(255,255,255,0.9)";
      ctx.font = "bold 15px system-ui,-apple-system,sans-serif";
    } else {
      ctx.fillStyle = "rgba(255,255,255,0.65)";
      ctx.font = "15px system-ui,-apple-system,sans-serif";
    }
    ctx.fillText(line, 40, 335 + i * 24);
  });

  drawBackButton(ctx, backHover);
  ctx.fillStyle = "rgba(255,255,255,0.20)";
  rr(ctx, CW / 2 - 58, CH - 28, 116, 5, 3);
  ctx.fill();
}

function drawScreen(
  ctx: CanvasRenderingContext2D,
  screen: ScreenId,
  hoverIdx: number | undefined,
  backHover: boolean
) {
  ctx.clearRect(0, 0, CW, CH);
  if (screen === "home") {
    drawHomeScreen(ctx, hoverIdx);
  } else if (screen === "photos") {
    drawPhotosScreen(ctx, backHover);
  } else if (screen === "music") {
    drawMusicScreen(ctx, backHover);
  } else {
    drawAboutScreen(ctx, backHover);
  }
}

// ─── hook ─────────────────────────────────────────────────────────

export function usePhoneScreen() {
  const [screen, setScreen] = useState<ScreenId>("home");
  const screenRef = useRef<ScreenId>("home");
  const hoverIdxRef = useRef<number | undefined>(undefined);
  const backHoverRef = useRef(false);

  const canvas = useMemo(() => {
    const c = document.createElement("canvas");
    c.width = CW;
    c.height = CH;
    return c;
  }, []);

  const texture = useMemo(() => new THREE.CanvasTexture(canvas), [canvas]);
  useEffect(() => () => texture.dispose(), [texture]);

  const redraw = useCallback(() => {
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    drawScreen(ctx, screenRef.current, hoverIdxRef.current, backHoverRef.current);
    texture.needsUpdate = true;
  }, [canvas, texture]);

  // Initial draw
  useEffect(() => { redraw(); }, [redraw]);

  // Redraw on screen change
  useEffect(() => {
    screenRef.current = screen;
    redraw();
  }, [screen, redraw]);

  // Clock tick (home screen only)
  useEffect(() => {
    const id = setInterval(() => {
      if (screenRef.current === "home") redraw();
    }, 5000);
    return () => clearInterval(id);
  }, [redraw]);

  /**
   * Returns: >=0 = icon index hovered, -2 = back button hovered, -1 = nothing
   */
  const hitTest = useCallback((u: number, v: number): number => {
    const cx = u * CW;
    const cy = v * CH;

    if (screenRef.current !== "home") {
      // Back button: large pill at the bottom of the screen
      if (cy >= BACK_HIT_MIN_CY) return -2;
      return -1;
    }

    for (let i = 0; i < APPS.length; i++) {
      const app = APPS[i];
      const icx = COL_X[app.col];
      const icy = ROW_Y[app.row];
      if (Math.abs(cx - icx) < HIT_R && Math.abs(cy - icy) < HIT_R) return i;
    }
    return -1;
  }, []);

  /** Call from useFrame when hover result changes */
  const setHover = useCallback(
    (result: number) => {
      const newIdx = result >= 0 ? result : undefined;
      const newBack = result === -2;
      if (newIdx === hoverIdxRef.current && newBack === backHoverRef.current) return;
      hoverIdxRef.current = newIdx;
      backHoverRef.current = newBack;
      redraw();
    },
    [redraw]
  );

  /** Call on pinch */
  const tap = useCallback(
    (u: number, v: number) => {
      const idx = hitTest(u, v);
      if (idx === -2) {
        setScreen("home");
      } else if (idx >= 0) {
        setScreen(APPS[idx].id);
      }
    },
    [hitTest]
  );

  return { texture, hitTest, setHover, tap };
}
