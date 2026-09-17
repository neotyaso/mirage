import { useCallback, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { useGeminiLive } from "../hooks/useGeminiLive";
import type { GeminiState } from "../hooks/useGeminiLive";

// Gemini Live API (gemini-3.8-live) の単体テストページ。
// 開き方: `npm run dev` → http://localhost:5173/gemini-lab.html
// 要: .env に GEMINI_API_KEY (vite proxy が ?key= 付与、ブラウザには出さない)。

interface LogEntry {
  id: number;
  time: string;
  kind: string;
  text: string;
}

const STATE_COLOR: Record<GeminiState, string> = {
  disconnected: "#6b7280",
  connecting: "#f59e0b",
  listening: "#22c55e",
  speaking: "#3b82f6",
  error: "#ef4444",
};

function now(): string {
  const d = new Date();
  return `${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}.${String(
    d.getMilliseconds()
  ).padStart(3, "0")}`;
}

export function GeminiLab() {
  const [log, setLog] = useState<LogEntry[]>([]);
  const [logState, setLogState] = useState(false);
  const [inputText, setInputText] = useState("");
  const [outputText, setOutputText] = useState("");
  const idRef = useRef(0);
  const logEndRef = useRef<HTMLDivElement>(null);
  const logStateRef = useRef(logState);
  logStateRef.current = logState;

  const pushLog = useCallback((kind: string, text: string) => {
    const id = ++idRef.current;
    setLog((prev) => [...prev.slice(-199), { id, time: now(), kind, text }]);
    requestAnimationFrame(() => logEndRef.current?.scrollIntoView({ behavior: "smooth" }));
  }, []);

  const gemini = useGeminiLive({
    onStateChange: (s) => {
      if (logStateRef.current) pushLog("state", `→ ${s}`);
    },
    onError: (e) => pushLog("error", e.message),
    onInputText: (t) => {
      setInputText((prev) => (prev + " " + t).slice(-500));
      pushLog("in", t);
    },
    onOutputText: (t) => {
      setOutputText((prev) => (prev + t).slice(-1000));
      pushLog("out", t);
    },
  });

  async function handleConnect() {
    pushLog("info", "connect (voice=Zephyr固定)");
    try {
      await gemini.connect();
      pushLog("info", "connected");
    } catch (e) {
      pushLog("error", `connect失敗: ${(e as Error).message}`);
    }
  }

  function copyLog() {
    const text = log.map((e) => `[${e.time}] ${e.kind}: ${e.text}`).join("\n");
    navigator.clipboard.writeText(text).catch(() => {});
  }

  const streaming = gemini.state === "listening" || gemini.state === "speaking";

  return (
    <div style={pageStyle}>
      <h1 style={{ fontSize: 18, margin: "0 0 4px" }}>Gemini Lab — Live API単体テスト</h1>
      <p style={{ fontSize: 12, opacity: 0.7, margin: "0 0 12px" }}>
        gemini-3.8-live に直結。接続→マイクが自動で流れ始める。
        割込（バージイン）対応。開き方: <code>npm run dev</code> → <code>/gemini-lab.html</code>
      </p>

      <div style={cardStyle}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <span
            style={{
              padding: "4px 12px",
              borderRadius: 999,
              background: STATE_COLOR[gemini.state],
              color: "#fff",
              fontSize: 13,
              fontWeight: "bold",
            }}
          >
            {gemini.state}
          </span>
          {gemini.isConnected ? (
            <button onClick={gemini.disconnect} style={{ ...btnStyle, background: "#ef4444" }}>
              切断
            </button>
          ) : (
            <button onClick={handleConnect} style={{ ...btnStyle, background: "#22c55e" }}>
              接続
            </button>
          )}
          <span style={{ fontSize: 12, opacity: 0.75 }}>
            {streaming ? "🎤 マイク送信中（16kHz）" : "🎤 停止中"}
          </span>
          {gemini.via && (
            <span style={{ fontSize: 12, opacity: 0.75 }}>経路: {gemini.via}</span>
          )}
          <button
            onClick={() => {
              gemini.commitUtterance();
              pushLog("info", "発話を確定 (activityEnd送信)");
            }}
            disabled={!gemini.isConnected}
            style={{ ...btnStyle, background: "#8b5cf6" }}
          >
            発話を確定
          </button>
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
            <span style={{ opacity: 0.75 }}>入力レベル</span>
            <div style={{ width: 120, height: 10, background: "#030712", borderRadius: 5, overflow: "hidden" }}>
              <div
                style={{
                  width: `${Math.round(gemini.micLevel * 100)}%`,
                  height: "100%",
                  background: gemini.micLevel > 0.5 ? "#22c55e" : "#3b82f6",
                }}
              />
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
            <span style={{ opacity: 0.75 }}>出力レベル</span>
            <div style={{ width: 120, height: 10, background: "#030712", borderRadius: 5, overflow: "hidden" }}>
              <div
                style={{
                  width: `${Math.round(gemini.outLevel * 100)}%`,
                  height: "100%",
                  background: gemini.outLevel > 0.5 ? "#22c55e" : "#a855f7",
                }}
              />
            </div>
          </div>
          <label style={{ fontSize: 12, display: "flex", gap: 4, alignItems: "center" }}>
            <input type="checkbox" checked={logState} onChange={(e) => setLogState(e.target.checked)} />
            状態遷移をログ
          </label>
        </div>
      </div>

      <div style={cardStyle}>
        <div style={labelStyle}>聞き取り（inputTranscription）</div>
        <div style={{ fontSize: 13, minHeight: 20 }}>{inputText || <span style={{ opacity: 0.5 }}>—</span>}</div>
      </div>

      <div style={cardStyle}>
        <div style={labelStyle}>応答テキスト（outputTranscription）</div>
        <div style={{ fontSize: 13, minHeight: 20 }}>{outputText || <span style={{ opacity: 0.5 }}>—</span>}</div>
      </div>

      <div style={cardStyle}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={labelStyle}>イベントログ（{log.length}）</span>
          <div style={{ display: "flex", gap: 6 }}>
            <button onClick={copyLog} style={{ ...btnStyle, padding: "4px 8px" }}>
              コピー
            </button>
            <button onClick={() => setLog([])} style={{ ...btnStyle, padding: "4px 8px" }}>
              クリア
            </button>
          </div>
        </div>
        <div style={logStyle}>
          {log.map((e) => (
            <div key={e.id} style={{ color: e.kind === "error" ? "#f87171" : undefined }}>
              [{e.time}] {e.kind}: {e.text}
            </div>
          ))}
          <div ref={logEndRef} />
        </div>
      </div>
    </div>
  );
}

const pageStyle: CSSProperties = {
  maxWidth: 720,
  margin: "0 auto",
  padding: "20px 16px 40px",
  fontFamily: "sans-serif",
  fontSize: 14,
  background: "#111827",
  color: "#f9fafb",
  minHeight: "100vh",
};

const cardStyle: CSSProperties = {
  background: "#1f2937",
  borderRadius: 10,
  padding: "12px 14px",
  marginBottom: 12,
  display: "flex",
  flexDirection: "column",
  gap: 8,
};

const labelStyle: CSSProperties = { fontSize: 12, opacity: 0.7 };

const btnStyle: CSSProperties = {
  padding: "6px 12px",
  fontSize: 13,
  color: "#fff",
  background: "#374151",
  border: "none",
  borderRadius: 6,
  cursor: "pointer",
};

const logStyle: CSSProperties = {
  background: "#030712",
  borderRadius: 6,
  padding: "8px 10px",
  fontSize: 12,
  fontFamily: "monospace",
  maxHeight: 260,
  overflowY: "auto",
  display: "flex",
  flexDirection: "column",
  gap: 2,
};
