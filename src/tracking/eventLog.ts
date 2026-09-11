// 呼び込みイベントの時系列ログ。記録基盤に徹し、集計・可視化・ポリシーは持たない。
//
// 使い方（App統合担当向け）:
//   const log = createEventLog({ variant: "A" });
//   log.append("callout", visitorId, { zone, text });
//   log.append("conversation_start", visitorId);
//   log.append("conversation_end", visitorId, { turns });
//   log.append("leave", visitorId, { stayMs });
//   log.append("stop", null, { reason: "paused" });
//   // 展示終了後に研究用に保存:
//   log.downloadJsonl(); // または log.toJsonl() を自前送信

import type { TrackEvent, TrackEventType } from "./types.js";

export interface EventAppendOptions {
  /** 既定は clock()（未指定時は Date.now()）。テスト・再生時は明示値を渡す。 */
  t?: number;
  /** 既定はログ生成時の variant。イベント単位で上書き可。 */
  variant?: string | null;
}

export interface EventLogOptions {
  /** 呼び込みABテストの条件ラベル（例: "A" / "B"）。全イベントの既定値になる。 */
  variant?: string | null;
  /** 時刻源。既定は Date.now。 */
  clock?: () => number;
}

export interface EventLog {
  append(
    type: TrackEventType,
    visitorId: string | null,
    data?: Record<string, unknown>,
    opts?: EventAppendOptions,
  ): TrackEvent;
  getAll(): TrackEvent[];
  /** 1行1イベントの JSONL 文字列。空ログは ""。 */
  toJsonl(): string;
  /** toJsonl() を Blob として保存。非DOM環境（node等）では何もしない。 */
  downloadJsonl(filename?: string): void;
  clear(): void;
  readonly size: number;
}

export function createEventLog(options: EventLogOptions = {}): EventLog {
  const defaultVariant = options.variant ?? null;
  const clock = options.clock ?? (() => Date.now());
  const events: TrackEvent[] = [];

  const log: EventLog = {
    append(type, visitorId, data, opts) {
      const event: TrackEvent = {
        type,
        visitorId,
        t: opts?.t ?? clock(),
        ...(data !== undefined ? { data } : {}),
        variant: opts?.variant !== undefined ? opts.variant : defaultVariant,
      };
      events.push(event);
      return { ...event };
    },

    getAll() {
      return events.map((e) => ({ ...e }));
    },

    toJsonl() {
      return events.map((e) => JSON.stringify(e)).join("\n") + (events.length > 0 ? "\n" : "");
    },

    downloadJsonl(filename) {
      if (typeof document === "undefined") return;
      const name = filename ?? `mirage-tracking-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`;
      const blob = new Blob([log.toJsonl()], { type: "application/jsonl" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    },

    clear() {
      events.length = 0;
    },

    get size() {
      return events.length;
    },
  };

  return log;
}
