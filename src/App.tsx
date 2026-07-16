import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { ContactShadows } from "@react-three/drei";
import { Avatar } from "./components/Avatar";
import { Room } from "./components/Room";
import { WindowFrame } from "./components/WindowFrame";
import { Ambience } from "./components/Ambience";
import { playNoticeChime } from "./audio/accent";
import { generateVisionComment } from "./vision/visionComment";
import { useFaceDetection, getDistanceZone } from "./hooks/useFaceDetection";
import type { FaceCenter, DistanceZone } from "./hooks/useFaceDetection";
import { useConversation } from "./hooks/useConversation";
import type { MutableRefObject } from "react";

// Off-axis カメラ: 来場者の顔位置でカメラが動き「3Dの窓」効果を生む
const CAM_BASE: [number, number, number] = [0, 1.1, 3];
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
    camera.lookAt(0, 1.1, 0);
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

// 会話モードが始まった瞬間に必ず言う一言。会話開始後はレムは黙って聞く設計なので、
// これが無いと来場者から「近づいたのに何も起きない」ように見えてしまう
const CONVERSATION_START_LINES = [
  "うんうん、何か話してよ！",
  "よし、聞く準備できたよ！",
  "さあさあ、何でも聞かせて！",
];

// 離脱時の別れの一言（実際に会話してた場合のみ発話。呼び込みだけで素通りされた時は言わない）
const FAREWELL_LINES = [
  "またね〜！話せて楽しかった！",
  "ありがとうね！気をつけて帰ってね！",
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

  // 顔検知は会話コンテキストより先に用意する（getConversationContextが下のrefを読むため）
  const { videoRef, presentRef, faceCountRef, faceCenterRef, faceSizeRef, faceYawRef, allFaceCentersRef, expressionRef, ready: camReady, error: camError } =
    useFaceDetection();

  // 直近の視覚コメント（見た目の一言）。会話LLMに「見た目」を文脈として渡し、会話の中で
  // 自然に触れさせるために保持する。来場者が離脱したらクリアして次の人に持ち越さない
  const lastVisionCommentRef = useRef("");

  // 会話の各ターン直前に呼ばれ、いまの知覚を短い文にする（人数・笑顔・見た目）。
  // レムが「二人で来たんだね」「お、笑ってくれた」等、現実を踏まえた返しをできるようにする。
  // refだけ読むので依存は空でよい
  const getConversationContext = useCallback(() => {
    const parts: string[] = [];
    const n = faceCountRef.current;
    if (n >= 2) parts.push(`来場者は${n}人で一緒に来ている`);
    if ((expressionRef.current?.smile ?? 0) >= 0.3) parts.push("相手は今えがお");
    const vc = lastVisionCommentRef.current;
    if (vc) parts.push(`あなたは相手の見た目を見て既に「${vc}」と声をかけた。同じ言葉は繰り返さず、必要なら会話の流れの中で自然にその見た目の話題に触れてよい`);
    return parts.join("。");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { state: convState, log, startConversation, stopConversation, resetHistory, actionRef, getCallout, refillCallouts } = useConversation(speakingRef, volumeRef, panRef, getConversationContext);

  // 行動タグ(頷く/首かしげる/手招き)をApp側からも発火する共通ヘルパー。
  // idは負のタイムスタンプにして、useConversation内部のLLMタグ検出が使う正の連番と衝突させない
  // （Avatarは値の変化=idの差でしか新規トリガーを判定しないので、正負が混ざっても問題ない）
  function fireAction(tag: "nod" | "tilt" | "beckon") {
    actionRef.current = { tag, id: -Date.now() };
  }
  const logEndRef = useRef<HTMLDivElement>(null);

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

  // speak()はAivisSpeechへのfetch(audio_query→synthesis)完了を待ってから再生を始めるため、
  // 呼び込みの直後に見た目コメントのspeak()が続けて呼ばれると、両方とも「再生中フラグが立つ前」の
  // 状態で「前の音声を止める」チェックを通過してしまい、fetchが終わった順に両方が再生されて
  // 音が重なるバグがあった。世代カウンタ(speakGenRef)で「一番最後に呼ばれたspeak()だけが実際に
  // 再生される」ことを保証する（fetch中に新しいspeak()が来たら、古い方はfetch完了後に自分で気づいて
  // 再生をやめる）
  const speakGenRef = useRef(0);
  async function speak(text: string) {
    const myGen = ++speakGenRef.current;

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
      // fetch待ちの間により新しいspeak()呼び出しがあった場合、自分は喋らずに引き下がる
      if (myGen !== speakGenRef.current) return;

      const ctx = new AudioContext();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      const data = new Uint8Array(analyser.frequencyBinCount);

      const source = ctx.createBufferSource();
      source.buffer = await ctx.decodeAudioData(arrayBuffer);

      // decodeAudioData中にも新しい呼び出しが来ている可能性があるため直前でも再確認
      if (myGen !== speakGenRef.current) {
        ctx.close().catch(() => {});
        return;
      }

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
      if (myGen !== speakGenRef.current) return;
      console.warn("AivisSpeech unavailable, using Web Speech fallback");
      speakFallback(text);
    }
  }

  // speakingRef.current が false になる（今の発話が終わる）まで待つ。呼び込みの直後に見た目コメントを
  // 続けて喋らせたい時、その場の一発チェックだと「呼び込みがまだ再生中」なら丸ごと諦めてしまう
  // （speak()側の世代カウンタが「後勝ち」なのは重なり防止のためであって、待たせる仕組みではないため）。
  // ここで実際に呼び込みの再生完了を待ってから次の発話を投げることで、二段構えが確実に成立する。
  // maxMsは万一喋り終わらない/検知できない場合の保険の上限
  function waitUntilNotSpeaking(maxMs: number): Promise<void> {
    return new Promise((resolve) => {
      const start = performance.now();
      function poll() {
        if (!speakingRef.current || performance.now() - start > maxMs) {
          resolve();
          return;
        }
        setTimeout(poll, 150);
      }
      poll();
    });
  }

  function callOut(z: Exclude<DistanceZone, "absent">) {
    const isGroup = faceCountRef.current >= 2;
    // 1人相手なら、事前生成しておいたLLMの第一声を優先（毎回違う言い回しで「生きてる」感を出す）。
    // プールが空/枯渇していれば固定文にフォールバック。複数人相手は専用の固定文を使う
    if (!isGroup) {
      const llm = getCallout();
      if (llm) { speak(llm); return; }
    }
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
  // 視覚コメント（「私、見えてるよ」）: 生成は非同期(約1〜2秒)。結果が返る頃には
  // interval側のconvState(クロージャ値)が古いので、最新をrefで参照して差し込み可否を判定する
  const convStateRef = useRef(convState);
  useEffect(() => { convStateRef.current = convState; }, [convState]);
  const visionBusyRef = useRef(false);
  const lastVisionAtRef = useRef(0);
  const VISION_COOLDOWN_MS = 25000; // 同じ人・立て続けの連発を防ぐ
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
              // 新規来場の瞬間だけ、気づきの軽い効果音アクセントを声の直前に鳴らす
              // （来場者の左右位置=panRefに寄せて空間の実在感を出す）
              if (isNewArrival) playNoticeChime(0.05, panRef.current);
              callOut(z);
              lastCall.current = now;

              // 「私、見えてるよ」演出: 新規来場かつ顔がある程度大きく写る(mid/near)時に、
              // 裏でカメラ1フレームをvision-LLMに投げて見た目の一言を生成する。生成は約1〜2秒
              // かかるので、まず上の呼び込み(即時)で気を引き、少し遅れて具体コメントが刺さる二段構え。
              // 結果が返った時点でまだ在席中・レムが喋ってない・会話が始まってなければ差し込む
              if (
                isNewArrival && (z === "mid" || z === "near") &&
                videoRef.current && !visionBusyRef.current &&
                now - lastVisionAtRef.current > VISION_COOLDOWN_MS
              ) {
                visionBusyRef.current = true;
                lastVisionAtRef.current = now;
                generateVisionComment(videoRef.current).then(async (comment) => {
                  visionBusyRef.current = false;
                  if (!comment) return;
                  // 会話LLMが後の会話ターンで見た目に触れられるよう、喋る/喋らないに関わらず保持する
                  lastVisionCommentRef.current = comment;
                  // 呼び込みがまだ再生中なら、喋り終わるまで待ってから続ける（二段構えを確実に成立させる。
                  // 待たずにその場でspeakingRef.currentを見るだけだと、呼び込みがまだ鳴っている間は
                  // 毎回諦めて無言になってしまう）
                  await waitUntilNotSpeaking(8000);
                  // まだ在席・会話未開始なら、つかみとして声に出す（会話が始まっていれば
                  // 割り込まず、代わりに上のlastVisionCommentRef経由で会話の中に自然に混ぜる）
                  if (!paused && presentRef.current && convStateRef.current === "idle") {
                    speak(comment);
                    lastCall.current = performance.now();
                  }
                });
              }
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
          // 会話モードは開始しても来場者が話すまでレムは黙って聞くだけの設計だが、それだと
          // 「近づいたのに何も起きない＝壊れてる？」と感じられてしまう。会話開始の瞬間は必ず
          // 一言喋って「聞く態勢に入った」ことを分かりやすくする（呼び込みの通常クールダウンとは別枠）
          speak(CONVERSATION_START_LINES[Math.floor(Math.random() * CONVERSATION_START_LINES.length)]);
          startConversation();
        }
        if (convState !== "idle" && performance.now() - lastPresentAtRef.current > AWAY_TIMEOUT_MS) {
          // 実際にやり取りがあった（ログが残っている）場合だけ別れの一言を挟む。
          // 呼び込みだけで素通りされた時にまで「またね」と言うと不自然なので
          if (hasLogRef.current) {
            speak(FAREWELL_LINES[Math.floor(Math.random() * FAREWELL_LINES.length)]);
            // 名残惜しそうに手を振って見送る。stopConversation後はconversingが切れるので、
            // beckon再生中(約2.5秒)はAvatarが正面を向いて固まる＝手を振りながらの見送りになる
            fireAction("beckon");
          }
          stopConversation();
          resetHistory();
          lastVisionCommentRef.current = ""; // 見た目メモは次の来場者に持ち越さない
          silentResumeRef.current = true;
        }
      }
    }, 150);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [started, paused, convState]);

  function handleStart() {
    setStarted(true);
    refillCallouts(); // 呼び込みLLM文プールを裏で温めておく（最初の何回かは固定文、以降LLM文に）
    callOut("mid"); // 音声解放を兼ねた初回発話
    lastCall.current = performance.now();
    // 展示用: ブラウザのタブ・ブックマーク・URLバーを隠して「窓の中の別世界」への没入感を上げる。
    // 全画面APIはユーザー操作(このボタン押下)を起点にしないと拒否されるため、ここで呼ぶ
    document.documentElement.requestFullscreen?.().catch(() => {});
  }

  // 会話中の相槌は「相手が話し始めたら頷く」形で useConversation の VAD 側から発火する。
  // 首をかしげる動きは相手に挑発的に映るため、会話中には使わない（以前の考え中→首かしげは撤去）。

  return (
    <div style={{ position: "fixed", inset: 0 }}>
      <Canvas camera={{ position: CAM_BASE, fov: 35 }}>
        {/* 明るいナチュラルは維持しつつ、背景・光を少しだけ暖色寄りに（落ち着いた昼下がりの居室感） */}
        <color attach="background" args={["#f2e8d4"]} />
        <fog attach="fog" args={["#f2e8d4", 4, 9]} />

        <ambientLight intensity={0.9} color="#fff3e2" />
        <directionalLight position={[2, 4, 3]} intensity={1.4} color="#ffedc8" />
        <directionalLight position={[-3, 2, -2]} intensity={0.42} color="#ffe0b6" />

        <OffAxisCamera faceCenterRef={faceCenterRef} />

        <Suspense fallback={null}>
          <Room />
          <Avatar speakingRef={speakingRef} volumeRef={volumeRef} faceCenterRef={faceCenterRef} allFaceCentersRef={allFaceCentersRef} expressionRef={expressionRef} faceSizeRef={faceSizeRef} actionRef={actionRef} paused={paused} conversing={convState !== "idle"} />
          {/* 足元の接地影。「本当にそこに立っている」感を出す（暖色寄りのやわらかい影） */}
          <ContactShadows position={[0, 0.01, 0]} scale={5} far={2.2} blur={2.6} opacity={0.42} color="#4a3d2c" resolution={512} />
        </Suspense>
      </Canvas>

      {/* 画面を「窓」に見せる枠オーバーレイ（off-axisカメラの視差で覗き込み感を強める）。
          デバッグ中はHUD/ボタンを隠さないよう非表示 */}
      {!debugMode && <WindowFrame />}

      {/* 環境音（小音量）。稼働中のみ。展示スタートのクリックが音声解放を兼ねる */}
      <Ambience active={started && !paused} />

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
                // 呼び込み/驚き等のセリフ(speak())がAivisSpeechで再生中の場合、
                // stopConversation()はuseConversation側の音声しか止めないため、
                // App.tsx自前のactiveSourceRefも明示的に止める必要がある
                if (activeSourceRef.current) {
                  try { activeSourceRef.current.stop(); } catch { /* already stopped */ }
                  activeSourceRef.current.ctx.close().catch(() => {});
                  activeSourceRef.current = null;
                }
                speakingRef.current = false;
                volumeRef.current = 0;
                if (convState !== "idle") stopConversation();
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
          {present ? "YES" : "no"} | 顔: {faces} | zone: {zone} | conv: {convState} | {!started ? "停止中" : paused ? "一時停止中" : "稼働中"}
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
