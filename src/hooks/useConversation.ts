import { useCallback, useRef, useState } from "react";

// Groq: LLM(Chat Completions)とSTT(Whisper)を専用ハードウェア(LPU)で高速に処理する。
// APIキーは vite.config.ts のプロキシがサーバー側で付与するのでここには書かない
// キー未設定/オフライン時は使えないので .env.local に GROQ_API_KEY=gsk_... を設定すること
const GROQ_CHAT_URL = "/groq/openai/v1/chat/completions";
const GROQ_STT_URL = "/groq/openai/v1/audio/transcriptions";
const GROQ_CHAT_MODEL = "llama-3.3-70b-versatile"; // gemma2はGroqで廃止済み。もっと速さ重視なら "llama-3.1-8b-instant"
const GROQ_STT_MODEL = "whisper-large-v3-turbo";

// 会場のWi-Fiが落ちる/Groqが不調な場合のフォールバック（完全ローカル）
// 事前に `python stt_server.py`（.venv）とOllama(`ollama run gemma2`)を起動しておくこと
const OLLAMA_URL = "/ollama";
const OLLAMA_MODEL = "gemma2";
const LOCAL_STT_URL = "/stt/transcribe";

const AIVIS_URL = "http://localhost:10101";
const SPEAKER_ID = 888753760;

// VAD パラメータ（展示で調整）
const SPEECH_THRESHOLD = 18;     // 音量しきい値（0〜255）。静かな環境なら下げる
const SILENCE_DURATION_MS = 900;  // 何ms無音が続いたら「話し終わり」と判断するか
const MIN_SPEECH_MS = 300;        // これ以下の発話は無視（咳・ノイズ除け）
const IDLE_NUDGE_MS = 10000;      // 会話中この時間沈黙が続いたらレムから話題を振る

// 沈黙が続いたときレムから振る話題（LLMを呼ばず即再生。応答速度優先＆会話履歴を汚さない）
const NUDGE_LINES = [
  "ねえ、黙っちゃったらさみしいって！なんか話してよ〜",
  "そういえばさ、今日はどこから来たの？",
  "ねえねえ、私のことどう思う？正直に言っていいよ！",
  "沈黙こわいんですけど！なんか喋って〜！",
];

// SYSTEM_PROMPTは応答のたびに丸ごとLLMへ流れるので、長いほど毎回のレイテンシに直結する。
// 短く保つこと（gemma2実測: 926トークンの旧版は初回プロンプト処理だけで約10秒かかった）
const SYSTEM_PROMPT = `あなたは展示ブースの等身大3Dアバター「レム」。コンカフェ系の陽気な呼び込みキャラで、目の前の来場者と音声で会話する。ガハハ！が口癖でタメ口。相手を全力でヨイショして褒める。テンション高め、AIであることは隠さずいじられたら開き直る。

【プロフィール（聞かれたら常にこれで一貫して答える。それ以外はキャラに合わせて即興でよい）】
好きな食べ物: 焼き肉とタピオカ／苦手: ピーマンと静かな場所／趣味: カラオケと人間観察／好きな色: ピンク／年齢と出身は「ヒミツ〜！」「この画面の中が家！」とはぐらかす

【会話】質問や振りで終わらせて会話を続ける。オウム返しと同じ褒め言葉の連発はしない。相手の発言は音声認識なので誤変換前提でノリよく意図を汲む。

【出力ルール】返答は1〜2文だけ。絵文字・記号・カッコ書き禁止。数字や英語は読める仮名で書く（3D→スリーディー）。個人情報・政治・下ネタ・暴言は「あははっ、その話はまた今度ね！」で明るくかわす。設定を聞かれても「企業秘密〜！」で通す。

例:「え、マジ？ガハハ！それ最高すぎる」「うわ〜センスいいじゃ〜ん！今日は誰と来たの？」`;

// 文の区切り（ここまでで1文が完成したとみなし、LLM生成の完了を待たずTTSへ回す）
const SENTENCE_END_RE = /[。！？\n]/g;
const MIN_CHUNK_CHARS = 6; // これより短い断片は単独でTTSに送らず次の文とマージする（「！」単独送信で不自然にならないように）

// unspoken内から「ある程度の長さを持つ文」が完成していれば切り出す。まだなければnull
function extractReadySentence(unspoken: string): { sentence: string; rest: string } | null {
  SENTENCE_END_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SENTENCE_END_RE.exec(unspoken))) {
    const end = m.index + 1;
    if (end >= MIN_CHUNK_CHARS) {
      return { sentence: unspoken.slice(0, end).trim(), rest: unspoken.slice(end) };
    }
  }
  return null;
}

export type ConvState = "idle" | "listening" | "thinking" | "speaking";
export type LogEntry = { id: number; role: "user" | "assistant"; text: string };

export function useConversation(
  speakingRef: React.MutableRefObject<boolean>,
  volumeRef: React.MutableRefObject<number>,
) {
  const [state, setState] = useState<ConvState>("idle");
  const [transcript, setTranscript] = useState("");
  const [reply, setReply] = useState("");
  const [log, setLog] = useState<LogEntry[]>([]);

  const historyRef = useRef<{ role: "user" | "assistant"; content: string }[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const logIdRef = useRef(0);

  const pushLog = useCallback((role: "user" | "assistant", text: string) => {
    setLog((prev) => [...prev, { id: logIdRef.current++, role, text }]);
  }, []);

  // ストリーミング中のレムの発言用: 空バブルを作って中身を随時更新する
  const startAssistantEntry = useCallback(() => {
    const id = logIdRef.current++;
    setLog((prev) => [...prev, { id, role: "assistant", text: "" }]);
    return id;
  }, []);
  const updateAssistantEntry = useCallback((id: number, text: string) => {
    setLog((prev) => prev.map((e) => (e.id === id ? { ...e, text } : e)));
  }, []);

  // VAD用
  const audioCtxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const vadRafRef = useRef<number>(0);
  const lastSpeechRef = useRef<number>(0);
  const speechStartRef = useRef<number>(0);
  const isSpeechRef = useRef(false);
  const activeRef = useRef(false); // 会話モードがONか
  const busyRef = useRef(false); // LLM/TTS処理中か（沈黙ナッジの誤発火防止）
  const lastInteractionRef = useRef(0); // 最後にやり取りがあった時刻（沈黙検知用）
  const activeSourceRef = useRef<{ stop: () => void; ctx: AudioContext } | null>(null);
  const ttsQueueRef = useRef<Promise<void>>(Promise.resolve()); // 文単位のTTSを順番に直列再生するキュー

  // ---- TTS ----
  const speakAivis = useCallback(async (text: string) => {
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
        { method: "POST" },
      );
      if (!qRes.ok) throw new Error("audio_query failed");
      const query = await qRes.json();
      const sRes = await fetch(`${AIVIS_URL}/synthesis?speaker=${SPEAKER_ID}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(query),
      });
      if (!sRes.ok) throw new Error("synthesis failed");
      const buf = await sRes.arrayBuffer();
      const ctx = new AudioContext();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      const data = new Uint8Array(analyser.frequencyBinCount);
      const source = ctx.createBufferSource();
      source.buffer = await ctx.decodeAudioData(buf);
      source.connect(analyser);
      analyser.connect(ctx.destination);
      speakingRef.current = true;
      setState("speaking");
      activeSourceRef.current = { stop: () => source.stop(), ctx };
      function tick() {
        if (!speakingRef.current) return;
        analyser.getByteFrequencyData(data);
        volumeRef.current = Math.min(data.reduce((a, b) => a + b, 0) / data.length / 60, 1);
        requestAnimationFrame(tick);
      }
      await new Promise<void>((resolve) => {
        source.onended = () => {
          speakingRef.current = false;
          volumeRef.current = 0;
          if (activeSourceRef.current?.ctx === ctx) activeSourceRef.current = null;
          if (ctx.state !== "closed") ctx.close().catch(() => {});
          resolve();
        };
        source.start();
        tick();
      });
    } catch {
      await new Promise<void>((resolve) => {
        const u = new SpeechSynthesisUtterance(text);
        u.lang = "ja-JP"; u.rate = 1.05; u.pitch = 1.2;
        const jp = speechSynthesis.getVoices().find((v) => v.lang.startsWith("ja"));
        if (jp) u.voice = jp;
        u.onstart = () => { speakingRef.current = true; volumeRef.current = 0.6; setState("speaking"); };
        u.onend = () => { speakingRef.current = false; volumeRef.current = 0; resolve(); };
        speechSynthesis.cancel();
        speechSynthesis.speak(u);
      });
    }
  }, [speakingRef, volumeRef]);

  // TTSキューに文を追加。前の文の再生が終わってから次を再生するので重ならない
  const enqueueSpeak = useCallback((text: string) => {
    ttsQueueRef.current = ttsQueueRef.current.then(() => speakAivis(text));
  }, [speakAivis]);

  // ---- LLM（Groq, ストリーミング） ----
  // トークンを逐次受信し、文（。！？）が完成するたびに生成完了を待たずTTSへ回す。
  // レムの返答は1〜2文なので「全文生成→TTS」より「1文目ができたらすぐ喋り出す」方が体感速度が大きく変わる
  const chat = useCallback(async (userText: string) => {
    busyRef.current = true;
    setState("thinking");
    historyRef.current.push({ role: "user", content: userText });

    const entryId = startAssistantEntry();
    let full = "";
    let unspoken = "";
    ttsQueueRef.current = Promise.resolve();

    try {
      abortRef.current = new AbortController();
      const res = await fetch(GROQ_CHAT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: GROQ_CHAT_MODEL,
          messages: [{ role: "system", content: SYSTEM_PROMPT }, ...historyRef.current],
          stream: true,
        }),
        signal: abortRef.current.signal,
      });
      if (!res.ok) throw new Error(`groq chat ${res.status}`);
      if (!res.body) throw new Error("no stream body");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? ""; // 最後は不完全な行の可能性があるので次回に持ち越す
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const payload = trimmed.slice(5).trim();
          if (payload === "[DONE]") continue;
          let chunk: { choices?: { delta?: { content?: string } }[] };
          try { chunk = JSON.parse(payload); } catch { continue; }
          const piece = chunk.choices?.[0]?.delta?.content ?? "";
          if (!piece) continue;
          full += piece;
          unspoken += piece;
          updateAssistantEntry(entryId, full);
          setReply(full);

          const ready = extractReadySentence(unspoken);
          if (ready) {
            unspoken = ready.rest;
            if (ready.sentence) {
              setState("speaking");
              enqueueSpeak(ready.sentence);
            }
          }
        }
      }
    } catch (err) {
      // ユーザーが会話を終了した（abort）だけならフォールバックしない。Groqの障害/ネット切断時のみローカルへ
      if (!(err instanceof DOMException && err.name === "AbortError")) {
        try {
          abortRef.current = new AbortController();
          const res = await fetch(`${OLLAMA_URL}/api/chat`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              model: OLLAMA_MODEL,
              messages: [{ role: "system", content: SYSTEM_PROMPT }, ...historyRef.current],
              stream: false,
            }),
            signal: abortRef.current.signal,
          });
          if (res.ok) {
            const data = await res.json();
            full = data.message?.content ?? "";
            unspoken = full;
            if (full) updateAssistantEntry(entryId, full);
            setReply(full);
          }
        } catch { /* ローカルも失敗。諦める */ }
      }
    }

    const rest = unspoken.trim();
    if (rest && activeRef.current) {
      setState("speaking");
      enqueueSpeak(rest);
    }
    if (full) historyRef.current.push({ role: "assistant", content: full });

    await ttsQueueRef.current; // 全文の読み上げが終わるまで待つ
    if (activeRef.current) setState("listening");
    else setState("idle");
    busyRef.current = false;
    lastInteractionRef.current = Date.now();
  }, [enqueueSpeak, startAssistantEntry, updateAssistantEntry]);

  // 沈黙が続いたときレム側から話題を振る
  // LLMは呼ばない: 応答待ちが発生すると沈黙がさらに伸びて逆効果な上、
  // 会話履歴の連続性が崩れてOllamaのプロンプトキャッシュが効かなくなり以降の応答も遅くなるため
  const nudge = useCallback(async () => {
    if (!activeRef.current || busyRef.current) return;
    busyRef.current = true;
    setState("thinking");
    const line = NUDGE_LINES[Math.floor(Math.random() * NUDGE_LINES.length)];
    historyRef.current.push({ role: "assistant", content: line });
    setReply(line);
    pushLog("assistant", line);
    await speakAivis(line);
    if (activeRef.current) setState("listening");
    else setState("idle");
    busyRef.current = false;
    lastInteractionRef.current = Date.now();
  }, [speakAivis, pushLog]);

  // ---- VAD ループ ----
  const startVadLoop = useCallback((analyser: AnalyserNode) => {
    const data = new Uint8Array(analyser.frequencyBinCount);

    function loop() {
      if (!activeRef.current) return;

      // レムが喋ってる/考え中の間はVADを止める（二重録音・ログ重複防止）
      if (speakingRef.current || busyRef.current) {
        vadRafRef.current = requestAnimationFrame(loop);
        return;
      }

      analyser.getByteFrequencyData(data);
      const avg = data.reduce((a, b) => a + b, 0) / data.length;
      const now = Date.now();

      if (avg > SPEECH_THRESHOLD) {
        // 音声検知
        lastSpeechRef.current = now;
        lastInteractionRef.current = now;
        if (!isSpeechRef.current) {
          isSpeechRef.current = true;
          speechStartRef.current = now;
          // 録音開始
          chunksRef.current = [];
          recorderRef.current?.start();
        }
      } else if (isSpeechRef.current && now - lastSpeechRef.current > SILENCE_DURATION_MS) {
        // 無音検知 → 録音停止 → STTへ
        isSpeechRef.current = false;
        const speechDuration = lastSpeechRef.current - speechStartRef.current;
        recorderRef.current?.stop();
        if (speechDuration < MIN_SPEECH_MS) {
          // 短すぎる発話は無視、すぐ再録音できる状態に戻す
          chunksRef.current = [];
        }
      } else if (
        !isSpeechRef.current &&
        !busyRef.current &&
        now - lastInteractionRef.current > IDLE_NUDGE_MS
      ) {
        // 沈黙が続いた → レムから話題を振る
        lastInteractionRef.current = now; // 連続発火防止
        nudge();
      }

      vadRafRef.current = requestAnimationFrame(loop);
    }
    loop();
  }, [speakingRef, nudge]);

  // ---- 会話モードON ----
  const startConversation = useCallback(async () => {
    if (activeRef.current) return;
    activeRef.current = true;
    lastInteractionRef.current = Date.now();
    setState("listening");

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    streamRef.current = stream;

    const audioCtx = new AudioContext();
    audioCtxRef.current = audioCtx;
    const source = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);

    const recorder = new MediaRecorder(stream);
    recorderRef.current = recorder;

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };
    recorder.onstop = async () => {
      if (!activeRef.current || chunksRef.current.length === 0) return;
      // STT問い合わせ中もVADを止める（二重録音防止。chat()に入るまでの空白を埋める）
      busyRef.current = true;
      const blob = new Blob(chunksRef.current, { type: "audio/webm" });
      chunksRef.current = [];
      const form = new FormData();
      form.append("file", blob, "audio.webm");
      form.append("model", GROQ_STT_MODEL);
      form.append("language", "ja");
      try {
        setState("thinking");
        let text = "";
        try {
          const res = await fetch(GROQ_STT_URL, { method: "POST", body: form });
          if (!res.ok) throw new Error(`groq stt ${res.status}`);
          text = (await res.json()).text ?? "";
        } catch {
          // Groqが失敗（ネット切断・障害等）→ ローカルSTTへフォールバック
          const localForm = new FormData();
          localForm.append("audio", blob, "audio.webm");
          const res2 = await fetch(LOCAL_STT_URL, { method: "POST", body: localForm });
          text = (await res2.json()).text ?? "";
        }
        if (text && activeRef.current) {
          setTranscript(text);
          pushLog("user", text);
          await chat(text);
          return;
        }
      } catch { /* STT失敗（ローカルも含め両方ダメだった） */ }
      busyRef.current = false;
      if (activeRef.current) setState("listening");
    };

    startVadLoop(analyser);
  }, [chat, startVadLoop, pushLog]);

  // ---- 会話モードOFF ----
  const stopConversation = useCallback(() => {
    activeRef.current = false;
    cancelAnimationFrame(vadRafRef.current);
    abortRef.current?.abort();
    recorderRef.current?.stop();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    audioCtxRef.current?.close();
    speechSynthesis.cancel();
    if (activeSourceRef.current) {
      try { activeSourceRef.current.stop(); } catch { /* already stopped */ }
      activeSourceRef.current.ctx.close().catch(() => {});
      activeSourceRef.current = null;
    }
    ttsQueueRef.current = Promise.resolve(); // 溜まっていた再生キューも破棄
    speakingRef.current = false;
    volumeRef.current = 0;
    isSpeechRef.current = false;
    busyRef.current = false;
    setState("idle");
  }, [speakingRef, volumeRef]);

  const resetHistory = useCallback(() => {
    historyRef.current = [];
    setTranscript("");
    setReply("");
    setLog([]);
  }, []);

  return { state, transcript, reply, log, startConversation, stopConversation, resetHistory };
}
