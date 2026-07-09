import { Suspense, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls, Grid } from "@react-three/drei";
import { Avatar } from "../components/Avatar";
import { Room } from "../components/Room";
import type { DistanceZone, FaceCenter, FaceExpression } from "../hooks/useFaceDetection";

// 実カメラ・実LLMなしでアニメーションだけ手動トリガーして見るための試験用ページ。
// 本番App.tsxと同じrefインターフェースをAvatarに渡し、値はUIのボタン/スライダーから流し込む。
// カメラを持たない設計のため、視線・物体検知が絡む機能は下記のように手動シミュレートするUIで代用する。

// useFaceDetection.getDistanceZoneのしきい値に対応する代表値
const ZONE_SIZE: Record<DistanceZone, number> = {
  absent: 0,
  far: 0.08,
  mid: 0.18,
  near: 0.32,
};

// 見つめ合いゲーム: コマンド起動制（ボタンでモードに入り、条件成立の瞬間に発動）
const EYE_CONTACT_WIN_MS = 3000; // これだけ見つめ続けたら勝ち
const EYE_CONTACT_LINES = [
  "ちょっ…そんな見つめないでよ…照れるじゃん！",
  "わっ、ずっと目ぇ合ってる！これはこれで…ドキドキするな！",
  "見つめ合い勝負、あなたの勝ち！参りました〜！",
];

// 持ち物当てマジック: コマンド起動制。YOLOの検知結果を「心を読んでる」風に言い当てる演出。
// 誤検知で気まずくならないよう、展示会場で実際に持ってそうな品目だけに絞ってある
const MAGIC_TRICK_CLASSES: Record<string, string> = {
  "cell phone": "スマホ",
  backpack: "リュック",
  handbag: "カバン",
  umbrella: "傘",
  bottle: "飲み物のボトル",
  cup: "カップ",
  book: "本",
  laptop: "パソコン",
  suitcase: "スーツケース",
  tie: "ネクタイ",
};
const MAGIC_TRICK_LINES = (item: string) => [
  `ちょっと待って、あなたの心を読んでみるね…えいっ！…${item}、持ってるでしょ！当たった！？`,
  `レムの目には全部お見通し！${item}、持ってきたよね？`,
  `くんくん…これは${item}の匂いがする！持ってるでしょ、当たり！`,
];

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

  // 見つめ合いゲーム: "armed"でモードに入り、"見つめる"チェックが3秒続いたら勝利して自動でモードを抜ける
  const [eyeGameArmed, setEyeGameArmed] = useState(false);
  const [gazingSim, setGazingSim] = useState(false); // 視線シミュレート（カメラが無いため手動チェックボックスで代用）
  const [eyeGameElapsed, setEyeGameElapsed] = useState(0);
  const [eyeGameResult, setEyeGameResult] = useState("");
  const eyeGameSinceRef = useRef(0);

  // 見つめ合いゲームの経過時間を100ms間隔でポーリング（3D描画ループとは無関係な単純なUI状態なのでsetIntervalで十分）
  useEffect(() => {
    if (!eyeGameArmed) return;
    const id = setInterval(() => {
      if (!gazingSim) {
        eyeGameSinceRef.current = 0;
        setEyeGameElapsed(0);
        return;
      }
      if (eyeGameSinceRef.current === 0) eyeGameSinceRef.current = performance.now();
      const elapsed = performance.now() - eyeGameSinceRef.current;
      setEyeGameElapsed(elapsed);
      if (elapsed >= EYE_CONTACT_WIN_MS) {
        const line = EYE_CONTACT_LINES[Math.floor(Math.random() * EYE_CONTACT_LINES.length)];
        setEyeGameResult(line);
        setEyeGameArmed(false);
        setGazingSim(false);
        eyeGameSinceRef.current = 0;
        setEyeGameElapsed(0);
      }
    }, 100);
    return () => clearInterval(id);
  }, [eyeGameArmed, gazingSim]);

  function toggleEyeGame() {
    const next = !eyeGameArmed;
    setEyeGameArmed(next);
    setGazingSim(false);
    eyeGameSinceRef.current = 0;
    setEyeGameElapsed(0);
    if (next) setEyeGameResult("");
  }

  // マジックモード: "armed"でモードに入り、品目ボタンを押すとそれを検知したことにして発動、自動でモードを抜ける
  const [magicArmed, setMagicArmed] = useState(false);
  const [magicResult, setMagicResult] = useState("");

  function toggleMagic() {
    const next = !magicArmed;
    setMagicArmed(next);
    if (next) setMagicResult("");
  }

  function triggerMagicItem(className: string) {
    if (!magicArmed) return;
    const item = MAGIC_TRICK_CLASSES[className];
    const lines = MAGIC_TRICK_LINES(item);
    setMagicResult(lines[Math.floor(Math.random() * lines.length)]);
    setMagicArmed(false);
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

        <div style={rowStyle}>
          <span style={labelStyle}>見つめ合いゲーム（コマンド起動）</span>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <button onClick={toggleEyeGame} style={{ ...btnStyle, background: eyeGameArmed ? "#ef4444" : "#374151" }}>
              {eyeGameArmed ? "■ モード終了" : "▶ ゲーム開始"}
            </button>
            {eyeGameArmed && (
              <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12 }}>
                <input
                  type="checkbox"
                  checked={gazingSim}
                  onChange={(e) => setGazingSim(e.target.checked)}
                />
                見つめる（シミュレート）
              </label>
            )}
          </div>
          {eyeGameArmed && (
            <span style={{ fontSize: 11, opacity: 0.7 }}>
              {(eyeGameElapsed / 1000).toFixed(1)}s / {(EYE_CONTACT_WIN_MS / 1000).toFixed(0)}s
            </span>
          )}
          {eyeGameResult && <span style={resultStyle}>{eyeGameResult}</span>}
        </div>

        <div style={rowStyle}>
          <span style={labelStyle}>マジックモード（コマンド起動・持ち物当て）</span>
          <button onClick={toggleMagic} style={{ ...btnStyle, background: magicArmed ? "#ef4444" : "#374151" }}>
            {magicArmed ? "■ モード終了" : "▶ マジックモードON"}
          </button>
          {magicArmed && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 4 }}>
              {Object.entries(MAGIC_TRICK_CLASSES).map(([cls, label]) => (
                <button
                  key={cls}
                  onClick={() => triggerMagicItem(cls)}
                  style={{ ...btnStyle, background: "#374151", fontSize: 11, padding: "4px 8px" }}
                >
                  {label}を見せる
                </button>
              ))}
            </div>
          )}
          {magicResult && <span style={resultStyle}>{magicResult}</span>}
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

const resultStyle: CSSProperties = {
  marginTop: 4,
  padding: "6px 8px",
  background: "rgba(139,92,246,0.25)",
  border: "1px solid rgba(139,92,246,0.5)",
  borderRadius: 6,
  fontSize: 12,
  lineHeight: 1.4,
};
