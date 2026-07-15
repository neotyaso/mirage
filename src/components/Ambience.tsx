import { useEffect } from "react";

/**
 * 展示ブースの環境音（小音量）。外部音源ファイルを持たず、WebAudioでノイズを合成する。
 * - 低くこもったノイズ = 室内の空気感
 * - ゆっくり揺れる帯域ノイズ = 窓の外のかすかな気配（そよ風のような強弱）
 *
 * AudioContextはユーザー操作(展示スタート)起点でないと鳴らせないため、active=trueで開始する。
 * うるさければ AMBIENCE_GAIN を下げる / 呼び出し側で active=false にすれば止まる。
 * レムの声（別AudioContext）とは独立。声を邪魔しないよう十分小さくしてある。
 */
const AMBIENCE_GAIN = 0.03; // 全体音量（0〜1）。小さめ。会場やマイク位置に応じて調整

export function Ambience({ active }: { active: boolean }) {
  useEffect(() => {
    if (!active) return;
    let ctx: AudioContext;
    try {
      ctx = new AudioContext();
    } catch {
      return;
    }
    ctx.resume().catch(() => {});
    const now = ctx.currentTime;

    // 3秒ぶんのブラウンノイズ（低音寄りで耳障りでない）をループ再生
    const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 3), ctx.sampleRate);
    const data = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < data.length; i++) {
      const white = Math.random() * 2 - 1;
      last = (last + 0.02 * white) / 1.02;
      data[i] = last * 3.2;
    }

    const master = ctx.createGain();
    master.gain.setValueAtTime(0, now);
    master.gain.linearRampToValueAtTime(AMBIENCE_GAIN, now + 3); // ふわっとフェードイン
    master.connect(ctx.destination);

    // 室内の空気感（低くこもったベッド）
    const src1 = ctx.createBufferSource();
    src1.buffer = buf; src1.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass"; lp.frequency.value = 380;
    const g1 = ctx.createGain(); g1.gain.value = 0.9;
    src1.connect(lp); lp.connect(g1); g1.connect(master);
    src1.start();

    // 窓の外のかすかな気配（帯域ノイズをゆっくり揺らす＝そよ風）
    const src2 = ctx.createBufferSource();
    src2.buffer = buf; src2.loop = true; src2.playbackRate.value = 1.3;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass"; bp.frequency.value = 1100; bp.Q.value = 0.8;
    const g2 = ctx.createGain(); g2.gain.value = 0.22;
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.08; // ゆっくりした強弱
    const lfoGain = ctx.createGain(); lfoGain.gain.value = 0.12;
    lfo.connect(lfoGain); lfoGain.connect(g2.gain);
    src2.connect(bp); bp.connect(g2); g2.connect(master);
    src2.start(); lfo.start();

    return () => {
      // プツッと切れないようフェードアウトしてから閉じる
      try {
        const t = ctx.currentTime;
        master.gain.cancelScheduledValues(t);
        master.gain.setValueAtTime(master.gain.value, t);
        master.gain.linearRampToValueAtTime(0, t + 0.4);
      } catch { /* noop */ }
      setTimeout(() => {
        try { src1.stop(); } catch { /* noop */ }
        try { src2.stop(); } catch { /* noop */ }
        try { lfo.stop(); } catch { /* noop */ }
        ctx.close().catch(() => {});
      }, 500);
    };
  }, [active]);

  return null;
}
