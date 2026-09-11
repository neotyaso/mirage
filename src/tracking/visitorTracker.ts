// フレームワーク非依存の通行人トラッカー。
// useFaceDetection は読み取り専用で参照するだけにし、ここには React / MediaPipe を持ち込まない。
//
// 使い方（App統合担当向け）:
//   const tracker = createVisitorTracker(); // 閾値は useFaceDetection の ZONE_THRESHOLDS と合わせること
//   // 150ms間隔などのポーリングで:
//   const faces = allFaceCentersRef.current.map((c, i) => ({ ...c, size: <i番目の顔幅> }));
//   const { active, left } = tracker.update(faces, performance.now());
//   // left に入った Visitor ごとに eventLog.append("leave", v.id, {...}) を呼ぶ。
//
// 注意:
// - MediaPipe の faceLandmarks 配列はフレームごとに並び順が変わりうるため、
//   インデックスではなく「前フレーム位置との距離」で同一人物を照合する
//   （useFaceDetection の primaryCenter と同じ考え方）。
// - 座標は正規化座標（FaceCenter と同一）。時刻は呼び出し側の基準（performance.now()）で統一すること。

import type { FaceObservation, PositionSample, Visitor, VisitorZone, ZoneSample } from "./types.js";

export interface VisitorTrackerOptions {
  /** この距離（正規化座標のユークリッド距離）以内の最近傍を同一人物とみなす。既定 0.15。 */
  matchDistance?: number;
  /** この ms だけ未観測が続いたら leave 判定。既定 4000。 */
  leaveAfterMs?: number;
  /** Visitor.positions の保持上限（古いものから捨てる）。既定 120。 */
  maxPositions?: number;
  /** 速度推定に使う直近ウィンドウ。既定 500ms。 */
  velocityWindowMs?: number;
  /**
   * size→zone 変換の閾値。既定は useFaceDetection の ZONE_THRESHOLDS 初期値
   *（far: 0.12, mid: 0.25）と同じ。HUDキー操作で閾値を動かした場合は
   * その最新値を渡すこと（さもないとログ上の zone が画面表示とずれる）。
   */
  zoneFar?: number;
  zoneMid?: number;
}

export interface TrackerUpdate {
  /** 現在追跡中（leave 判定前）の全 Visitor。 */
  active: Visitor[];
  /** 今回の update で leave 判定された Visitor（呼び出しごとに新規分のみ）。 */
  left: Visitor[];
}

export interface VisitorTracker {
  update(faces: FaceObservation[], nowMs: number): TrackerUpdate;
  getActive(): Visitor[];
  reset(): void;
}

const DEFAULT_MATCH_DISTANCE = 0.15;
const DEFAULT_LEAVE_AFTER_MS = 4000;
const DEFAULT_MAX_POSITIONS = 120;
const DEFAULT_VELOCITY_WINDOW_MS = 500;
// useFaceDetection.ZONE_THRESHOLDS の初期値と合わせる。変更時は両方を同時に変えること。
const DEFAULT_ZONE_FAR = 0.12;
const DEFAULT_ZONE_MID = 0.25;

export function zoneForSize(size: number, far = DEFAULT_ZONE_FAR, mid = DEFAULT_ZONE_MID): VisitorZone {
  if (size <= 0) return "absent";
  if (size < far) return "far";
  if (size < mid) return "mid";
  return "near";
}

function estimateVelocity(positions: PositionSample[], windowMs: number): { vx: number; vy: number } {
  if (positions.length < 2) return { vx: 0, vy: 0 };
  const latest = positions[positions.length - 1];
  const cutoff = latest.t - windowMs;
  let earliest: PositionSample | null = null;
  for (const p of positions) {
    if (p.t >= cutoff) {
      earliest = p;
      break;
    }
  }
  if (!earliest || earliest === latest) return { vx: 0, vy: 0 };
  const dtSec = (latest.t - earliest.t) / 1000;
  if (dtSec <= 0) return { vx: 0, vy: 0 };
  return {
    vx: (latest.x - earliest.x) / dtSec,
    vy: (latest.y - earliest.y) / dtSec,
  };
}

function cloneVisitor(v: Visitor): Visitor {
  return {
    ...v,
    positions: v.positions.slice(),
    zones: v.zones.slice(),
    velocity: { ...v.velocity },
  };
}

export function createVisitorTracker(options: VisitorTrackerOptions = {}): VisitorTracker {
  const matchDistance = options.matchDistance ?? DEFAULT_MATCH_DISTANCE;
  const leaveAfterMs = options.leaveAfterMs ?? DEFAULT_LEAVE_AFTER_MS;
  const maxPositions = options.maxPositions ?? DEFAULT_MAX_POSITIONS;
  const velocityWindowMs = options.velocityWindowMs ?? DEFAULT_VELOCITY_WINDOW_MS;
  const zoneFar = options.zoneFar ?? DEFAULT_ZONE_FAR;
  const zoneMid = options.zoneMid ?? DEFAULT_ZONE_MID;

  const active = new Map<string, Visitor>();
  let nextId = 1;

  function observeNew(obs: FaceObservation, nowMs: number): Visitor {
    const zone = zoneForSize(obs.size, zoneFar, zoneMid);
    const v: Visitor = {
      id: `v${nextId++}`,
      firstSeenMs: nowMs,
      lastSeenMs: nowMs,
      positions: [{ t: nowMs, x: obs.x, y: obs.y, size: obs.size }],
      velocity: { vx: 0, vy: 0 },
      zones: [{ t: nowMs, zone } satisfies ZoneSample],
    };
    active.set(v.id, v);
    return v;
  }

  function observeExisting(v: Visitor, obs: FaceObservation, nowMs: number): void {
    v.lastSeenMs = nowMs;
    v.positions.push({ t: nowMs, x: obs.x, y: obs.y, size: obs.size });
    if (v.positions.length > maxPositions) {
      v.positions.splice(0, v.positions.length - maxPositions);
    }
    v.velocity = estimateVelocity(v.positions, velocityWindowMs);
    const zone = zoneForSize(obs.size, zoneFar, zoneMid);
    const lastZone = v.zones[v.zones.length - 1];
    if (!lastZone || lastZone.zone !== zone) {
      v.zones.push({ t: nowMs, zone });
    }
  }

  return {
    update(faces: FaceObservation[], nowMs: number): TrackerUpdate {
      // 貪欲な最近傍マッチング（置換なし）。観測も追跡中も少数（通常1〜4）の想定。
      const unmatched = new Map(active);
      const matched = new Set<string>();
      // 安定のため x 昇順で処理順を固定（入力順序に依存しない）。
      const ordered = faces.slice().sort((a, b) => a.x - b.x);
      for (const obs of ordered) {
        let bestId: string | null = null;
        let bestDist = Infinity;
        for (const [id, v] of unmatched) {
          const last = v.positions[v.positions.length - 1];
          if (!last) continue;
          const d = Math.hypot(obs.x - last.x, obs.y - last.y);
          if (d < bestDist) {
            bestDist = d;
            bestId = id;
          }
        }
        if (bestId !== null && bestDist <= matchDistance) {
          const v = unmatched.get(bestId);
          if (v) {
            observeExisting(v, obs, nowMs);
            unmatched.delete(bestId);
            matched.add(bestId);
          }
        } else {
          const v = observeNew(obs, nowMs);
          matched.add(v.id);
        }
      }

      // leave 判定: マッチしなかった追跡のうち、未観測が leaveAfterMs を超えたもの。
      const left: Visitor[] = [];
      for (const [id, v] of unmatched) {
        if (!matched.has(id) && nowMs - v.lastSeenMs >= leaveAfterMs) {
          left.push(cloneVisitor(v));
          active.delete(id);
        }
      }

      return {
        active: [...active.values()].map(cloneVisitor),
        left,
      };
    },

    getActive(): Visitor[] {
      return [...active.values()].map(cloneVisitor);
    },

    reset(): void {
      active.clear();
      nextId = 1;
    },
  };
}
