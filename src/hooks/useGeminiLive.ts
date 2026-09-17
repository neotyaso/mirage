import { useCallback, useEffect, useRef, useState } from "react";
import { GoogleGenAI, Modality } from "@google/genai";
import type { LiveServerMessage } from "@google/genai";

// Gemini Live API 直結フック (AI Studio と同じ公式SDK方式)。
// 自前WS実装は捨てた。メッセージ形式・再接続はSDK任せ。
// 認証は VITE_GEMINI_API_KEY のブラウザ直結 (backend不要)。
// NOTE: キーはバンドルに含まれる。展示デモ割り切り。公開時は ephemeral token 方式に戻すこと。
// 音声: 送信 16kHz PCM16 / 受信 24kHz PCM16。

export type GeminiState = "disconnected" | "connecting" | "listening" | "speaking" | "error";

export type GeminiLogRole = "user" | "assistant";

export interface GeminiLogEntry {
  id: number;
  role: GeminiLogRole;
  text: string;
}

export interface GeminiMetrics {
  connectMs: number | null;
  firstAudioMs: number | null;
  turns: number;
  disconnects: number;
}

const IN_RATE = 16_000;
const OUT_RATE = 24_000;
const MODEL = "gemini-3.8-live";
// 声は Zephyr 固定 (Lab側の選択肢は撤去済み)
const VOICE = "Zephyr";

const SYSTEM_PROMPT =
  "あなたは展示ブースの明るい受付嬢レムです。日本語で、短く元気に話します。" +
  "一文は40文字以内。相手の話に具体的に反応し、質問で会話を続けます。";

interface UseGeminiLiveOptions {
  onStateChange?: (s: GeminiState) => void;
  onError?: (e: Error) => void;
  onInputText?: (t: string) => void;
  onOutputText?: (t: string) => void;
}

function b64encodeBytes(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

type LiveSession = Awaited<ReturnType<GoogleGenAI["live"]["connect"]>>;

export function useGeminiLive(options: UseGeminiLiveOptions = {}) {
  const { onStateChange, onError, onInputText, onOutputText } = options;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const onInputTextRef = useRef(onInputText);
  onInputTextRef.current = onInputText;
  const onOutputTextRef = useRef(onOutputText);
  onOutputTextRef.current = onOutputText;

  const sessionRef = useRef<LiveSession | null>(null);
  const capCtxRef = useRef<AudioContext | null>(null);
  const capNodeRef = useRef<AudioWorkletNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const playCtxRef = useRef<AudioContext | null>(null);
  // 再生追跡は単一refに集約 (playing=再生中 / cursor=次chunk予約時刻 / gen=世代 / current=直近source / active=予約済みsource群)
  const playRef = useRef<{
    playing: boolean;
    cursor: number;
    gen: number;
    current: AudioBufferSourceNode | null;
    active: Set<AudioBufferSourceNode>;
  }>({ playing: false, cursor: 0, gen: 0, current: null, active: new Set() });
  const stateRef = useRef<GeminiState>("disconnected");
  const attemptRef = useRef(0);

  const [state, setState] = useState<GeminiState>("disconnected");
  const [micLevel, setMicLevel] = useState(0);
  const [outLevel, setOutLevel] = useState(0);
  const [via, setVia] = useState("");
  const [log, setLog] = useState<GeminiLogEntry[]>([]);
  const [metrics, setMetrics] = useState<GeminiMetrics>({
    connectMs: null,
    firstAudioMs: null,
    turns: 0,
    disconnects: 0,
  });
  const logIdRef = useRef(0);
  const connectStartRef = useRef<number | null>(null);
  const firstAudioDoneRef = useRef(false);

  const setStateSafe = useCallback(
    (s: GeminiState) => {
      stateRef.current = s;
      setState(s);
      onStateChange?.(s);
    },
    [onStateChange]
  );

  const resetTranscript = useCallback(() => {
    logIdRef.current = 0;
    setLog([]);
  }, []);

  const appendLog = useCallback((role: GeminiLogRole, text: string) => {
    const id = logIdRef.current++;
    setLog((prev) => [...prev, { id, role, text }]);
  }, []);

  const stopPlayback = useCallback(() => {
    const p = playRef.current;
    for (const src of p.active) {
      try {
        src.stop();
      } catch {
        /* already stopped */
      }
      try {
        src.disconnect();
      } catch {
        /* ignore */
      }
    }
    p.active.clear();
    p.current = null;
    p.cursor = 0;
    p.playing = false;
  }, []);

  const playPcm24k = useCallback(
    async (pcm: Float32Array) => {
      if (connectStartRef.current !== null && !firstAudioDoneRef.current) {
        firstAudioDoneRef.current = true;
        const ms = performance.now() - connectStartRef.current;
        setMetrics((m) => (m.firstAudioMs === null ? { ...m, firstAudioMs: ms } : m));
      }
      let sum = 0;
      for (let i = 0; i < pcm.length; i++) sum += pcm[i] * pcm[i];
      setOutLevel(Math.min(1, Math.sqrt(sum / pcm.length) * 3));

      if (!playCtxRef.current) {
        playCtxRef.current = new AudioContext({ sampleRate: OUT_RATE });
      }
      const ctx = playCtxRef.current;
      if (ctx.state === "suspended") await ctx.resume();
      setStateSafe("speaking");

      // ギャップレス再生: onended連鎖だとJSスレッドの隙間でブツ切れになるため、
      // AudioContext時刻基準で次チャンクを予約していく
      const buf = ctx.createBuffer(1, pcm.length, OUT_RATE);
      buf.copyToChannel(pcm as Float32Array<ArrayBuffer>, 0);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      const p = playRef.current;
      p.active.add(src);
      const now = ctx.currentTime;
      if (p.cursor < now - 0.2) p.cursor = now + 0.05;
      const startAt = p.cursor;
      p.cursor = startAt + buf.duration;
      p.gen += 1;
      const myGen = p.gen;
      p.current = src;
      p.playing = true;
      src.onended = () => {
        p.active.delete(src);
        if (p.current === src) p.current = null;
        // 猶予内に新チャンクが来なければ発話終了とみなす
        setTimeout(() => {
          if (p.gen === myGen && stateRef.current === "speaking") {
            p.playing = false;
            setStateSafe("listening");
          }
        }, 350);
      };
      try {
        src.start(startAt);
      } catch {
        p.active.delete(src);
      }
    },
    [setStateSafe]
  );

  const handleServerMessage = useCallback(
    async (msg: LiveServerMessage) => {
      const sc = msg.serverContent;
      if (!sc) return;
      if (sc.turnComplete) {
        setMetrics((m) => ({ ...m, turns: m.turns + 1 }));
        if (stateRef.current !== "disconnected") setStateSafe("listening");
        return;
      }
      if (sc.interrupted) {
        stopPlayback();
        setStateSafe("listening");
        return;
      }
      for (const part of sc.modelTurn?.parts ?? []) {
        const data = part.inlineData?.data;
        if (data) {
          try {
            const bin = atob(data);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
            const int16 = new Int16Array(buf);
            const f = new Float32Array(int16.length);
            for (let i = 0; i < int16.length; i++) f[i] = int16[i] / 32768;
            await playPcm24k(f);
          } catch (e) {
            console.error("[Gemini] audio decode failed:", e);
          }
        }
      }
      const outT = sc.outputTranscription?.text;
      if (outT) {
        appendLog("assistant", outT);
        onOutputTextRef.current?.(outT);
      }
      const inT = sc.inputTranscription?.text;
      if (inT) {
        appendLog("user", inT);
        onInputTextRef.current?.(inT);
      }
    },
    [playPcm24k, stopPlayback, setStateSafe, appendLog]
  );

  const startCapture = useCallback(async () => {
    if (capCtxRef.current) return;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, sampleRate: IN_RATE, echoCancellation: true, noiseSuppression: true },
    });
    streamRef.current = stream;
    const ctx = new AudioContext({ sampleRate: IN_RATE });
    capCtxRef.current = ctx;
    const src = ctx.createMediaStreamSource(stream);
    const code = `class Cap extends AudioWorkletProcessor {
      constructor(){ super(); this.buf=[]; }
      process(inputs){
        const ch = inputs[0]?.[0];
        if (ch) {
          let sum=0;
          for (let i=0;i<ch.length;i++){ this.buf.push(ch[i]); sum+=ch[i]*ch[i]; }
          this.port.postMessage({type:"lvl", v:Math.sqrt(sum/ch.length)});
          while (this.buf.length >= 2048) {
            const out = this.buf.slice(0,2048); this.buf = this.buf.slice(2048);
            this.port.postMessage({type:"frame", pcm:out});
          }
        }
        return true;
      }
    }
    registerProcessor("gemini-cap", Cap);`;
    const blobUrl = URL.createObjectURL(new Blob([code], { type: "application/javascript" }));
    try {
      await ctx.audioWorklet.addModule(blobUrl);
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
    if (capCtxRef.current !== ctx) {
      void ctx.close().catch(() => {});
      return;
    }
    const node = new AudioWorkletNode(ctx, "gemini-cap");
    capNodeRef.current = node;
    // レベル表示は約10Hzに間引く (125Hz再レンダーは固まる元)
    let lvlCount = 0;
    let lastLvl = 0;
    node.port.onmessage = (e: MessageEvent) => {
      if (e.data?.type === "lvl") {
        const v = Math.min(1, Number(e.data.v) * 3);
        lvlCount++;
        if (lvlCount % 12 === 0 || Math.abs(v - lastLvl) > 0.25) {
          lastLvl = v;
          setMicLevel(v);
        }
      } else if (e.data?.type === "frame" && sessionRef.current) {
        const arr = Float32Array.from(e.data.pcm as number[]);
        const int16 = new Int16Array(arr.length);
        for (let i = 0; i < arr.length; i++) {
          int16[i] = Math.round(Math.max(-1, Math.min(1, arr[i])) * 32767);
        }
        try {
          void sessionRef.current.sendRealtimeInput({
            audio: { data: b64encodeBytes(new Uint8Array(int16.buffer)), mimeType: "audio/pcm;rate=16000" },
          });
        } catch (err) {
          console.error("[Gemini] send failed:", err);
        }
      }
    };
    src.connect(node);
    // NOTE: node.connect(ctx.destination) はしない (ハウリング防止)
  }, []);

  const stopCapture = useCallback(() => {
    capNodeRef.current?.disconnect();
    capNodeRef.current = null;
    void capCtxRef.current?.close().catch(() => {});
    capCtxRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  const connect = useCallback(
    async () => {
    try {
      sessionRef.current?.close();
    } catch {
      /* ignore */
    }
    sessionRef.current = null;
    if (!playCtxRef.current) playCtxRef.current = new AudioContext({ sampleRate: OUT_RATE });
    if (playCtxRef.current.state === "suspended") await playCtxRef.current.resume();

    const myAttempt = ++attemptRef.current;
    connectStartRef.current = performance.now();
    firstAudioDoneRef.current = false;
    setMetrics((m) => ({ ...m, connectMs: null, firstAudioMs: null }));
    setStateSafe("connecting");
    setVia("キー確認中…");
    const apiKey = import.meta.env.VITE_GEMINI_API_KEY as string | undefined;
    if (!apiKey) {
      setVia("");
      setStateSafe("error");
      throw new Error("VITE_GEMINI_API_KEY 未設定 (直下.env を確認)");
    }
    setVia("SDK直結");
    const ai = new GoogleGenAI({ apiKey });
    const handleMessage = handleServerMessage;
    const session = await ai.live.connect({
      model: MODEL,
      config: {
        responseModalities: [Modality.AUDIO],
        systemInstruction: SYSTEM_PROMPT,
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE } } },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
      },
      callbacks: {
        onopen: () => {
          if (attemptRef.current !== myAttempt) return;
          if (connectStartRef.current !== null) {
            const ms = performance.now() - connectStartRef.current;
            setMetrics((m) => ({ ...m, connectMs: ms }));
          }
          setStateSafe("listening");
          void startCapture().catch((e) => onErrorRef.current?.(e as Error));
        },
        onmessage: (msg: LiveServerMessage) => {
          if (attemptRef.current !== myAttempt) return;
          void handleMessage(msg);
        },
        onerror: (e: ErrorEvent) => {
          onErrorRef.current?.(new Error(e.message || "session error"));
        },
        onclose: (e: CloseEvent) => {
          if (attemptRef.current !== myAttempt) return;
          setMetrics((m) => ({ ...m, disconnects: m.disconnects + 1 }));
          if (stateRef.current !== "disconnected") setStateSafe("disconnected");
          void e;
        },
      },
    });
    if (attemptRef.current !== myAttempt) {
      try {
        session.close();
      } catch {
        /* ignore */
      }
      return;
    }
    sessionRef.current = session;
  }, [setStateSafe, handleServerMessage, startCapture]);

  /** 手動ターン確定 */
  const commitUtterance = useCallback(() => {
    try {
      void sessionRef.current?.sendRealtimeInput({ activityEnd: {} });
    } catch (e) {
      console.error("[Gemini] commit failed:", e);
    }
  }, []);

  const disconnect = useCallback(() => {
    attemptRef.current++;
    try {
      sessionRef.current?.close();
    } catch {
      /* ignore */
    }
    sessionRef.current = null;
    stopCapture();
    stopPlayback();
    setVia("");
    setStateSafe("disconnected");
  }, [stopCapture, stopPlayback, setStateSafe]);

  useEffect(() => {
    if (state === "disconnected" || state === "error") {
      stopCapture();
      stopPlayback();
    }
  }, [state, stopCapture, stopPlayback]);

  // unmount時の後始末はdisconnectと同一ヘルパー経由に集約
  // (disconnect本体は呼ばない: setState/setVia不要・attempt加算不要のため。挙動同一)
  useEffect(() => {
    return () => {
      try {
        sessionRef.current?.close();
      } catch {
        /* ignore */
      }
      sessionRef.current = null;
      stopCapture();
      stopPlayback();
      void playCtxRef.current?.close().catch(() => {});
      playCtxRef.current = null;
    };
  }, [stopCapture, stopPlayback]);

  return {
    state,
    via,
    connect,
    disconnect,
    commitUtterance,
    resetTranscript,
    log,
    metrics,
    isConnected: state !== "disconnected" && state !== "error" && state !== "connecting",
    micLevel,
    outLevel,
  };
}
