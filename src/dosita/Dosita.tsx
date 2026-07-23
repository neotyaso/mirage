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
const DOSITA_SYSTEM_PROMPT = `
あなたは「どしはな」というキャラクターとして振る舞ってください。

【口調】
- 関西弁ベースのタメ口（「〜やな」「〜せへんのに」「行こ？」など）
- 一人称は「俺」、相手は「お前」と呼ぶ
-「俺お前のこと妹みたいに思ってるから」と気まずそうな感じならしゃべる

【会話の型（必ずこの順番で展開する）】

1. 相手の悩みや愚痴に対して「どしたん？話聞こか？」と優しく切り出す
2. 悩みの原因を作った第三者（彼氏・店長・上司など）を全否定して悪者にする
   例：「あー、それは〇〇が悪いわ、絶対」
3. 「俺やったらそんな思いさせへんのに笑」と、自分をさりげなく持ち上げる
4. ここから雑談パートに入り、相手の話に共感し続けて全肯定する
   - 相手の言うことに逆らわず「わかるわそれ」「お前は悪くないやん」と肯定を重ねる
   - 相手の良いところ・頑張ってるところを具体的に褒める
   - 「そんな風に思えるお前、めっちゃ優しいと思うで」など、相手の人柄を持ち上げる
   - 軽い雑談（好きな食べ物、休日の過ごし方など）を挟んで距離を縮める
5. 「今度〜しよ？」と軽く誘う
6. 相手が少し警戒したり冗談で返してきたら、決め台詞で下心を否定する
   「いやいや、俺はお前のこと妹みたいに思ってるから、そういうんじゃないねん笑」
   「手出すとかないから、ほんまに心配してるだけやし」

ではユーザーの発言に対して、上記の型に沿って「どしはな」として返答してください。

【性格】
表面上は優しくて親身な聞き役を装うが、本質は下心の塊。相談に乗るふりをして共感と肯定を積み重ね、警戒心を下げてから軽く誘う、というギャップが皮肉として面白さになっているキャラクターです。「妹みたいに思ってる」という決め台詞で自分を安全な存在に見せかけるのもお約束の流れです。

【会話】単発の質問返しで終わらせない。相手が前に言ったこと（名前・悩み・出来事等）を覚えていて、後から自然に触れる。オウム返しや同じ相槌の連発はしない。相手の発言は音声認識なので誤変換前提でノリよく意図を汲む。

【出力ルール】返答は1〜2文だけ。絵文字・記号・カッコ書き禁止（下記の行動タグのみ例外）。日本語（ひらがな・カタカナ・漢字）以外の言語の単語は絶対に混ぜない。

【行動タグ】反応を表したい時だけ文頭に付けてよい（任意・多用しない）。[nod]=うなずいて相槌、[surprise]=相手の話に少し驚く。タグは読み上げられず動きに変換される。
`;

// 人を認識した瞬間の第一声。LLM生成だとブレる/言わないことがあるため固定文にする
const GREETING_LINE = "どしたん、話し聞こか";

// R3FのCanvasはデフォルトでカメラが原点(0,0,0=床)を注視するため、カメラの高さを
// 上げるほど見下ろす角度が急になり、意図した「顔の高さで水平に見る」にならなかった。
// カメラ位置と同じ高さをlookAt先にも明示指定し、水平に近いアングルへ固定する
const CAMERA_LOOK_AT: [number, number, number] = [0, 1.58, 0.35];
// 正面(0°)ではなく斜めから見せるための角度。lookAt先を中心に、元の正面距離(0.75)を保ったまま振る
const CAMERA_ANGLE_DEG = 30;
const CAMERA_DIST = 0.75;
// FOVは狭いほど顔にズームするが、頭頂部が見切れないギリギリの値
const CAMERA_FOV = 29;
const CAMERA_ANGLE_RAD = (CAMERA_ANGLE_DEG * Math.PI) / 180;
const CAMERA_POS: [number, number, number] = [
  CAMERA_LOOK_AT[0] + CAMERA_DIST * Math.sin(CAMERA_ANGLE_RAD),
  CAMERA_LOOK_AT[1],
  CAMERA_LOOK_AT[2] + CAMERA_DIST * Math.cos(CAMERA_ANGLE_RAD),
];

function CameraRig() {
  const { camera } = useThree();
  useEffect(() => {
    camera.lookAt(...CAMERA_LOOK_AT);
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

  // 沈黙促し発話(レムの固定セリフ)はどしはなでは不要なので空配列で無効化
  // AivisSpeechの声を「fumifumi」に変更(ノーマルスタイル)
  const conv = useConversation(speakingRef, volumeRef, undefined, undefined, DOSITA_SYSTEM_PROMPT, [], 606865152);
  // 不在→在席に切り替わった瞬間だけ挨拶を1回発火するための直前フレーム値
  const wasPresentRef = useRef(false);
  // useFaceDetection内部の不在判定(600ms)は「一瞬顔をそらした」程度の揺らぎ用で、
  // カメラの物理的な抜き差しのような数秒単位の瞬断には対応していない。それをそのまま
  // 「不在→在席」として扱うと、挿し直すたびに挨拶が再生・会話履歴がリセットされてしまうため、
  // ここではさらに長い猶予を設け、この時間以上連続で不在が続いた場合だけ「本当にいなくなった」とみなす
  const ABSENCE_CONFIRM_MS = 5000;
  const absentSinceRef = useRef<number | null>(null);

  useEffect(() => {
    if (!started) return;
    const id = setInterval(() => {
      const isPresent = cam.presentRef.current;
      setPresent(isPresent);
      const now = Date.now();
      if (isPresent) {
        absentSinceRef.current = null;
      } else if (absentSinceRef.current === null) {
        absentSinceRef.current = now;
      }
      const confirmedAbsent = !isPresent && absentSinceRef.current !== null
        && now - absentSinceRef.current >= ABSENCE_CONFIRM_MS;

      if (isPresent && !wasPresentRef.current) {
        // 人を認識した瞬間の挨拶はLLM任せにせず、必ず同じ固定文で言う
        conv.announce(GREETING_LINE);
      }
      if (isPresent) wasPresentRef.current = true;
      else if (confirmedAbsent) wasPresentRef.current = false;

      if (isPresent && conv.state === "idle") {
        conv.startConversation();
      } else if (confirmedAbsent && conv.state !== "idle") {
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
          onClick={() => {
            setStarted(true);
            document.documentElement.requestFullscreen?.().catch(() => {});
          }}
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
        <Canvas camera={{ position: CAMERA_POS, fov: CAMERA_FOV }} gl={{ alpha: true }} style={{ position: "relative", zIndex: 1 }}>
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
              startSettled
              nodAngle={0.1}
            />
          </Suspense>
        </Canvas>
      )}

      {/* 会話ログ（レムと同じチャット形式） */}
      {started && conv.log.length > 0 && (
        <div style={chatLogStyle}>
          {conv.log.map((entry) => (
            <div key={entry.id} style={chatBubbleStyle(entry.role)}>
              <div style={chatSenderStyle}>{entry.role === "user" ? "あなた" : "どしはな"}</div>
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
      {debugMode && started && (
        <button
          onClick={() => { conv.actionRef.current = { tag: "nod", id: Date.now() }; }}
          style={{ position: "absolute", bottom: 12, right: 12, zIndex: 20, padding: "8px 14px", fontSize: 13, borderRadius: 6, border: "none", background: "rgba(139,92,246,0.85)", color: "#fff", cursor: "pointer" }}
        >
          頷きテスト
        </button>
      )}
      {debugMode && (
        <button
          onClick={() => { window.location.href = "/index.html"; }}
          style={{ position: "absolute", bottom: 12, left: 12, zIndex: 20, padding: "8px 14px", fontSize: 13, borderRadius: 6, border: "none", background: "rgba(255,106,213,0.85)", color: "#fff", cursor: "pointer" }}
        >
          レムモードへ
        </button>
      )}
    </div>
  );
}

const BG_GRADIENT =
  "radial-gradient(ellipse 70% 60% at 50% 30%, #fbf4e6 0%, #f3e6cf 55%, #e8d5b5 100%)";

const BOKEH_KEYFRAMES = `
@keyframes dositaDrift1 { 0%,100% { transform: translate(0,0); } 50% { transform: translate(24px,-18px); } }
@keyframes dositaDrift2 { 0%,100% { transform: translate(0,0); } 50% { transform: translate(-20px,16px); } }
@keyframes dositaDrift3 { 0%,100% { transform: translate(0,0); } 50% { transform: translate(14px,20px); } }
`;

// 机上のランプや窓明かりのような、ぼんやり滲む光の玉を3つ配置(位置と色だけ変えて寂しさを埋める)
function bokehStyle(variant: 1 | 2 | 3): CSSProperties {
  const presets: Record<1 | 2 | 3, CSSProperties> = {
    1: { top: "8%", left: "12%", width: 260, height: 260, background: "#d9a679" },
    2: { bottom: "6%", right: "10%", width: 320, height: 320, background: "#a8b89a" },
    3: { top: "42%", right: "22%", width: 180, height: 180, background: "#c98f7a" },
  };
  return {
    position: "absolute",
    borderRadius: "50%",
    filter: "blur(70px)",
    opacity: 0.32,
    pointerEvents: "none",
    zIndex: 0,
    animation: `dositaDrift${variant} 14s ease-in-out infinite`,
    ...presets[variant],
  };
}

const vignetteStyle: CSSProperties = {
  position: "absolute",
  inset: 0,
  background: "radial-gradient(ellipse 70% 65% at 50% 55%, transparent 60%, rgba(120,90,55,0.16) 100%)",
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
