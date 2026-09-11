// 通行人トラッキング＋呼び込みイベントログの型定義。
//
// 座標系は useFaceDetection の FaceCenter と同一の正規化座標を使う:
//   x: 0〜1（左→右）、y: 0〜1（上→下）、size: 顔の正規化幅（faceSizeRef と同一）
// 将来の俯瞰可視化・声かけポリシー・呼び込み効果測定はこの型の上に乗る。

/** 1フレーム分の位置サンプル。t は呼び出し側の時刻基準（performance.now() 等）の ms。 */
export interface PositionSample {
  t: number;
  x: number;
  y: number;
  size: number;
}

/** 速度の推定値（正規化座標/秒）。+vx = 画面右方向、+vy = 画面下方向。 */
export interface Velocity {
  vx: number;
  vy: number;
}

/**
 * 距離ゾーン。useFaceDetection の DistanceZone と一致させること
 * （"far" | "mid" | "near" | "absent"）。
 */
export type VisitorZone = "far" | "mid" | "near" | "absent";

/** ゾーン遷移の履歴サンプル。変化時のみ追記される。 */
export interface ZoneSample {
  t: number;
  zone: VisitorZone;
}

/** 通行人1人分の追跡レコード。 */
export interface Visitor {
  /** トラッカー内で採番した安定 id（例: "v1"）。フレームをまたいで同一人物に付与される。 */
  id: string;
  firstSeenMs: number;
  lastSeenMs: number;
  /** 軌道（時系列の位置サンプル）。 */
  positions: PositionSample[];
  /** 直近ウィンドウから推定した速度。 */
  velocity: Velocity;
  /** ゾーン遷移の履歴。 */
  zones: ZoneSample[];
}

/** 呼び込みイベント種別。 */
export type TrackEventType =
  | "callout"
  | "conversation_start"
  | "conversation_end"
  | "stop"
  | "leave";

/**
 * 時系列ログの1イベント。
 * visitorId が null の場合は来場者に紐づかない全体イベント（"stop" 等）。
 * variant は呼び込みABテスト用の実験条件ラベル（例: "A" / "B"）。
 */
export interface TrackEvent {
  type: TrackEventType;
  visitorId: string | null;
  /** イベント時刻（append 側の時刻基準の ms）。 */
  t: number;
  /** 種別ごとの付随データ（例: callout の zone / text、leave の滞在時間等）。 */
  data?: Record<string, unknown>;
  variant?: string | null;
}

/**
 * トラッカーへの1フレーム分の入力。
 * useFaceDetection の allFaceCentersRef（FaceCenter[]）＋各顔の正規化幅に対応する。
 * 順序は不定でよい（MediaPipe はフレームごとに並び順が変わりうるため、順序に依存しないこと）。
 */
export interface FaceObservation {
  x: number;
  y: number;
  size: number;
}
