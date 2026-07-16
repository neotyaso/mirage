// 「私、あなたが見えてるよ」演出: webカメラの1フレームをGroqのvisionモデルに投げ、
// 来場者の見た目に対する気の利いた一言を生成する。
//
// プライバシー: 画像はメモリ上で縮小してGroqに送るだけで、保存も再送もしない。
// 送るのは小さいJPEG1枚のみ。実会場で使うならブース内にカメラ利用の掲示をするのが望ましい。
//
// キーは vite.config.ts の /groq プロキシがサーバー側で付与するのでここには出てこない。
// GROQ_CHAT_URL は useConversation.ts と同じエンドポイント（OpenAI互換 chat/completions）。
const GROQ_CHAT_URL = "/groq/openai/v1/chat/completions";
// マルチモーダル対応モデル（Groq。画像入力可・128Kコンテキスト。プレビュー扱い）
const GROQ_VISION_MODEL = "meta-llama/llama-4-scout-17b-16e-instruct";

// コメントできる要素が無い/人がちゃんと写っていない時にモデルに返させる合図。
// これが返ったら「言わない」（外した薄いコメントを無理に喋らせない＝確信度ガード）
const SKIP_TOKEN = "SKIP";

// カメラ映像の現在フレームを小さいJPEGのデータURLにする。
// 小さめ(既定240px)なのは送受信を軽くするためとプライバシー配慮の両方。
// videoがまだ再生準備前(readyState<2)やサイズ0なら撮れないのでnull。
function captureFrame(video: HTMLVideoElement, maxW = 240): string | null {
  if (!video || video.readyState < 2 || video.videoWidth === 0) return null;
  const scale = Math.min(1, maxW / video.videoWidth);
  const w = Math.round(video.videoWidth * scale);
  const h = Math.round(video.videoHeight * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(video, 0, 0, w, h);
  return canvas.toDataURL("image/jpeg", 0.7);
}

const VISION_PROMPT = `あなたは展示ブースの陽気な呼び込みキャラ「レム」。目の前の来場者のカメラ画像を見て、その人の見た目の"いいところ"を見つけて一言だけ褒めて。服の色や柄・小物・髪型・持ち物・全体の雰囲気など、具体的なポイントを挙げて明るく褒める（イジったり欠点に触れたりは絶対にしない、褒めるだけ）。制約: タメ口でテンション高め・1文・15〜25文字・絵文字や記号や番号は付けない・セリフ本文だけ返す。人物がはっきり写っていない、または褒められる要素が全く見つからない場合のみ「${SKIP_TOKEN}」とだけ返す。`;

/**
 * 来場者のカメラフレームから見た目コメントを1つ生成する。
 * コメントできない/失敗/確信度低い(SKIP)場合は null（呼び出し側は何も喋らせない）。
 */
export async function generateVisionComment(video: HTMLVideoElement | null): Promise<string | null> {
  if (!video) return null;
  const dataUrl = captureFrame(video);
  if (!dataUrl) return null;
  try {
    const res = await fetch(GROQ_CHAT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: GROQ_VISION_MODEL,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: VISION_PROMPT },
              { type: "image_url", image_url: { url: dataUrl } },
            ],
          },
        ],
        stream: false,
        temperature: 0.9,
        max_tokens: 60,
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    let text: string = (data.choices?.[0]?.message?.content ?? "").trim();
    // 前後の引用符・絵文字を落とす
    text = text.replace(/^["'「『]|["'」』]$/g, "").trim();
    text = text.replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, "").trim();
    // SKIP・空・長すぎ(指示無視)は棄却
    if (!text || new RegExp(SKIP_TOKEN, "i").test(text) || text.length > 40) return null;
    return text;
  } catch {
    return null;
  }
}
