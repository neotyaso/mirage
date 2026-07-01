import { Suspense, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Avatar } from "./components/Avatar";
import { useFaceDetection, getDistanceZone } from "./hooks/useFaceDetection";
import type { FaceCenter, DistanceZone } from "./hooks/useFaceDetection";
import type { MutableRefObject } from "react";

// Off-axis カメラ: 来場者の顔位置でカメラが動き「3Dの窓」効果を生む
const CAM_BASE: [number, number, number] = [0, 0.9, 3];
const CAM_RANGE_X = 0.8; // 顔が端にいると左右±0.8m動く
const CAM_RANGE_Y = 0.35;
const CAM_LERP = 0.06; // 追従の滑らかさ（小さいほど遅れる）

function OffAxisCamera({ faceCenterRef }: { faceCenterRef: MutableRefObject<FaceCenter | null> }) {
  const { camera } = useThree();

  useFrame(() => {
    const fc = faceCenterRef.current;
    // 顔なし → 中央に戻る
    const tx = fc ? (0.5 - fc.x) * 2 * CAM_RANGE_X : 0; // 左右反転（カメラ映像は鏡像）
    const ty = fc ? (0.5 - fc.y) * 2 * CAM_RANGE_Y : 0;

    camera.position.x += (CAM_BASE[0] + tx - camera.position.x) * CAM_LERP;
    camera.position.y += (CAM_BASE[1] + ty - camera.position.y) * CAM_LERP;
    camera.position.z = CAM_BASE[2];

    // カメラは常にシーン中央（キャラの腰付近）を向く
    camera.lookAt(0, 0.9, 0);
  });

  return null;
}

// 距離ゾーン別セリフ（後でLLM生成に差し替え）
const LINES: Record<Exclude<DistanceZone, "absent">, string[]> = {
  far: [
    "ねえねえ！そこのあなた、こっち来てよ〜！",
    "おーい！ちょっと話していかない？",
  ],
  mid: [
    "あっ、いま目が合ったよね？ちょっとだけいいよね？",
    "ねえ、ちょっとだけ。すぐ終わるから！",
  ],
  near: [
    "来てくれたんだ！嬉しいな、話しかけてほしかったんだよね。",
    "わあ、近い！何か聞きたいことある？",
  ],
};

// 複数人向けセリフ（2人以上検出時に優先）
const GROUP_LINES: Record<Exclude<DistanceZone, "absent">, string[]> = {
  far: [
    "おーい！お二人さん、こっち来てよ〜！",
    "ねえねえ！そこの皆さん、ちょっとだけいいですか？",
  ],
  mid: [
    "お二人ですか？ちょうどよかった、話しかけたかったんです！",
    "二人で来てくれたんだね、嬉しいな！",
  ],
  near: [
    "わあ、二人とも来てくれたんですね！どっちに話せばいいか迷っちゃう。",
    "お二人さんいらっしゃい！何か聞きたいことある？",
  ],
};

// 遠いほど頻繁に呼び込む
const COOLDOWN: Record<Exclude<DistanceZone, "absent">, number> = {
  far: 4000,
  mid: 6000,
  near: 9000,
};

// AivisSpeech (VOICEVOX互換 API)
// スピーカーIDは GET http://localhost:10101/speakers で確認して変更
const AIVIS_URL = "http://localhost:10101";
const SPEAKER_ID = 888753760;

export default function App() {
  const speakingRef = useRef(false);
  const volumeRef = useRef(0);
  const { videoRef, presentRef, faceCountRef, faceCenterRef, faceSizeRef, allFaceCentersRef, expressionRef, ready: camReady, error: camError } =
    useFaceDetection();

  const [started, setStarted] = useState(false);
  const [present, setPresent] = useState(false);
  const [faces, setFaces] = useState(0);
  const [zone, setZone] = useState<DistanceZone>("absent");

  // Web Speech API フォールバック用
  useEffect(() => {
    const sync = () => speechSynthesis.getVoices();
    sync();
    speechSynthesis.onvoiceschanged = sync;
    return () => { speechSynthesis.onvoiceschanged = null; };
  }, []);

  function speakFallback(text: string) {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "ja-JP"; u.rate = 1.05; u.pitch = 1.2;
    const jp = speechSynthesis.getVoices().find((v) => v.lang.startsWith("ja"));
    if (jp) u.voice = jp;
    u.onstart = () => { speakingRef.current = true; volumeRef.current = 0.6; };
    u.onend = () => { speakingRef.current = false; volumeRef.current = 0; };
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  }

  async function speak(text: string) {
    speakingRef.current = false;
    volumeRef.current = 0;
    try {
      const qRes = await fetch(
        `${AIVIS_URL}/audio_query?text=${encodeURIComponent(text)}&speaker=${SPEAKER_ID}`,
        { method: "POST" }
      );
      if (!qRes.ok) throw new Error(`audio_query ${qRes.status}`);
      const query = await qRes.json();

      const sRes = await fetch(`${AIVIS_URL}/synthesis?speaker=${SPEAKER_ID}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(query),
      });
      if (!sRes.ok) throw new Error(`synthesis ${sRes.status}`);

      const arrayBuffer = await sRes.arrayBuffer();
      const ctx = new AudioContext();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      const data = new Uint8Array(analyser.frequencyBinCount);

      const source = ctx.createBufferSource();
      source.buffer = await ctx.decodeAudioData(arrayBuffer);
      source.connect(analyser);
      analyser.connect(ctx.destination);

      speakingRef.current = true;

      function tick() {
        if (!speakingRef.current) return;
        analyser.getByteFrequencyData(data);
        const avg = data.reduce((a, b) => a + b, 0) / data.length;
        volumeRef.current = Math.min(avg / 60, 1); // 0〜1 に正規化
        requestAnimationFrame(tick);
      }

      source.onended = () => {
        speakingRef.current = false;
        volumeRef.current = 0;
        ctx.close();
      };

      source.start();
      tick();
    } catch {
      console.warn("AivisSpeech unavailable, using Web Speech fallback");
      speakFallback(text);
    }
  }

  function callOut(z: Exclude<DistanceZone, "absent">) {
    const isGroup = faceCountRef.current >= 2;
    const pool = isGroup ? GROUP_LINES[z] : LINES[z];
    speak(pool[Math.floor(Math.random() * pool.length)]);
  }

  // 自動呼び込み制御：距離ゾーンに応じてセリフ・クールダウンを変える
  const lastCall = useRef(0);
  const wasPresent = useRef(false);
  useEffect(() => {
    const id = setInterval(() => {
      const p = presentRef.current;
      const z = getDistanceZone(faceSizeRef.current);
      setPresent(p);
      setFaces(faceCountRef.current);
      setZone(z);

      if (started && p && z !== "absent") {
        const now = performance.now();
        const cooldown = COOLDOWN[z];
        // 不在→在 の瞬間、またはクールダウン経過後に再呼び込み
        const isNewArrival = !wasPresent.current;
        if (isNewArrival || now - lastCall.current > cooldown) {
          if (now - lastCall.current > 1500) { // 連打防止（最低1.5秒）
            callOut(z);
            lastCall.current = now;
          }
        }
      }
      wasPresent.current = p;
    }, 150);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [started]);

  function handleStart() {
    setStarted(true);
    callOut("mid"); // 音声解放を兼ねた初回発話
    lastCall.current = performance.now();
  }

  return (
    <div style={{ position: "fixed", inset: 0 }}>
      <Canvas camera={{ position: CAM_BASE, fov: 35 }}>
        <color attach="background" args={["#15151f"]} />
        <fog attach="fog" args={["#15151f", 4, 9]} />

        <ambientLight intensity={0.7} />
        <directionalLight position={[2, 4, 3]} intensity={1.3} />
        <directionalLight position={[-3, 2, -2]} intensity={0.5} color="#88aaff" />

        <OffAxisCamera faceCenterRef={faceCenterRef} />

        <Suspense fallback={null}>
          <Avatar speakingRef={speakingRef} volumeRef={volumeRef} faceCenterRef={faceCenterRef} allFaceCentersRef={allFaceCentersRef} expressionRef={expressionRef} />
        </Suspense>
      </Canvas>

      {/* 検出用カメラ（確認のため小窓表示。展示では消す） */}
      <video
        ref={videoRef}
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
          border: present ? "2px solid #0f8" : "2px solid #333",
          borderRadius: 6,
          zIndex: 10,
        }}
      />

      {!started ? (
        <button style={startBtnStyle} onClick={handleStart}>
          ▶ 展示スタート
        </button>
      ) : (
        <button style={callBtnStyle} onClick={() => callOut(zone !== "absent" ? zone : "mid")}>
          🔊 手動呼び込み
        </button>
      )}

      <div style={hudStyle}>
        cam: {camError ? `ERR ${camError}` : camReady ? "ok" : "…"} | 在席:{" "}
        {present ? "YES" : "no"} | 顔: {faces} | zone: {zone} | {started ? "稼働中" : "停止中"}
      </div>
    </div>
  );
}

const startBtnStyle: CSSProperties = {
  position: "absolute",
  top: "50%",
  left: "50%",
  transform: "translate(-50%, -50%)",
  padding: "16px 36px",
  fontSize: 18,
  fontWeight: "bold",
  color: "#fff",
  background: "linear-gradient(135deg, #ff6ad5, #8b5cf6)",
  border: "none",
  borderRadius: 12,
  cursor: "pointer",
  boxShadow: "0 4px 20px rgba(139,92,246,0.6)",
};

const callBtnStyle: CSSProperties = {
  position: "absolute",
  bottom: 16,
  left: "50%",
  transform: "translateX(-50%)",
  padding: "10px 20px",
  fontSize: 14,
  color: "#fff",
  background: "rgba(139,92,246,0.8)",
  border: "none",
  borderRadius: 8,
  cursor: "pointer",
};

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
};
