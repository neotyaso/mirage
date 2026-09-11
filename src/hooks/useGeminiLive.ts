import { useCallback, useEffect, useRef, useState } from "react";
import { GoogleGenAI, Modality } from "@google/genai";
import type { LiveServerMessage } from "@google/genai";

// Gemini Live API 直結フック (AI Studio と同じ公式SDK方式)。
// 自前WS実装は捨てた。メッセージ形式・再接続はSDK任せ。
// 認証は backend (:8002) の /api/gemini-token の ephemeral token。
// 音声: 送信 16kHz PCM16 / 受信 24kHz PCM16。

export type GeminiState = "disconnected" | "connecting" | "listening" | "speaking" | "error";

const IN_RATE = 16_000;
const OUT_RATE = 24_000;
const MODEL = "gemini-3.1-flash-live-preview";
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
  const playQueueRef = useRef<Float32Array[]>([]);
  const playingRef = useRef(false);
  const currentSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const stateRef = useRef<GeminiState>("disconnected");
  const attemptRef = useRef(0);

  const [state, setState] = useState<GeminiState>("disconnected");
  const [micLevel, setMicLevel] = useState(0);
  const [outLevel, setOutLevel] = useState(0);
  const [via, setVia] = useState("");

  const setStateSafe = useCallback(
    (s: GeminiState) => {
      stateRef.current = s;
      setState(s);
      onStateChange?.(s);
    },
    [onStateChange]
  );

  const stopPlayback = useCallback(() => {
    playQueueRef.current = [];
    try {
      currentSourceRef.current?.stop();
    } catch {
      /* already stopped */
    }
    currentSourceRef.current = null;
    playingRef.current = false;
  }, []);

  const playPcm24k = useCallback(
    async (pcm: Float32Array) => {
      let sum = 0;
      for (let i = 0; i < pcm.length; i++) sum += pcm[i] * pcm[i];
      setOutLevel(Math.min(1, Math.sqrt(sum / pcm.length) * 3));

      if (!playCtxRef.current) {
        playCtxRef.current = new AudioContext({ sampleRate: OUT_RATE });
      }
      const ctx = playCtxRef.current;
      if (ctx.state === "suspended") await ctx.resume();
      setStateSafe("speaking");

      playQueueRef.current.push(pcm);
      if (playingRef.current) return;
      playingRef.current = true;
      while (playQueueRef.current.length > 0) {
        const next = playQueueRef.current.shift()!;
        const buf = ctx.createBuffer(1, next.length, OUT_RATE);
        buf.copyToChannel(next as Float32Array<ArrayBuffer>, 0);
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(ctx.destination);
        currentSourceRef.current = src;
        await new Promise<void>((resolve) => {
          src.onended = () => resolve();
          try {
            src.start();
          } catch {
            resolve();
          }
        });
        if (currentSourceRef.current === src) currentSourceRef.current = null;
      }
      playingRef.current = false;
      if (stateRef.current === "speaking") setStateSafe("listening");
    },
    [setStateSafe]
  );

  const handleServerMessage = useCallback(
    async (msg: LiveServerMessage) => {
      const sc = msg.serverContent;
      if (!sc) return;
      if (sc.turnComplete) {
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
      if (outT) onOutputTextRef.current?.(outT);
      const inT = sc.inputTranscription?.text;
      if (inT) onInputTextRef.current?.(inT);
    },
    [playPcm24k, stopPlayback, setStateSafe]
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
    setStateSafe("connecting");
    setVia("token取得中…");
    const r = await fetch("/api/gemini-token");
    if (!r.ok) {
      setVia("");
      setStateSafe("error");
      throw new Error(`token発行失敗: ${r.status} (:8002起動を確認)`);
    }
    const { token } = (await r.json()) as { token: string };
    if (!token) {
      setVia("");
      setStateSafe("error");
      throw new Error("token empty");
    }
    setVia("SDK直結");
    const ai = new GoogleGenAI({ apiKey: token });
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

  useEffect(() => {
    return () => {
      try {
        sessionRef.current?.close();
      } catch {
        /* ignore */
      }
      capNodeRef.current?.disconnect();
      void capCtxRef.current?.close().catch(() => {});
      streamRef.current?.getTracks().forEach((t) => t.stop());
      void playCtxRef.current?.close().catch(() => {});
    };
  }, []);

  return {
    state,
    via,
    connect,
    disconnect,
    commitUtterance,
    isConnected: state !== "disconnected" && state !== "error" && state !== "connecting",
    micLevel,
    outLevel,
  };
}
