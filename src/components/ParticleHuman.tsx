import { useMemo } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import type { MutableRefObject } from "react";
import type { SegMask } from "../hooks/useSegmentation";

// Sampling grid (≈16:9). Each cell → at most one particle.
const GW = 220;
const GH = 124;
const MAX = GW * GH;

const OFFSCREEN = -9999;

export interface DebugStats {
  maskW: number;
  maskH: number;
  count: number;
  vw: number;
}

export interface ParticleHumanProps {
  videoRef: MutableRefObject<HTMLVideoElement | null>;
  maskRef: MutableRefObject<SegMask | null>;
  debugRef?: MutableRefObject<DebugStats>;
}

/**
 * 人物マスク内のピクセルを、元映像の色を持つ粒子として描画する。
 * 自分の姿が「砂粒でできた像」になって映る（最小スライス）。
 */
export function ParticleHuman({ videoRef, maskRef, debugRef }: ParticleHumanProps) {
  const { viewport } = useThree();

  // 色サンプリング用のオフスクリーンcanvas
  const colorCtx = useMemo(() => {
    const c = document.createElement("canvas");
    c.width = GW;
    c.height = GH;
    return c.getContext("2d", { willReadFrequently: true })!;
  }, []);

  const { positions, colors, geometry } = useMemo(() => {
    const positions = new Float32Array(MAX * 3);
    const colors = new Float32Array(MAX * 3);
    for (let i = 0; i < MAX; i++) positions[i * 3 + 1] = OFFSCREEN;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    return { positions, colors, geometry };
  }, []);

  useFrame(() => {
    const video = videoRef.current;
    const mask = maskRef.current;
    if (!video || !mask || video.readyState < 2) return;

    // 縮小して色を取得
    colorCtx.drawImage(video, 0, 0, GW, GH);
    const img = colorCtx.getImageData(0, 0, GW, GH).data;

    const vw = viewport.width;
    const vh = viewport.height;
    const mw = mask.width;
    const mh = mask.height;
    const md = mask.data;

    let p = 0;
    for (let gy = 0; gy < GH; gy++) {
      const my = ((gy / GH) * mh) | 0;
      const maskRow = my * mw;
      for (let gx = 0; gx < GW; gx++) {
        const mx = ((gx / GW) * mw) | 0;
        if (md[maskRow + mx] > 0) {
          const i3 = p * 3;
          // ミラー表示に合わせて x を反転
          positions[i3] = (0.5 - gx / GW) * vw;
          positions[i3 + 1] = (0.5 - gy / GH) * vh;
          positions[i3 + 2] = 0;
          const ci = (gy * GW + gx) * 4;
          colors[i3] = img[ci] / 255;
          colors[i3 + 1] = img[ci + 1] / 255;
          colors[i3 + 2] = img[ci + 2] / 255;
          p++;
          if (p >= MAX) break;
        }
      }
      if (p >= MAX) break;
    }
    // 余った粒子は画面外へ
    for (let i = p; i < MAX; i++) positions[i * 3 + 1] = OFFSCREEN;

    geometry.attributes.position.needsUpdate = true;
    geometry.attributes.color.needsUpdate = true;

    if (debugRef) debugRef.current = { maskW: mw, maskH: mh, count: p, vw };
  });

  return (
    <points geometry={geometry} frustumCulled={false}>
      <pointsMaterial
        size={0.03}
        vertexColors
        transparent
        opacity={0.95}
        sizeAttenuation
        depthWrite={false}
      />
    </points>
  );
}
