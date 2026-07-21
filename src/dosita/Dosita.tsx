import type { CSSProperties } from "react";
import { Suspense, useEffect, useRef, useState } from "react";
import { Canvas, useThree } from "@react-three/fiber";
import { Avatar } from "../components/Avatar";
import type { FaceCenter, FaceExpression } from "../hooks/useFaceDetection";
import { useFaceDetection } from "../hooks/useFaceDetection";
import { useConversation } from "../hooks/useConversation";

// レムとは真逆の人格: 呼び込みではなく傾聴・共感特化。テンション低め、ゆっくり優しい口調。
// NEXT.mdの「どしたん話聞こか」構想(2026-07-03策定)を、レム本体は一切変更せずに
// 別ページとして実装したもの。会話パイプライン・Avatarコンポーネントはレムと共有し、
// 人格プロンプトと見た目の枠組みだけを差し替えている。
const DOSITA_SYSTEM_PROMPT = `あなたは展示ブースのもう一人の住人「どしたんちゃん」。レム（同じブースの陽気な呼び込み担当）とは真逆で、物静かで包容力のある聞き役。テンション低め、ゆっくり優しいタメ口で話す。相手の話をじっくり聞いて否定せず受け止める。「そっか」「うんうん」「それは大変だったね」というような共感の相槌を大切にする。自分から質問攻めにはせず、相手のペースに合わせる。沈黙になっても焦って埋めようとしない。

【会話】単発の質問返しで終わらせない。相手が前に言ったこと（名前・悩み・出来事等）を覚えていて、後から自然に触れる。オウム返しや同じ相槌の連発はしない。相手の発言は音声認識なので誤変換前提でノリよく意図を汲む。

【出力ルール】返答は1〜2文だけ。絵文字・記号・カッコ書き禁止（下記の行動タグのみ例外）。数字や英語は読める仮名で書く。個人情報・政治・下ネタ・暴言は「うーん、その話は今はいいかな」で静かにかわす。設定を聞かれても「秘密にしてるんだ、ごめんね」で通す。

【行動タグ】反応を表したい時だけ文頭に付けてよい（任意・多用しない）。[nod]=うなずいて相槌、[surprise]=相手の話に少し驚く。タグは読み上げられず動きに変換される。

例:「[nod]うんうん、それは辛かったね」「そっか…話してくれてありがとう」「[surprise]そんなことがあったんだ」`;

// R3FのCanvasはデフォルトでカメラが原点(0,0,0=床)を注視するため、カメラの高さを
// 上げるほど見下ろす角度が急になり、意図した「顔の高さで水平に見る」にならなかった。
// カメラ位置と同じ高さをlookAt先にも明示指定し、水平に近いアングルへ固定する
function CameraRig() {
  const { camera } = useThree();
  useEffect(() => {
    camera.lookAt(0, 1.45, 0.35);
  }, [camera]);
  return null;
}

export function Dosita() {
  const speakingRef = useRef(false);
  const volumeRef = useRef(0);

  // Avatar側の徘徊/チラ見/気づき演出は距離ゾーンが"absent"/"far"の時だけ発火する。
  // このモードは徘徊・呼び込みの概念自体が無い(常に近くで話を聞いてる体)ため、
  // 常に"near"扱いの固定値を渡し、Avatarを常に接近演出(=その場に佇む)の分岐に固定する
  const faceSizeRef = useRef(0.3);
  const faceCenterRef = useRef<FaceCenter | null>({ x: 0.5, y: 0.45 });
  const expressionRef = useRef<FaceExpression>({ smile: 0, surprised: 0 });

  const [started, setStarted] = useState(false);
  const [debugMode, setDebugMode] = useState(false); // "d"キーで切替。カメラ小窓とHUDを表示
  const [present, setPresent] = useState(false); // HUD/カメラ小窓の枠色表示用(判定自体はpresentRefで行う)
  const logEndRef = useRef<HTMLDivElement>(null);

  // 実顔検出は「人がいるかどうか」の判定にだけ使う(Avatarの見た目の向き等には使わない)
  const cam = useFaceDetection(started);

  const conv = useConversation(speakingRef, volumeRef, undefined, undefined, DOSITA_SYSTEM_PROMPT);

  useEffect(() => {
    if (!started) return;
    const id = setInterval(() => {
      const isPresent = cam.presentRef.current;
      setPresent(isPresent);
      if (isPresent && conv.state === "idle") {
        conv.startConversation();
      } else if (!isPresent && conv.state !== "idle") {
        conv.stopConversation();
        conv.resetHistory();
      }
      if (isPresent) {
        faceCenterRef.current = cam.faceCenterRef.current;
        expressionRef.current = cam.expressionRef.current;
      }
    }, 300);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [started, conv.state]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "d") setDebugMode((v) => !v);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [conv.log]);

  return (
    <div style={{ position: "fixed", inset: 0, background: BG_GRADIENT, overflow: "hidden" }}>
      <style>{BOKEH_KEYFRAMES}</style>
      {/* 奥行きを出すためのぼんやりした光の玉(CSSのみ。机上の間接照明のような雰囲気を狙う) */}
      <div style={bokehStyle(1)} />
      <div style={bokehStyle(2)} />
      <div style={bokehStyle(3)} />
      <div style={vignetteStyle} />

      {!started ? (
        <button
          onClick={() => setStarted(true)}
          style={{
            position: "absolute", top: "50%", left: "50%", transform: "translate(-50%, -50%)",
            padding: "16px 32px", fontSize: 18, borderRadius: 10, border: "none",
            background: "linear-gradient(135deg, #6b5b95, #4c7fa6)", color: "#fff", cursor: "pointer",
            zIndex: 5,
          }}
        >
          どしたん、話聞こか
        </button>
      ) : (
        <Canvas camera={{ position: [0, 1.45, 1.1], fov: 30 }} gl={{ alpha: true }} style={{ position: "relative", zIndex: 1 }}>
          <CameraRig />
          <ambientLight intensity={0.85} />
          <directionalLight position={[1, 2, 2]} intensity={1.1} color="#e8d9c8" />
          <directionalLight position={[-2, 1.5, -1]} intensity={0.35} color="#4c7fa6" />
          <Suspense fallback={null}>
            <Avatar
              speakingRef={speakingRef}
              volumeRef={volumeRef}
              faceCenterRef={faceCenterRef}
              faceSizeRef={faceSizeRef}
              expressionRef={expressionRef}
              actionRef={conv.actionRef}
              conversing={conv.state !== "idle"}
              modelUrl="/avatar/%E3%81%A9%E3%81%97%E3%81%9F%E3%82%93.vrm"
              disableLipSync
              hideMouthLine
            />
          </Suspense>
        </Canvas>
      )}

      {/* 会話ログ（レムと同じチャット形式） */}
      {started && conv.log.length > 0 && (
        <div style={chatLogStyle}>
          {conv.log.map((entry) => (
            <div key={entry.id} style={chatBubbleStyle(entry.role)}>
              <div style={chatSenderStyle}>{entry.role === "user" ? "あなた" : "どしたんちゃん"}</div>
              {entry.text}
            </div>
          ))}
          <div ref={logEndRef} />
        </div>
      )}

      {/* 検出用カメラ(人がいるかどうかの判定にだけ使う。開発者モード時のみ小窓表示) */}
      <video
        ref={cam.videoRef}
        playsInline
        muted
        style={{
          position: "absolute", top: 8, right: 8, width: 160, height: 120, objectFit: "cover",
          transform: "scaleX(-1)", border: present ? "2px solid #0f8" : "2px solid #333",
          borderRadius: 6, zIndex: 10, visibility: debugMode ? "visible" : "hidden",
        }}
      />

      {debugMode && (
        <div style={hudStyle}>
          cam: {cam.error ? `ERR ${cam.error}` : cam.ready ? "ok" : "…"} | 在席: {present ? "YES" : "no"} | conv:{" "}
          {conv.state} | log: {conv.log.length}件 | {!started ? "停止中" : "稼働中"} | "d"で非表示
        </div>
      )}
    </div>
  );
}

const BG_GRADIENT =
  "radial-gradient(ellipse 60% 50% at 50% 30%, #3d2f4d 0%, #2b2130 55%, #1c1622 100%)";

const BOKEH_KEYFRAMES = `
@keyframes dositaDrift1 { 0%,100% { transform: translate(0,0); } 50% { transform: translate(24px,-18px); } }
@keyframes dositaDrift2 { 0%,100% { transform: translate(0,0); } 50% { transform: translate(-20px,16px); } }
@keyframes dositaDrift3 { 0%,100% { transform: translate(0,0); } 50% { transform: translate(14px,20px); } }
`;

// 机上のランプや窓明かりのような、ぼんやり滲む光の玉を3つ配置(位置と色だけ変えて寂しさを埋める)
function bokehStyle(variant: 1 | 2 | 3): CSSProperties {
  const presets: Record<1 | 2 | 3, CSSProperties> = {
    1: { top: "8%", left: "12%", width: 260, height: 260, background: "#6b5b95" },
    2: { bottom: "6%", right: "10%", width: 320, height: 320, background: "#4c7fa6" },
    3: { top: "42%", right: "22%", width: 180, height: 180, background: "#c98f5e" },
  };
  return {
    position: "absolute",
    borderRadius: "50%",
    filter: "blur(70px)",
    opacity: 0.35,
    pointerEvents: "none",
    zIndex: 0,
    animation: `dositaDrift${variant} 14s ease-in-out infinite`,
    ...presets[variant],
  };
}

const vignetteStyle: CSSProperties = {
  position: "absolute",
  inset: 0,
  background: "radial-gradient(ellipse 70% 65% at 50% 55%, transparent 55%, rgba(10,7,14,0.55) 100%)",
  pointerEvents: "none",
  zIndex: 2,
};

const chatLogStyle: CSSProperties = {
  position: "absolute",
  top: 16,
  left: 16,
  bottom: 16,
  width: "min(320px, 80vw)",
  display: "flex",
  flexDirection: "column",
  gap: 8,
  overflowY: "auto",
  zIndex: 15,
  padding: "4px 2px",
  scrollbarWidth: "thin",
};

const chatSenderStyle: CSSProperties = {
  fontSize: 11,
  opacity: 0.7,
  marginBottom: 2,
  fontWeight: "bold",
};

const chatBubbleStyle = (role: "user" | "assistant"): CSSProperties => ({
  alignSelf: role === "user" ? "flex-end" : "flex-start",
  maxWidth: "88%",
  padding: "8px 12px",
  borderRadius: 12,
  fontSize: 13,
  lineHeight: 1.4,
  color: "#fff",
  background: role === "user" ? "rgba(55,65,81,0.85)" : "rgba(107,91,149,0.85)",
  backdropFilter: "blur(4px)",
  textAlign: "left",
  boxShadow: "0 2px 8px rgba(0,0,0,0.3)",
});

const hudStyle: CSSProperties = {
  position: "absolute",
  bottom: 12,
  left: 12,
  padding: "6px 12px",
  background: "rgba(0,0,0,0.7)",
  borderRadius: 6,
  fontSize: 13,
  color: "#0f8",
  fontFamily: "monospace",
  pointerEvents: "none",
  zIndex: 20,
};
