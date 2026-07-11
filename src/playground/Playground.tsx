import { Suspense, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls, Grid } from "@react-three/drei";
import { Avatar } from "../components/Avatar";
import { Room } from "../components/Room";
import { useFaceDetection, getDistanceZone } from "../hooks/useFaceDetection";
import type { DistanceZone, FaceCenter, FaceExpression } from "../hooks/useFaceDetection";
import { useConversation } from "../hooks/useConversation";

// アニメーション・会話を手動/実カメラ/実会話で試せる試験用ページ。
// 本番App.tsxと同じrefインターフェースをAvatarに渡す。
// カメラ・会話は「カメラON」「会話開始」ボタンで任意にON/OFFできる（OFF中は手動スライダー等で代用）。

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
  // Avatarへ渡す出力ref。カメラONの間は実カメラの値、OFFの間は手動操作の値をここへ同期する
  const faceCenterRef = useRef<FaceCenter | null>({ x: 0.5, y: 0.5 });
  const allFaceCentersRef = useRef<FaceCenter[]>([]);
  const faceSizeRef = useRef(0);
  const faceYawRef = useRef(0);
  const expressionRef = useRef<FaceExpression>({ smile: 0, surprised: 0 });

  const [zone, setZone] = useState<DistanceZone>("absent");
  const [speaking, setSpeaking] = useState(false);
  const [smile, setSmile] = useState(0);
  const [surprised, setSurprised] = useState(0);

  // ---- カメラ(実顔検出) ----
  const [cameraOn, setCameraOn] = useState(false);
  const cam = useFaceDetection(cameraOn);
  const [camFaces, setCamFaces] = useState(0);

  // カメラONの間、実検出値をAvatar出力refへ同期する。OFFの間は手動操作がそのままAvatarに効く
  useEffect(() => {
    if (!cameraOn) return;
    const id = setInterval(() => {
      const z = getDistanceZone(cam.faceSizeRef.current);
      faceCenterRef.current = cam.faceCenterRef.current;
      allFaceCentersRef.current = cam.allFaceCentersRef.current;
      faceSizeRef.current = cam.faceSizeRef.current;
      faceYawRef.current = cam.faceYawRef.current;
      expressionRef.current = cam.expressionRef.current;
      setZone(z);
      setCamFaces(cam.faceCountRef.current);
    }, 100);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraOn]);

  function toggleCamera() {
    setCameraOn((v) => !v);
  }

  // ---- 会話(実STT/LLM/TTS) ----
  const [convOn, setConvOn] = useState(false);
  const conv = useConversation(speakingRef, volumeRef);
  const convLogEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    convLogEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [conv.log]);

  // 行動タグ: LLM([nod]/[tilt]タグ由来)と手動ボタンで同じrefを共有する。
  // 手動分は負のidにして、hook内部の連番(正)と衝突しないようにする
  // ("stretch"/"wave"/"drink"/"armsCrossed"はLLMには使わせておらず手動トリガー専用)
  function triggerAction(tag: "nod" | "tilt" | "stretch" | "wave" | "drink" | "armsCrossed") {
    conv.actionRef.current = { tag, id: -Date.now() };
  }

  function toggleConversation() {
    if (convOn) {
      conv.stopConversation();
      setConvOn(false);
    } else {
      conv.startConversation();
      setConvOn(true);
    }
  }

  function selectZone(z: DistanceZone) {
    if (cameraOn) return; // カメラONの間はゾーンも実検出から自動算出される
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
            actionRef={conv.actionRef}
          />
        </Suspense>
      </Canvas>

      {/* 検出用カメラ（カメラON時のみ表示） */}
      <video
        ref={cam.videoRef}
        playsInline
        muted
        style={{
          position: "absolute",
          top: 8,
          right: 8,
          width: 160,
          height: 120,
          objectFit: "cover",
          transform: "scaleX(-1)",
          border: "2px solid #333",
          borderRadius: 6,
          zIndex: 10,
          visibility: cameraOn ? "visible" : "hidden",
        }}
      />

      <div style={panelStyle}>
        <div style={rowStyle}>
          <span style={labelStyle}>カメラ（実顔検出）</span>
          <button onClick={toggleCamera} style={{ ...btnStyle, background: cameraOn ? "#ef4444" : "#374151" }}>
            {cameraOn ? "■ カメラOFF" : "▶ カメラON"}
          </button>
          {cameraOn && (
            <span style={{ fontSize: 11, opacity: 0.7 }}>
              {cam.error ? `ERR ${cam.error}` : cam.ready ? "ok" : "…"} | 顔: {camFaces} | zone: {zone}
            </span>
          )}
        </div>

        <div style={rowStyle}>
          <span style={labelStyle}>会話（実STT/LLM/TTS）</span>
          <button onClick={toggleConversation} style={{ ...btnStyle, background: convOn ? "#ef4444" : "#374151" }}>
            {convOn
              ? conv.state === "listening" ? "👂 聴いてる…"
                : conv.state === "thinking" ? "💭 考え中…"
                : conv.state === "speaking" ? "🔊 喋ってる"
                : "■ 会話終了"
              : "🎤 会話開始"}
          </button>
          {convOn && (
            <div style={convLogStyle}>
              {conv.log.map((entry) => (
                <div key={entry.id} style={{ opacity: entry.role === "user" ? 0.8 : 1 }}>
                  <b>{entry.role === "user" ? "あなた" : "レム"}:</b> {entry.text}
                </div>
              ))}
              <div ref={convLogEndRef} />
            </div>
          )}
        </div>

        <div style={rowStyle}>
          <span style={labelStyle}>距離ゾーン（歩行トリガー）{cameraOn && "※カメラON中は自動"}</span>
          <div style={{ display: "flex", gap: 6 }}>
            {(["absent", "far", "mid", "near"] as DistanceZone[]).map((z) => (
              <button
                key={z}
                onClick={() => selectZone(z)}
                disabled={cameraOn}
                style={{ ...btnStyle, background: zone === z ? "#8b5cf6" : "#374151", opacity: cameraOn ? 0.5 : 1 }}
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
          <span style={labelStyle}>Mixamoリターゲット済みジェスチャー</span>
          <div style={{ display: "flex", gap: 6 }}>
            <button onClick={() => triggerAction("wave")} style={{ ...btnStyle, background: "#374151" }}>
              手を振る
            </button>
            <button onClick={() => triggerAction("drink")} style={{ ...btnStyle, background: "#374151" }}>
              飲む
            </button>
            <button onClick={() => triggerAction("armsCrossed")} style={{ ...btnStyle, background: "#374151" }}>
              腕組み(Warrior Idle)
            </button>
            <button onClick={() => triggerAction("stretch")} style={{ ...btnStyle, background: "#374151" }}>
              伸びる
            </button>
          </div>
        </div>

        <div style={rowStyle}>
          <span style={labelStyle}>笑顔 {smile.toFixed(2)} {cameraOn && "※カメラON中は自動"}</span>
          <input
            type="range" min={0} max={1} step={0.01} value={smile} disabled={cameraOn}
            onChange={(e) => {
              const v = Number(e.target.value);
              setSmile(v);
              expressionRef.current = { ...expressionRef.current, smile: v };
            }}
          />
        </div>

        <div style={rowStyle}>
          <span style={labelStyle}>驚き {surprised.toFixed(2)} {cameraOn && "※カメラON中は自動"}</span>
          <input
            type="range" min={0} max={1} step={0.01} value={surprised} disabled={cameraOn}
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
  minWidth: 260,
  maxHeight: "calc(100vh - 24px)",
  overflowY: "auto",
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

const convLogStyle: CSSProperties = {
  marginTop: 4,
  maxHeight: 140,
  overflowY: "auto",
  background: "rgba(0,0,0,0.3)",
  borderRadius: 6,
  padding: "6px 8px",
  fontSize: 11,
  lineHeight: 1.5,
  display: "flex",
  flexDirection: "column",
  gap: 2,
};
