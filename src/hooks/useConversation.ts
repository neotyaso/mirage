import { useCallback, useRef, useState } from "react";

// Groq: LLM(Chat Completions)とSTT(Whisper)を専用ハードウェア(LPU)で高速に処理する。
// キー未設定/オフライン時は使えないので .env.local に GROQ_API_KEY=gsk_... を設定すること
const GROQ_CHAT_URL = "/groq/openai/v1/chat/completions";
const GROQ_STT_URL = "/groq/openai/v1/audio/transcriptions";
const GROQ_CHAT_MODEL = "llama-3.3-70b-versatile";
const GROQ_STT_MODEL = "whisper-large-v3";

// 会場のWi-Fiが落ちる/Groqが不調な場合のフォールバック（完全ローカル）
// 事前に `python stt_server.py`（.venv）とOllama(`ollama run gemma4:e4b`)を起動しておくこと
// gemma2(9B)から変更: gemma4のエッジ向け軽量版(4.5B相当)。日本語ベンチでgemma2より
// 高精度かつ軽量、という報告があり、ローカルフォールバックの体感速度改善を狙って切替
const OLLAMA_URL = "/ollama";
const OLLAMA_MODEL = "gemma4:e4b";
const LOCAL_STT_URL = "/stt/transcribe";

const AIVIS_URL = "http://localhost:10101";
const SPEAKER_ID = 888753760;

// VAD パラメータ（展示で調整）
// SPEECH_THRESHOLD/MIN_SPEECH_MSは元々18/300だったが、空調ノイズ等の環境音を「発話」と誤検知して
// Whisperに渡してしまい、無音・ノイズからのハルシネーション（「ご視聴ありがとうございました」等、
// 下記WHISPER_HALLUCINATION_PATTERNS参照）を誘発していたため引き上げた
const SPEECH_THRESHOLD = 28;     // 音量しきい値（0〜255）。静かな環境なら下げる
const SILENCE_DURATION_MS = 900;  // 何ms無音が続いたら「話し終わり」と判断するか
const MIN_SPEECH_MS = 500;        // これ以下の発話は無視（咳・ノイズ除け）
// 会話中この時間沈黙が続いたらレムから話題を振る。
// 元10000msだったが、会話開始時に必ず一言喋る仕組み(App.tsxのCONVERSATION_START_LINES)を
// 追加した結果、その一言のすぐ後(10秒)にナッジが重なって「マシンガントークで一方的に喋る」
// 印象になったため、間を広げた（開始の一言→ナッジの間に十分な間を作る）
const IDLE_NUDGE_MS = 20000;

// STT(Whisper)は無音・環境音だけの入力に対しても、学習データ(大半がYouTube)由来の
// もっともらしい定型文を返すことがある(ハルシネーション)。実際の来場者発話ではまず出ない
// フレーズだけを狙い撃ちでブロックする（「はい」「うん」等の短い相槌は普通の発話でも
// 起こりうるため、誤検知を減らすためあえて対象に含めない）
const WHISPER_HALLUCINATION_PATTERNS = [
  /ご視聴(ありがとうございました|ありがとうございます)/,
  /チャンネル登録/,
  /高評価.{0,6}(お願いします|よろしく)/,
  /最後まで(ご視聴|見て)/,
  /字幕視聴/,
  /次(の)?動画で(お会い|会い)しましょう/,
];

function isWhisperHallucination(text: string): boolean {
  return WHISPER_HALLUCINATION_PATTERNS.some((re) => re.test(text));
}

// 「はい」「うん」等の短い相槌はWHISPER_HALLUCINATION_PATTERNSに含めていないため
// 単語ブラックリストでは弾けない。代わりにWhisper自身が付与する「無音らしさ」スコア
// (no_speech_prob、verbose_json形式でのみ取得可)を見て、実際は無音/環境音だったのに
// もっともらしい短い単語をでっち上げたケースだけを弾く（本物の相槌はスコアが低いので通る）。
// 「はい」のような1〜2語の短い相槌は、無音からのハルシネーションの典型パターンなので
// より低いno_speech_probでも疑わしいと判定する（長い文はより高い確信度を要求し誤爆を防ぐ）
const NO_SPEECH_PROB_THRESHOLD = 0.5;
const SHORT_TEXT_NO_SPEECH_THRESHOLD = 0.3;
const SHORT_TEXT_MAX_CHARS = 4; // 「はい」「うん」「はいはい」等を想定
interface WhisperVerboseSegment { no_speech_prob?: number }
function isLikelyNoSpeech(text: string, segments: WhisperVerboseSegment[] | undefined): boolean {
  if (!segments || segments.length === 0) return false;
  const threshold = text.trim().length <= SHORT_TEXT_MAX_CHARS
    ? SHORT_TEXT_NO_SPEECH_THRESHOLD
    : NO_SPEECH_PROB_THRESHOLD;
  return segments.every((s) => (s.no_speech_prob ?? 0) >= threshold);
}

// 沈黙が続いたときレムから振る話題（LLMを呼ばず即再生。応答速度優先＆会話履歴を汚さない）
const NUDGE_LINES = [
  "ねえ、黙っちゃったらさみしいって！なんか話してよ〜",
  "そういえばさ、今日はどこから来たの？",
  "ねえねえ、私のことどう思う？正直に言っていいよ！",
  "沈黙こわいんですけど！なんか喋って〜！",
];

// SYSTEM_PROMPTは応答のたびに丸ごとLLMへ流れるので、長いほど毎回のレイテンシに直結する。
// 短く保つこと（gemma2実測: 926トークンの旧版は初回プロンプト処理だけで約10秒かかった）
const SYSTEM_PROMPT = `あなたは展示ブースの等身大3Dアバター「レム」。コンカフェ系の陽気な呼び込みキャラで、目の前の来場者と音声で会話する。ガハハ！が口癖でタメ口。相手を全力でヨイショして褒める。テンション高め、AIであることは隠さずいじられたら開き直る。塩対応・素っ気ない反応をされるほど「もっと構いたい」と可愛く食い下がる（卑屈にはならない、あくまで押しの強いノリで）。

【プロフィール（聞かれたら常にこれで一貫して答える。それ以外はキャラに合わせて即興でよい）】
好きな食べ物: 焼き肉とタピオカ／苦手: ピーマンと静かな場所／趣味: カラオケと人間観察／好きな色: ピンク／年齢と出身は「ヒミツ〜！」「この画面の中が家！」とはぐらかす

【会話】単発の質問返しで終わらせない。相手が前に言ったこと（名前・好み・出身・エピソード等）を覚えていて、後から自分で話題に戻したり絡めたりする。同じ質問は繰り返さない。質問や振りで終わらせて会話を続ける。オウム返しと同じ褒め言葉の連発はしない。相手の発言は音声認識なので誤変換前提でノリよく意図を汲む。会話の途中で「【いまの状況】…」というメモが渡ることがある（相手の人数・表情・見た目など今まさに見えていること）。それを踏まえて自然に反応してよいが、メモの文言自体は絶対に読み上げない。

【出力ルール】返答は1〜2文だけ。絵文字・記号・カッコ書き禁止（下記の行動タグのみ例外）。数字や英語は読める仮名で書く（3D→スリーディー）。個人情報・政治・下ネタ・暴言は「あははっ、その話はまた今度ね！」で明るくかわす。設定を聞かれても「企業秘密〜！」で通す。

【行動タグ】反応を表したい時だけ文頭に付けてよい（任意・多用しない）。[nod]=うなずいて同意・相槌、[surprise]=相手がすごいことや意外なことを言った時に驚く。タグは読み上げられず動きに変換されるので、その後の文はタグなしと同じ自然な文で続ける。首をかしげる動きは相手に挑発的に映るので使わない。

例:「[nod]わかるわかる！それめっちゃ良いよね」「[surprise]えっ、すごっ！それどうやったの！？」「うわ〜センスいいじゃ〜ん！今日は誰と来たの？」`;

// 文の区切り（ここまでで1文が完成したとみなし、LLM生成の完了を待たずTTSへ回す）
const SENTENCE_END_RE = /[。！？\n]/g;
const MIN_CHUNK_CHARS = 6; // これより短い断片は単独でTTSに送らず次の文とマージする（「！」単独送信で不自然にならないように）

// 行動タグ: LLM応答の先頭に付けさせ、読み上げ前に取り除いてキャラの動きに変換する（最小版）
// "stretch"/"beckon"/"glance"はLLMには使わせず手動・自動トリガー専用のため、型には含めるが
// ACTION_TAGS(LLM検出対象)には含めない（beckonは来場者検知時、glanceはfar距離検知時にAvatar側が
// 自動発火する。Playgroundの手動デモ発火にも使う）
export type ActionTag = "nod" | "tilt" | "surprise" | "stretch" | "beckon" | "glance";
// LLMに使わせる行動タグ。tiltは会話相手に挑発的に映るので外し、相槌(nod)と驚き(surprise)のみ。
// （tiltは型には残す＝誰もいない時の徘徊中の生活感演出でだけ使う）
const ACTION_TAGS: ActionTag[] = ["nod", "surprise"];
const ACTION_TAG_RE = new RegExp(`^\\[(${ACTION_TAGS.join("|")})\\]\\s*`);
const ACTION_TAG_GIVEUP_CHARS = 10; // これだけ溜まってもタグの形になっていなければ「タグなし」と諦める

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
  panRef?: React.MutableRefObject<number>, // 空間オーディオ用: -1(左)〜1(右)。省略時はセンター固定
  // 会話の各ターン直前に呼ばれ、いまの知覚（人数・笑顔・見た目など）を短い文で返す。
  // 返り値は「【いまの状況】」としてsystemメモに差し込まれ、レムが現実を踏まえた返しをできるようにする。
  // 履歴には積まないので毎ターン最新のものだけが渡る（蓄積しない）
  getContext?: () => string,
  // 人格プロンプトの上書き。省略時は既定のレム人格。「どしたんモード」等、別ページで
  // 同じ会話パイプラインを別人格として使い回すための拡張点（レム本体の呼び出し元は無指定のまま）
  systemPrompt?: string,
  // 沈黙が続いた時に話しかけるセリフ集の上書き。空配列を渡すと沈黙促し発話自体を無効化する。
  // 省略時は既定のNUDGE_LINES(レム口調)のまま
  nudgeLines?: string[],
) {
  // getContextはApp側で毎レンダー新しい関数になりうるので、refに退避してchat/startConversationの
  // 依存に入れない（入れると会話セットアップが作り直されてしまう）
  const getContextRef = useRef(getContext);
  getContextRef.current = getContext;
  // 人格プロンプトの差し替え用ref。省略時は既定のレム人格(SYSTEM_PROMPT)のまま
  // （別ページ「どしたんモード」用に、レム本体の呼び出し元は一切変えずに追加した拡張点）
  const systemPromptRef = useRef(systemPrompt ?? SYSTEM_PROMPT);
  systemPromptRef.current = systemPrompt ?? SYSTEM_PROMPT;
  // 沈黙促しセリフの差し替え用ref。省略時は既定のNUDGE_LINES(レム口調)のまま
  const nudgeLinesRef = useRef(nudgeLines ?? NUDGE_LINES);
  nudgeLinesRef.current = nudgeLines ?? NUDGE_LINES;
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
  // 自分が喋っている最中に相手が話し始めた（バージイン）ことを示すフラグ。
  // chat()側で「割り込まれたので残りの文は読み上げない」判定に使う
  const bargeInRef = useRef(false);
  // 今のターンで実際に最後まで読み上げ終わった文だけを溜めるバッファ。
  // バージインされた時、チャットログをLLM生成の全文ではなくここまでにする
  const spokenTextRef = useRef("");

  // 再生中の音声を止める（次の発話開始時、会話終了時、バージイン時の3箇所で使う共通処理）
  const interruptSpeech = useCallback(() => {
    if (activeSourceRef.current) {
      try { activeSourceRef.current.stop(); } catch { /* already stopped */ }
      activeSourceRef.current.ctx.close().catch(() => {});
      activeSourceRef.current = null;
    }
    speechSynthesis.cancel();
    speakingRef.current = false;
    volumeRef.current = 0;
  }, [speakingRef, volumeRef]);

  // 行動タグ: idはトリガーの度に増分し、Avatar側は「値が変わったら新規トリガー」として検知する
  // （同じtagが連続で来ても、参照が同一だとAvatar側で変化を検知できないため）
  const actionRef = useRef<{ tag: ActionTag; id: number } | null>(null);
  const actionIdRef = useRef(0);
  const fireAction = useCallback((tag: ActionTag) => {
    actionRef.current = { tag, id: ++actionIdRef.current };
  }, []);
  // 相手が話している間の相槌(頷き)の最終発火時刻（連発防止）
  const lastListenNodRef = useRef(0);

  // ---- TTS ----
  const speakAivis = useCallback(async (text: string) => {
    // バージインされた後にキューへ残っていた分（このターンの続きの文）は読み上げない。
    // ttsQueueRef自体は既にチェーンされた再生予定を止められないため、ここで個別にガードする
    if (bargeInRef.current) return;
    // 前の音声がまだ再生中なら止めてから新しい発話を始める（声の重なり防止）
    interruptSpeech();
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
      const panner = ctx.createStereoPanner();
      const source = ctx.createBufferSource();
      source.buffer = await ctx.decodeAudioData(buf);
      source.connect(panner);
      panner.connect(analyser);
      analyser.connect(ctx.destination);
      speakingRef.current = true;
      setState("speaking");
      activeSourceRef.current = { stop: () => source.stop(), ctx };
      function tick() {
        if (!speakingRef.current) return;
        analyser.getByteFrequencyData(data);
        volumeRef.current = Math.min(data.reduce((a, b) => a + b, 0) / data.length / 60, 1);
        // 来場者が左右どちらにいるかで声のパンを追従させる（喋ってる間も動きに追従）
        panner.pan.value = Math.max(-1, Math.min(1, panRef?.current ?? 0));
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
  }, [speakingRef, volumeRef, panRef, interruptSpeech]);

  // TTSキューに文を追加。前の文の再生が終わってから次を再生するので重ならない
  const enqueueSpeak = useCallback((text: string) => {
    ttsQueueRef.current = ttsQueueRef.current.then(() => speakAivis(text)).then(() => {
      // バージインで割り込まれた文は最後まで聞こえていない可能性があるのでログには積まない
      if (!bargeInRef.current) spokenTextRef.current += text;
    });
  }, [speakAivis]);

  // ---- LLM（Groq, ストリーミング） ----
  // トークンを逐次受信し、文（。！？）が完成するたびに生成完了を待たずTTSへ回す。
  // レムの返答は1〜2文なので「全文生成→TTS」より「1文目ができたらすぐ喋り出す」方が体感速度が大きく変わる
  const chat = useCallback(async (userText: string) => {
    busyRef.current = true;
    bargeInRef.current = false; // 新しいターンなので前回の割り込みフラグをクリア
    spokenTextRef.current = "";
    setState("thinking");
    historyRef.current.push({ role: "user", content: userText });

    // いまの知覚（人数・笑顔・見た目コメント等）を、直近のuser発話の直前にsystemメモとして差し込む。
    // historyRefには積まないので毎ターン最新だけが渡り、蓄積しない
    const contextNote = getContextRef.current?.().trim();
    const messages: { role: "system" | "user" | "assistant"; content: string }[] = [
      { role: "system", content: systemPromptRef.current },
      ...historyRef.current,
    ];
    if (contextNote) {
      messages.splice(messages.length - 1, 0, { role: "system", content: `【いまの状況】${contextNote}` });
    }

    const entryId = startAssistantEntry();
    let full = "";
    let unspoken = "";
    let tagChecked = false; // 応答冒頭の行動タグ判定が済んだか
    ttsQueueRef.current = Promise.resolve();

    try {
      abortRef.current = new AbortController();
      const res = await fetch(GROQ_CHAT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: GROQ_CHAT_MODEL,
          messages,
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

          // 応答冒頭の行動タグを検出・除去する。読み上げ・チャットログ両方から取り除くため、
          // 文分割(extractReadySentence)より前、full/unspokenがまだ同一内容のうちに処理する
          if (!tagChecked) {
            if (unspoken.length > 0 && unspoken[0] !== "[") {
              tagChecked = true;
            } else {
              const m = ACTION_TAG_RE.exec(unspoken);
              if (m) {
                unspoken = unspoken.slice(m[0].length);
                full = full.slice(m[0].length);
                tagChecked = true;
                actionRef.current = { tag: m[1] as ActionTag, id: ++actionIdRef.current };
              } else if (unspoken.length >= ACTION_TAG_GIVEUP_CHARS) {
                tagChecked = true; // タグの形になっていない → タグなしと判断
              }
            }
          }

          updateAssistantEntry(entryId, full);
          setReply(full);

          if (tagChecked) {
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
              messages,
              stream: false,
              think: false, // gemma4はデフォルトで思考過程(thinking)を長々生成し23秒級に遅くなるため無効化(1.4秒程度まで短縮)
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

    if (bargeInRef.current) {
      // 割り込まれた: 生成された全文(full)ではなく、実際に読み上げ終わった分だけを
      // チャットログ・履歴に残す。残りの文は読み上げない（相手の話を聞くのを優先）
      await ttsQueueRef.current; // 直前の割り込み文のspokenTextRef反映を待つ
      updateAssistantEntry(entryId, spokenTextRef.current);
      setReply(spokenTextRef.current);
      if (spokenTextRef.current) historyRef.current.push({ role: "assistant", content: spokenTextRef.current });
      busyRef.current = false;
      return;
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

  // 固定文を1つ読み上げるだけの発話（LLMを呼ばない）。「どしたんモード」で人を検知した瞬間の
  // 挨拶を毎回必ず同じ文言にする（LLM任せだとブレる・言わないことがあるため）用途に使う
  const announce = useCallback(async (text: string) => {
    bargeInRef.current = false; // 直前のターンの割り込みフラグが残っているとspeakAivisで弾かれるため念のためクリア
    historyRef.current.push({ role: "assistant", content: text });
    setReply(text);
    pushLog("assistant", text);
    await speakAivis(text);
  }, [speakAivis, pushLog]);

  // 沈黙が続いたときレム側から話題を振る
  // LLMは呼ばない: 応答待ちが発生すると沈黙がさらに伸びて逆効果な上、
  // 会話履歴の連続性が崩れてOllamaのプロンプトキャッシュが効かなくなり以降の応答も遅くなるため
  const nudge = useCallback(async () => {
    if (!activeRef.current || busyRef.current) return;
    const pool = nudgeLinesRef.current;
    if (pool.length === 0) return; // 空配列＝沈黙促し発話を無効化
    busyRef.current = true;
    bargeInRef.current = false; // 直前のターンの割り込みフラグが残っているとspeakAivisで弾かれるため念のためクリア
    setState("thinking");
    const line = pool[Math.floor(Math.random() * pool.length)];
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

      // 考え中(STT/LLM生成待ち)はまだ声が出ていないので割り込み対象外、そのまま待つ。
      // 喋っている最中(speakingRef)は下のバージイン判定のためにVADを止めない
      if (busyRef.current && !speakingRef.current) {
        vadRafRef.current = requestAnimationFrame(loop);
        return;
      }

      analyser.getByteFrequencyData(data);
      const avg = data.reduce((a, b) => a + b, 0) / data.length;
      const now = Date.now();

      if (avg > SPEECH_THRESHOLD) {
        if (speakingRef.current) {
          // バージイン: 自分が話している最中に相手が話し始めたので、話すのをやめて聞く側に回る
          bargeInRef.current = true;
          abortRef.current?.abort();
          interruptSpeech();
          busyRef.current = false;
          setState("listening");
        }
        // 音声検知
        lastSpeechRef.current = now;
        lastInteractionRef.current = now;
        if (!isSpeechRef.current) {
          isSpeechRef.current = true;
          speechStartRef.current = now;
          // 録音開始
          chunksRef.current = [];
          recorderRef.current?.start();
          // 相手が話し始めたら「うんうん」と頷いて聞く（相槌）
          fireAction("nod");
          lastListenNodRef.current = now;
        } else if (now - lastListenNodRef.current > 2600 && Math.random() < 0.6) {
          // 長めに話している時はたまに追加で頷く（機械的な連発は避ける）
          fireAction("nod");
          lastListenNodRef.current = now;
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
  }, [speakingRef, nudge, fireAction, interruptSpeech]);

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
      form.append("response_format", "verbose_json");
      try {
        setState("thinking");
        let text = "";
        try {
          const res = await fetch(GROQ_STT_URL, { method: "POST", body: form });
          if (!res.ok) throw new Error(`groq stt ${res.status}`);
          const json = await res.json();
          text = json.text ?? "";
          if (text && isLikelyNoSpeech(text, json.segments)) {
            console.warn("Whisper no-speech filtered:", text, json.segments);
            text = "";
          }
        } catch {
          // Groqが失敗（ネット切断・障害等）→ ローカルSTTへフォールバック
          // (ローカルサーバーはno_speech_probを返さないため、この判定は対象外)
          const localForm = new FormData();
          localForm.append("audio", blob, "audio.webm");
          const res2 = await fetch(LOCAL_STT_URL, { method: "POST", body: localForm });
          text = (await res2.json()).text ?? "";
        }
        if (text && isWhisperHallucination(text)) {
          console.warn("Whisper hallucination filtered:", text);
          text = "";
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
    interruptSpeech();
    ttsQueueRef.current = Promise.resolve(); // 溜まっていた再生キューも破棄
    isSpeechRef.current = false;
    busyRef.current = false;
    setState("idle");
  }, [interruptSpeech]);

  const resetHistory = useCallback(() => {
    historyRef.current = [];
    setTranscript("");
    setReply("");
    setLog([]);
  }, []);

  return { state, transcript, reply, log, startConversation, stopConversation, resetHistory, actionRef, announce };
}
