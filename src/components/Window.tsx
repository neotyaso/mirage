import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";

/**
 * 奥壁の「外が見える窓」。room.glbには入れず、Three.jsで直接描く
 * （glTFのemissiveプレーンがアプリで正しく出ない相性問題を回避＋HMRで即調整できるため）。
 *
 * 外景はGLSLで手続き的に生成（明るい昼空＋やわらかい木立＋太陽グロー、雲がゆっくり流れる）。
 * 画像アセット不要で滑らか。ShaderMaterialは光の影響を受けず色をそのまま出す＝昼の窓のように明るい。
 *
 * off-axisカメラ(App.tsxのOffAxisCamera)で来場者が動くと、窓の外景と手前の枠・部屋に
 * 視差が生まれ「窓の向こうに別世界」感が強まる。
 */

// 奥壁(z=-2)のすぐ手前・中央。開口サイズ1.3m角、床から見て中ほどの高さ
const WIN_W = 1.3;
const WIN_H = 1.3;
const WIN_POS: [number, number, number] = [0, 1.5, -1.98];

const viewVertex = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const viewFragment = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform float uTime;

  float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p){
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i+vec2(1,0)), u.x),
               mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), u.x), u.y);
  }
  float fbm(vec2 p){
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 4; i++){ v += a * noise(p); p *= 2.0; a *= 0.5; }
    return v;
  }

  void main(){
    vec2 uv = vUv;                       // (0,0)=左下, (1,1)=右上
    // ゆるやかに波打つ木立のライン
    float horizon = 0.42 + (fbm(vec2(uv.x * 3.0, 1.0)) - 0.5) * 0.06;

    // 空（地平線より上）: 上=淡い青 → 地平線=暖色クリーム
    float ts = clamp((uv.y - horizon) / (1.0 - horizon), 0.0, 1.0);
    vec3 sky = mix(vec3(0.98, 0.95, 0.87), vec3(0.55, 0.72, 0.88), ts);
    // うっすら雲（ゆっくり流れる）
    float cl = smoothstep(0.55, 0.9, fbm(uv * vec2(4.0, 3.0) + vec2(uTime * 0.012, 0.0))) * ts;
    sky = mix(sky, vec3(1.0), cl * 0.28);

    // 木立（地平線より下）: なめらかノイズ＋下ほど暗く
    float fn = fbm(uv * vec2(9.0, 9.0));
    vec3 fol = vec3(0.30, 0.46, 0.22) * (0.7 + 0.7 * fn);
    float depth = clamp((horizon - uv.y) / max(horizon, 0.01), 0.0, 1.0);
    fol *= (1.0 - 0.4 * depth);

    // 地平線でソフト合成
    float m = smoothstep(horizon - 0.012, horizon + 0.012, uv.y); // 0=木立, 1=空
    vec3 col = mix(fol, sky, m);

    // 太陽のやわらかいグロー（暖色）
    float d = distance(uv, vec2(0.30, 0.80));
    col += exp(-d * d / 0.05) * 0.20 * vec3(1.0, 0.96, 0.82);

    gl_FragColor = vec4(col, 1.0);
  }
`;

const FRAME_COLOR = "#ece5d7";

export function RoomWindow() {
  const matRef = useRef<THREE.ShaderMaterial>(null);
  const viewMat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: viewVertex,
        fragmentShader: viewFragment,
        uniforms: { uTime: { value: 0 } },
        toneMapped: false, // 光の影響を受けず、昼の窓として明るく出す
      }),
    []
  );

  useFrame((_, delta) => {
    if (matRef.current) matRef.current.uniforms.uTime.value += delta;
  });

  const b = 0.07; // 額縁の幅
  const hw = WIN_W / 2, hh = WIN_H / 2;
  return (
    <group position={WIN_POS}>
      {/* 外景（GLSL）。奥壁のすぐ手前 */}
      <mesh>
        <planeGeometry args={[WIN_W, WIN_H]} />
        <primitive object={viewMat} ref={matRef} attach="material" />
      </mesh>

      {/* 白い額縁（開口の外周、手前に少し出す） */}
      <group position={[0, 0, 0.03]}>
        <mesh position={[0, hh + b / 2, 0]}>
          <boxGeometry args={[WIN_W + b * 2, b, 0.06]} />
          <meshStandardMaterial color={FRAME_COLOR} roughness={0.6} />
        </mesh>
        <mesh position={[0, -hh - b / 2, 0]}>
          <boxGeometry args={[WIN_W + b * 2, b, 0.06]} />
          <meshStandardMaterial color={FRAME_COLOR} roughness={0.6} />
        </mesh>
        <mesh position={[-hw - b / 2, 0, 0]}>
          <boxGeometry args={[b, WIN_H, 0.06]} />
          <meshStandardMaterial color={FRAME_COLOR} roughness={0.6} />
        </mesh>
        <mesh position={[hw + b / 2, 0, 0]}>
          <boxGeometry args={[b, WIN_H, 0.06]} />
          <meshStandardMaterial color={FRAME_COLOR} roughness={0.6} />
        </mesh>
      </group>

      {/* 十字の桟（窓らしさ） */}
      <group position={[0, 0, 0.02]}>
        <mesh>
          <boxGeometry args={[0.03, WIN_H, 0.04]} />
          <meshStandardMaterial color={FRAME_COLOR} roughness={0.6} />
        </mesh>
        <mesh>
          <boxGeometry args={[WIN_W, 0.03, 0.04]} />
          <meshStandardMaterial color={FRAME_COLOR} roughness={0.6} />
        </mesh>
      </group>
    </group>
  );
}
