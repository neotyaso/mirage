import { Suspense, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls, Grid } from "@react-three/drei";
import { Avatar } from "../components/Avatar";
import { Room } from "../components/Room";
import type { DistanceZone, FaceCenter, FaceExpression } from "../hooks/useFaceDetection";

// 実カメラ・実LLMなしでアニメーションだけ手動トリガーして見るための試験用ページ。
// 本番App.tsxと同じrefインターフェースをAvatarに渡し、値はUIのボタン/スライダーから流し込む。

// useFaceDetection.getDistanceZoneのしきい値に対応する代表値
const ZONE_SIZE: Record<DistanceZone, number> = {
  absent: 0,
  far: 0.08,
  mid: 0.18,
  near: 0.32,
};

function VolumeDriver({ speaking, volumeRef }: { speaking: boolean; volumeRef: React.MutableRefObject<number> }) {
  useFrame((state) => {
    volumeRef.current = speaking ? 0.35 + 0.35 * Math.abs(Math.sin(state.clock.elapsedTime * 10)) : 0;
  });
  return null;
}

export function Playground() {
  const speakingRef = useRef(false);
  const volumeRef = useRef(0);
  const faceCenterRef = useRef<FaceCenter | null>({ x: 0.5, y: 0.5 });
  const allFaceCentersRef = useRef<FaceCenter[]>([]);
  const faceSizeRef = useRef(0);
  const expressionRef = useRef<FaceExpression>({ smile: 0, surprised: 0 });
  const actionRef = useRef<{ tag: "nod" | "tilt"; id: number } | null>(null);
  const actionIdRef = useRef(0);
  const sittingRef = useRef(false);

  function triggerAction(tag: "nod" | "tilt") {
    actionRef.current = { tag, id: ++actionIdRef.current };
  }

  const [zone, setZone] = useState<DistanceZone>("absent");
  const [speaking, setSpeaking] = useState(false);
  const [smile, setSmile] = useState(0);
  const [surprised, setSurprised] = useState(0);
  const [sitting, setSitting] = useState(false);

  function toggleSitting() {
    const next = !sitting;
    setSitting(next);
    sittingRef.current = next;
  }

  function selectZone(z: DistanceZone) {
    setZone(z);
    faceSizeRef.current = ZONE_SIZE[z];
    faceCenterRef.current = z === "absent" ? null : { x: 0.5, y: 0.5 };
  }

  function toggleSpeaking() {
    const next = !speaking;
    setSpeaking(next);
    speakingRef.current = next;
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "#15151f" }}>
      <Canvas camera={{ position: [0, 1.1, 3], fov: 35 }}>
        <color attach="background" args={["#15151f"]} />
        <ambientLight intensity={0.7} />
        <directionalLight position={[2, 4, 3]} intensity={1.3} />
        <directionalLight position={[-3, 2, -2]} intensity={0.5} color="#88aaff" />

        <Grid args={[10, 10]} position={[0, 0, 0]} cellColor="#334" sectionColor="#556" />
        <OrbitControls target={[0, 1, 0]} />
        <VolumeDriver speaking={speaking} volumeRef={volumeRef} />

        <Room />

        <Suspense fallback={null}>
          <Avatar
            speakingRef={speakingRef}
            volumeRef={volumeRef}
            faceCenterRef={faceCenterRef}
            allFaceCentersRef={allFaceCentersRef}
            expressionRef={expressionRef}
            faceSizeRef={faceSizeRef}
            actionRef={actionRef}
            sittingRef={sittingRef}
          />
        </Suspense>
      </Canvas>

      <div style={panelStyle}>
        <div style={rowStyle}>
          <span style={labelStyle}>距離ゾーン（歩行トリガー）</span>
          <div style={{ display: "flex", gap: 6 }}>
            {(["absent", "far", "mid", "near"] as DistanceZone[]).map((z) => (
              <button
                key={z}
                onClick={() => selectZone(z)}
                style={{ ...btnStyle, background: zone === z ? "#8b5cf6" : "#374151" }}
              >
                {{ absent: "不在", far: "遠い", mid: "中距離", near: "近い" }[z]}
              </button>
            ))}
          </div>
        </div>

        <div style={rowStyle}>
          <span style={labelStyle}>発話中（ジェスチャー・リップシンク）</span>
          <button onClick={toggleSpeaking} style={{ ...btnStyle, background: speaking ? "#ef4444" : "#374151" }}>
            {speaking ? "■ 停止" : "▶ 話す"}
          </button>
        </div>

        <div style={rowStyle}>
          <span style={labelStyle}>座りモーション（Mixamoリターゲット・プレビュー）</span>
          <button onClick={toggleSitting} style={{ ...btnStyle, background: sitting ? "#8b5cf6" : "#374151" }}>
            {sitting ? "■ 起立" : "▶ 座る"}
          </button>
        </div>

        <div style={rowStyle}>
          <span style={labelStyle}>行動タグ（手続き型アクション）</span>
          <div style={{ display: "flex", gap: 6 }}>
            <button onClick={() => triggerAction("nod")} style={{ ...btnStyle, background: "#374151" }}>
              頷く
            </button>
            <button onClick={() => triggerAction("tilt")} style={{ ...btnStyle, background: "#374151" }}>
              首をかしげる
            </button>
          </div>
        </div>

        <div style={rowStyle}>
          <span style={labelStyle}>笑顔 {smile.toFixed(2)}</span>
          <input
            type="range" min={0} max={1} step={0.01} value={smile}
            onChange={(e) => {
              const v = Number(e.target.value);
              setSmile(v);
              expressionRef.current = { ...expressionRef.current, smile: v };
            }}
          />
        </div>

        <div style={rowStyle}>
          <span style={labelStyle}>驚き {surprised.toFixed(2)}</span>
          <input
            type="range" min={0} max={1} step={0.01} value={surprised}
            onChange={(e) => {
              const v = Number(e.target.value);
              setSurprised(v);
              expressionRef.current = { ...expressionRef.current, surprised: v };
            }}
          />
        </div>
      </div>
    </div>
  );
}

const panelStyle: CSSProperties = {
  position: "absolute",
  top: 12,
  left: 12,
  display: "flex",
  flexDirection: "column",
  gap: 10,
  padding: "12px 14px",
  background: "rgba(0,0,0,0.65)",
  borderRadius: 10,
  color: "#fff",
  fontFamily: "sans-serif",
  fontSize: 13,
  minWidth: 240,
};

const rowStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
};

const labelStyle: CSSProperties = {
  opacity: 0.8,
  fontSize: 12,
};

const btnStyle: CSSProperties = {
  padding: "6px 10px",
  fontSize: 12,
  color: "#fff",
  border: "none",
  borderRadius: 6,
  cursor: "pointer",
};
