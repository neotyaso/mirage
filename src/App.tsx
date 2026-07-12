import { Suspense, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Avatar } from "./components/Avatar";
import { Room } from "./components/Room";
import { Glow } from "./components/Glow";
import { useFaceDetection, getDistanceZone } from "./hooks/useFaceDetection";
import type { FaceCenter, DistanceZone } from "./hooks/useFaceDetection";
import { useConversation } from "./hooks/useConversation";
import type { ConvState } from "./hooks/useConversation";
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
    // 表示映像は鏡像（scaleX(-1)）。来場者が自分の右に動く→鏡像では右に見える
    // →「窓」として同じ方向にカメラを動かすため fc.x をそのまま使う
    const tx = fc ? (fc.x - 0.5) * 2 * CAM_RANGE_X : 0;
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

// 離脱時の別れの一言（実際に会話してた場合のみ発話。呼び込みだけで素通りされた時は言わない）
const FAREWELL_LINES = [
  "またね〜！話せて楽しかった！",
  "ありがとう〜！気をつけて帰ってね！",
  "えー、もう行っちゃうの！？また来てよね！",
];

// 視線を外すと構うセリフ。無視され続けるほどエスカレートする「食い下がるキャッチ」の演技段階
// (段階1: 軽く呼びかけ → 段階2: ちょっと拗ねる → 段階3以降: 可愛く食い下がる/開き直る)
const LOOK_AWAY_LINES_TIERED: string[][] = [
  [
    "ねえねえ、こっち見てよ〜！",
    "あれ、目そらした？さみしいって！",
  ],
  [
    "ちょっとちょっと、まだ話してる途中だよ〜",
    "え、無視？そんな子だと思わなかったな〜",
  ],
  [
    "もーっ！そんなに私のこと見たくない！？いいもん、でも見て！",
    "無視されるとますます構いたくなるんですけど！ガハハ！",
    "これはこれで面白いから許す！でもちゃんと見て〜！",
  ],
];
const LOOK_AWAY_YAW_THRESHOLD = 0.5; // ラジアン（約28度）。これ以上そっぽを向いたら「外した」判定
const LOOK_AWAY_SUSTAIN_MS = 1500;   // これだけ継続してそっぽを向いたら反応（一瞬の視線移動では反応しない）
const LOOK_AWAY_COOLDOWN_MS = 15000; // 連発しないためのクールダウン

// プロクセミクス反応: 距離の"量"でなく"来かた"に反応する。
// faceSize(顔の正規化幅)の変化速度を見て、急接近だけ驚くセリフを挟む
const STARTLE_LINES = [
  "わっ、近い近い！びっくりした〜！",
  "うおっ！？急にどうしたの！？",
  "ちょっ、そんな勢いで来ないでよ〜！",
];
const STARTLE_SPEED_THRESHOLD = 0.35; // faceSize/秒。この速さを超える接近を「急接近」とみなす
const STARTLE_MIN_SIZE = 0.12;        // far未満(相手が遠すぎる)での誤反応を避けるための下限
const STARTLE_COOLDOWN_MS = 10000;    // 連発防止


// AivisSpeech (VOICEVOX互換 API)
// スピーカーIDは GET http://localhost:10101/speakers で確認して変更
const AIVIS_URL = "http://localhost:10101";
const SPEAKER_ID = 888753760;

export default function App() {
  const speakingRef = useRef(false);
  const volumeRef = useRef(0);
  const panRef = useRef(0); // 空間オーディオ: -1(左)〜1(右)。来場者の画面上の左右位置に追従
  const { state: convState, log, startConversation, stopConversation, resetHistory, actionRef } = useConversation(speakingRef, volumeRef, panRef);
  const logEndRef = useRef<HTMLDivElement>(null);
  const { videoRef, presentRef, faceCountRef, faceCenterRef, faceSizeRef, faceYawRef, allFaceCentersRef, expressionRef, ready: camReady, error: camError } =
    useFaceDetection();

  const [started, setStarted] = useState(false);
  const [paused, setPaused] = useState(false);
  const [present, setPresent] = useState(false);
  const [faces, setFaces] = useState(0);
  const [zone, setZone] = useState<DistanceZone>("absent");
  const [debugMode, setDebugMode] = useState(false); // 展示本番では隠す。"d"キーで表示切り替え

  // "d"キーでデバッグUI（小窓カメラ・HUD・手動操作ボタン）の表示を切り替え
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "d") setDebugMode((v) => !v);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // チャットログが増えたら自動で最下部へスクロール
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [log]);

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

  const activeSourceRef = useRef<{ stop: () => void; ctx: AudioContext } | null>(null);

  async function speak(text: string) {
    // 前の音声がまだ再生中なら止めてから新しい発話を始める（声の重なり防止）
    if (activeSourceRef.current) {
      try { activeSourceRef.current.stop(); } catch { /* already stopped */ }
      activeSourceRef.current.ctx.close().catch(() => {});
      activeSourceRef.current = null;
    }
    speechSynthesis.cancel();

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
      activeSourceRef.current = { stop: () => source.stop(), ctx };

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
        if (activeSourceRef.current?.ctx === ctx) activeSourceRef.current = null;
        if (ctx.state !== "closed") ctx.close().catch(() => {});
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
  // near まで近づいたら自動で会話モードON。離れたら自動でOFF＋次の来場者のため履歴リセット
  const lastPresentAtRef = useRef(performance.now());
  const AWAY_TIMEOUT_MS = 4000; // これだけ不在が続いたら「離れた」と判断（顔検出の一瞬の途切れで切れないように）
  // 会話中に相手の顔検出が一瞬途切れて自動リセットされた直後の復帰では、
  // 「新規来場者」扱いの呼び込みセリフを鳴らさず静かに会話を再開する（2人目が現れて一瞬顔が隠れた時などに
  // 「ねえねえ話していかない？」が会話に割り込む不自然さを防ぐ）
  const silentResumeRef = useRef(false);
  // 視線を外すと構う: そっぽを向いた継続時間とクールダウンの管理
  const lookAwaySinceRef = useRef(0);
  const lastLookAwayCallRef = useRef(0);
  const lookAwayStreakRef = useRef(0); // 今回の来場でのエスカレーション段階（新規来場でリセット）
  // プロクセミクス反応: 直前のfaceSize/時刻を保持し、変化速度から急接近を検知
  const prevFaceSizeRef = useRef(0);
  const prevFaceSizeAtRef = useRef(0);
  const lastStartleRef = useRef(0);
  // 実際に会話ログがあるか（離脱時の別れの一言を言うか判定用）。
  // setInterval側のクロージャがconvState変化時にしか作り直されず、logの更新を都度拾えないためrefで同期する
  const hasLogRef = useRef(false);
  useEffect(() => {
    hasLogRef.current = log.length > 0;
  }, [log]);
  useEffect(() => {
    const id = setInterval(() => {
      const p = presentRef.current;
      const z = getDistanceZone(faceSizeRef.current);
      setPresent(p);
      setFaces(faceCountRef.current);
      setZone(z);

      // 空間オーディオ: 来場者の画面上の左右位置に合わせて声のパンを更新（OffAxisCameraと同じ符号規則）
      const fc = faceCenterRef.current;
      panRef.current = fc ? (fc.x - 0.5) * 2 : 0;

      // プロクセミクス反応: ゆっくり来る→何もしない、急に来る→驚くセリフ。
      // 距離の"量"でなく"来かた"（変化速度）だけを見る
      {
        const nowMs = performance.now();
        const curSize = faceSizeRef.current;
        const dt = (nowMs - prevFaceSizeAtRef.current) / 1000;
        if (prevFaceSizeAtRef.current > 0 && dt > 0 && dt < 1) {
          const speed = (curSize - prevFaceSizeRef.current) / dt;
          if (
            started && !paused && !speakingRef.current &&
            curSize > STARTLE_MIN_SIZE &&
            speed > STARTLE_SPEED_THRESHOLD &&
            nowMs - lastStartleRef.current > STARTLE_COOLDOWN_MS
          ) {
            speak(STARTLE_LINES[Math.floor(Math.random() * STARTLE_LINES.length)]);
            lastStartleRef.current = nowMs;
          }
        }
        prevFaceSizeRef.current = curSize;
        prevFaceSizeAtRef.current = nowMs;
      }

      if (started && !paused && p && z !== "absent" && !speakingRef.current && convState === "idle") {
        const now = performance.now();
        const cooldown = COOLDOWN[z];
        if (silentResumeRef.current) {
          silentResumeRef.current = false;
        } else {
          // 不在→在 の瞬間、またはクールダウン経過後に再呼び込み
          const isNewArrival = !wasPresent.current;
          if (isNewArrival) lookAwayStreakRef.current = 0; // 新規来場者には食い下がり演出をリセット
          if (isNewArrival || now - lastCall.current > cooldown) {
            if (now - lastCall.current > 1500) { // 連打防止（最低1.5秒）
              callOut(z);
              lastCall.current = now;
            }
          }
        }
      }
      wasPresent.current = p;

      // 視線を外すと構う: mid/near で来場者と向き合ってる最中にそっぽを向かれたら反応する。
      // 喋ってる最中・LLM応答中に割り込まないよう !speakingRef.current && convState !== "thinking" で守る
      if (
        started && !paused &&
        (z === "mid" || z === "near") &&
        !speakingRef.current && convState !== "thinking" &&
        Math.abs(faceYawRef.current) > LOOK_AWAY_YAW_THRESHOLD
      ) {
        const now = performance.now();
        if (lookAwaySinceRef.current === 0) lookAwaySinceRef.current = now;
        if (
          now - lookAwaySinceRef.current > LOOK_AWAY_SUSTAIN_MS &&
          now - lastLookAwayCallRef.current > LOOK_AWAY_COOLDOWN_MS
        ) {
          const tier = LOOK_AWAY_LINES_TIERED[Math.min(lookAwayStreakRef.current, LOOK_AWAY_LINES_TIERED.length - 1)];
          speak(tier[Math.floor(Math.random() * tier.length)]);
          lastLookAwayCallRef.current = now;
          lookAwaySinceRef.current = 0;
          lookAwayStreakRef.current += 1;
        }
      } else {
        lookAwaySinceRef.current = 0;
      }

      if (p) lastPresentAtRef.current = performance.now();
      if (started && !paused) {
        if (z === "near" && convState === "idle") {
          startConversation();
        }
        if (convState !== "idle" && performance.now() - lastPresentAtRef.current > AWAY_TIMEOUT_MS) {
          // 実際にやり取りがあった（ログが残っている）場合だけ別れの一言を挟む。
          // 呼び込みだけで素通りされた時にまで「またね」と言うと不自然なので
          if (hasLogRef.current) {
            speak(FAREWELL_LINES[Math.floor(Math.random() * FAREWELL_LINES.length)]);
          }
          stopConversation();
          resetHistory();
          silentResumeRef.current = true;
        }
      }
    }, 150);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [started, paused, convState]);

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
          <Room />
          <Avatar speakingRef={speakingRef} volumeRef={volumeRef} faceCenterRef={faceCenterRef} allFaceCentersRef={allFaceCentersRef} expressionRef={expressionRef} faceSizeRef={faceSizeRef} actionRef={actionRef} />
        </Suspense>
        <Glow />
      </Canvas>

      {/* 会話ログ（左側に流れるチャット） */}
      {started && log.length > 0 && (
        <div style={chatLogStyle}>
          {log.map((entry) => (
            <div key={entry.id} style={chatBubbleStyle(entry.role)}>
              <div style={chatSenderStyle}>{entry.role === "user" ? "あなた" : "レム"}</div>
              {entry.text}
            </div>
          ))}
          <div ref={logEndRef} />
        </div>
      )}

      {/* 検出用カメラ（顔検出が参照する実体なので常時マウント。展示中は"d"キーを押すまで非表示） */}
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
          visibility: debugMode ? "visible" : "hidden",
        }}
      />

      {!started ? (
        <button style={startBtnStyle} onClick={handleStart}>
          ▶ 展示スタート
        </button>
      ) : debugMode ? (
        <div style={{ position: "absolute", bottom: 16, left: "50%", transform: "translateX(-50%)", display: "flex", gap: 8 }}>
          {convState === "idle" && (
            <button style={callBtnStyle} onClick={() => callOut(zone !== "absent" ? zone : "mid")}>
              🔊 手動呼び込み
            </button>
          )}
          <button
            style={{ ...callBtnStyle, background: paused ? "rgba(34,197,94,0.8)" : "rgba(239,68,68,0.8)" }}
            onClick={() => {
              if (paused) {
                setPaused(false);
              } else {
                setPaused(true);
                speechSynthesis.cancel();
                speakingRef.current = false;
                volumeRef.current = 0;
              }
            }}
          >
            {paused ? "▶ 再開" : "⏸ 停止"}
          </button>
        </div>
      ) : null}

      {/* 会話パネル（手動操作用。会話はnear接近で自動開始するので通常は不要。デバッグ時のみ表示） */}
      {started && debugMode && (
        <div style={convPanelStyle}>
          <div style={{ marginBottom: 8, display: "flex", gap: 8, justifyContent: "center" }}>
            <button
              style={{ ...convBtnStyle, background: convState === "idle" ? "#8b5cf6" : "#ef4444" }}
              onClick={convState === "idle" ? startConversation : stopConversation}
            >
              {convState === "idle" ? "🎤 会話開始" : convState === "listening" ? "👂 聴いてる…" : convState === "thinking" ? "💭 考え中…" : "🔊 喋ってる"}
            </button>
            <button style={{ ...convBtnStyle, background: "#374151" }} onClick={resetHistory}>
              🔄 会話リセット
            </button>
          </div>
        </div>
      )}

      {debugMode && (
        <div style={hudStyle}>
          cam: {camError ? `ERR ${camError}` : camReady ? "ok" : "…"} | 在席:{" "}
          {present ? "YES" : "no"} | 顔: {faces} | zone: {zone} | conv: {convState} | {started ? "稼働中" : "停止中"}
        </div>
      )}
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

const convPanelStyle: CSSProperties = {
  position: "absolute",
  top: 16,
  left: "50%",
  transform: "translateX(-50%)",
  width: "min(480px, 90vw)",
  display: "flex",
  flexDirection: "column",
  gap: 6,
  zIndex: 20,
};

const convBtnStyle: CSSProperties = {
  padding: "10px 20px",
  fontSize: 14,
  color: "#fff",
  border: "none",
  borderRadius: 8,
  cursor: "pointer",
  fontWeight: "bold",
};

const chatLogStyle: CSSProperties = {
  position: "absolute",
  top: 16,
  left: 16,
  bottom: 72,
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
  background: role === "user" ? "rgba(55,65,81,0.85)" : "rgba(139,92,246,0.85)",
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
};
