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
  // 時間帯で変わる空・太陽の色（JS側で実時刻から計算して渡す）
  uniform vec3 uSkyHorizon;
  uniform vec3 uSkyTop;
  uniform vec3 uSunColor;
  uniform vec2 uSunPos;
  uniform float uSunStrength;

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

    // 空（地平線より上）: 上=淡い青 → 地平線=暖色クリーム（時間帯で色が変わる）
    float ts = clamp((uv.y - horizon) / (1.0 - horizon), 0.0, 1.0);
    vec3 sky = mix(uSkyHorizon, uSkyTop, ts);
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

    // 太陽のやわらかいグロー（時間帯で位置・色・強さが変わる）
    float d = distance(uv, uSunPos);
    col += exp(-d * d / 0.05) * uSunStrength * uSunColor;

    gl_FragColor = vec4(col, 1.0);
  }
`;

const FRAME_COLOR = "#ece5d7";

// 時間帯ごとの空・太陽のパレット（実時刻に合わせて窓の外を朝→昼→夕→宵で変える＝「窓の外＝本物」の一貫性）。
// 常に見栄えする範囲に留め、真っ暗な夜にはしない（明るいナチュラルな室内と喧嘩するため）。
type SkyKey = {
  h: number;
  horizon: [number, number, number];
  top: [number, number, number];
  sun: [number, number];
  sunCol: [number, number, number];
  sunStr: number;
};
const SKY_KEYS: SkyKey[] = [
  { h: 7,  horizon: [0.96, 0.90, 0.82], top: [0.62, 0.74, 0.86], sun: [0.26, 0.72], sunCol: [1.0, 0.93, 0.80], sunStr: 0.16 }, // 朝: やわらかい
  { h: 12, horizon: [0.98, 0.95, 0.87], top: [0.55, 0.72, 0.88], sun: [0.30, 0.80], sunCol: [1.0, 0.96, 0.82], sunStr: 0.20 }, // 昼: 明るい（従来）
  { h: 17, horizon: [1.00, 0.86, 0.66], top: [0.50, 0.62, 0.82], sun: [0.68, 0.58], sunCol: [1.0, 0.82, 0.60], sunStr: 0.28 }, // 夕: 金色
  { h: 20, horizon: [0.86, 0.72, 0.62], top: [0.34, 0.42, 0.60], sun: [0.72, 0.42], sunCol: [1.0, 0.74, 0.55], sunStr: 0.15 }, // 宵: 落ち着いた暖色
];

function lerpArr<T extends number[]>(a: T, b: T, t: number): T {
  return a.map((v, i) => v + (b[i] - v) * t) as T;
}

// 連続した時刻(hour + minute/60)から空パレットを補間して返す。範囲外は端に張り付ける
function skyPaletteAt(hour: number): SkyKey {
  if (hour <= SKY_KEYS[0].h) return SKY_KEYS[0];
  if (hour >= SKY_KEYS[SKY_KEYS.length - 1].h) return SKY_KEYS[SKY_KEYS.length - 1];
  let i = 0;
  while (i < SKY_KEYS.length - 1 && hour > SKY_KEYS[i + 1].h) i++;
  const a = SKY_KEYS[i], b = SKY_KEYS[i + 1];
  const t = (hour - a.h) / (b.h - a.h);
  return {
    h: hour,
    horizon: lerpArr(a.horizon, b.horizon, t),
    top: lerpArr(a.top, b.top, t),
    sun: lerpArr(a.sun, b.sun, t),
    sunCol: lerpArr(a.sunCol, b.sunCol, t),
    sunStr: a.sunStr + (b.sunStr - a.sunStr) * t,
  };
}

function currentHour(): number {
  const d = new Date();
  return d.getHours() + d.getMinutes() / 60;
}

export function RoomWindow() {
  const matRef = useRef<THREE.ShaderMaterial>(null);
  const lastPaletteAt = useRef(0);
  const viewMat = useMemo(() => {
    const p = skyPaletteAt(currentHour());
    return new THREE.ShaderMaterial({
      vertexShader: viewVertex,
      fragmentShader: viewFragment,
      uniforms: {
        uTime: { value: 0 },
        uSkyHorizon: { value: new THREE.Vector3(...p.horizon) },
        uSkyTop: { value: new THREE.Vector3(...p.top) },
        uSunColor: { value: new THREE.Vector3(...p.sunCol) },
        uSunPos: { value: new THREE.Vector2(...p.sun) },
        uSunStrength: { value: p.sunStr },
      },
      toneMapped: false, // 光の影響を受けず、昼の窓として明るく出す
    });
  }, []);

  useFrame((state, delta) => {
    const m = matRef.current;
    if (!m) return;
    m.uniforms.uTime.value += delta;
    // 時間帯パレットは数秒おきに実時刻から更新（展示は長時間動くので朝→夕の推移を反映）
    const t = state.clock.elapsedTime;
    if (t - lastPaletteAt.current > 5) {
      lastPaletteAt.current = t;
      const p = skyPaletteAt(currentHour());
      (m.uniforms.uSkyHorizon.value as THREE.Vector3).set(...p.horizon);
      (m.uniforms.uSkyTop.value as THREE.Vector3).set(...p.top);
      (m.uniforms.uSunColor.value as THREE.Vector3).set(...p.sunCol);
      (m.uniforms.uSunPos.value as THREE.Vector2).set(...p.sun);
      m.uniforms.uSunStrength.value = p.sunStr;
    }
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
