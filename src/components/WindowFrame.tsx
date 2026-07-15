import type { CSSProperties } from "react";

/**
 * 画面を「窓（ポータル）」に見せるためのフレーム枠オーバーレイ。
 *
 * ねらい: off-axisカメラ(App.tsxのOffAxisCamera)で奥の3D世界だけが来場者の動きに合わせて動き、
 * この枠は画面に固定されたまま → 枠と奥の世界のあいだに視差が生まれ「窓の向こうを覗いている」
 * 錯覚が強まる。ノートPCの平面ディスプレイでも「ただの画面」から「別世界を覗く窓」に化ける。
 *
 * 設計上の制約:
 * - pointer-events:none で下のCanvas/UI操作を一切邪魔しない
 * - 中央に桟(バー)は置かない。キャラを遮らないよう枠は四辺だけ
 * - 画像アセットは使わず全てCSSで描画（room.glbのような容量増を避ける）
 */

// 枠(モールディング)の太さ。画面サイズに追従(vmin)しつつ上下限を設ける
const CASING = "clamp(30px, 4.8vmin, 58px)";

export function WindowFrame() {
  return (
    <div style={wrapStyle} aria-hidden>
      {/* 開口部の奥まり影: 枠の厚みが落とす影を擬似的に描き、奥の世界を「引っ込んで」見せる */}
      <div style={recessStyle} />
      {/* 枠本体: 白木のモールディング風。斜めグラデで面取り(左上が明・右下が暗)を擬似表現 */}
      <div style={casingStyle} />
      {/* 見切り(rebate): 枠と“ガラス面”の境目の細い陰影。枠に厚みがある印象を足す */}
      <div style={lipStyle} />
    </div>
  );
}

const wrapStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 5,
  pointerEvents: "none",
};

const recessStyle: CSSProperties = {
  position: "absolute",
  inset: CASING,
  // 四辺の内側を落として奥行きを出す。エッジ近くに濃い影を寄せ「枠の厚みで奥が引っ込む」印象に
  // （全体を一様に暗くするとInstagramフィルタ風になるので、影は縁に密集させる）
  boxShadow:
    "inset 0 0 42px 6px rgba(35,26,16,0.55), inset 0 0 10px 1px rgba(0,0,0,0.5)",
  borderRadius: 3,
};

const casingStyle: CSSProperties = {
  position: "absolute",
  inset: 0,
  border: `${CASING} solid transparent`,
  // 面取りモールディング風の斜めグラデ（左上=光, 右下=陰）。コントラストを上げて立体感を出す
  borderImage:
    "linear-gradient(135deg, #fffdf7 0%, #ece2d0 34%, #c3b498 58%, #f3ecdd 100%) 1",
  // 枠が壁の上に乗って落とす外側の影＋枠自体の面のトーン
  boxShadow: "0 0 26px 5px rgba(55,40,25,0.32)",
};

const lipStyle: CSSProperties = {
  position: "absolute",
  inset: CASING,
  border: "3px solid rgba(95,74,48,0.32)",
  boxShadow: "inset 0 1px 3px rgba(255,255,255,0.55)",
  borderRadius: 3,
};
