// 気づいた瞬間などに鳴らす、ごく短い効果音アクセント（外部音源なし・WebAudio合成）。
// Ambience（環境音のベッド）とは別物で、単発の「きらっ」を鳴らすためのもの。
// AudioContextはユーザー操作(展示スタート)起点で最初の音が鳴るまでに用意される想定。
// 使い回すため1つだけ生成し、以降は同じctxを再利用する（毎回newするとタブごとの上限に当たる）。
let ctx: AudioContext | null = null;

function getCtx(): AudioContext | null {
  try {
    ctx = ctx ?? new AudioContext();
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    return ctx;
  } catch {
    return null;
  }
}

/**
 * 来場者に気づいた瞬間の、控えめで可愛い2音の「きらっ」。
 * 声(レムのTTS)を邪魔しないよう小音量・短め。panで左右位置に軽く寄せられる。
 * @param gain 0〜1。既定は小さめ。会場の音量に応じて呼び出し側で調整
 * @param pan  -1(左)〜1(右)。来場者の画面上の位置に合わせると空間の実在感が出る
 */
export function playNoticeChime(gain = 0.05, pan = 0): void {
  const c = getCtx();
  if (!c) return;
  const now = c.currentTime;
  const master = c.createGain();
  master.gain.value = 1;
  const panner = c.createStereoPanner();
  panner.pan.value = Math.max(-1, Math.min(1, pan));
  master.connect(panner);
  panner.connect(c.destination);

  // 上がる2音（明るく気づいた感じ）。sineで柔らかく、短いエンベロープでチリッと
  const notes = [880, 1318.5]; // A5 → E6
  notes.forEach((freq, i) => {
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = "sine";
    o.frequency.value = freq;
    const t = now + i * 0.085;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.42);
    o.connect(g);
    g.connect(master);
    o.start(t);
    o.stop(t + 0.46);
  });
}
