// tracking 基盤の簡易自己テスト（node のみで実行可。vitest / tsx 不要）。
// 方針: node_modules の typescript で src/tracking/*.ts の実物を
// その場で JS にトランスパイル（一時ディレクトリ経由で import）して振る舞いを検証する。
// TS ソースが読めない/変換できない場合はテキスト契約チェックだけでも失敗理由が分かるようにする。

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const trackingDir = path.join(rootDir, "src", "tracking");

let failures = 0;
function assert(cond, msg) {
  if (cond) {
    console.log(`ok - ${msg}`);
  } else {
    failures += 1;
    console.error(`FAIL - ${msg}`);
  }
}

function mustContain(file, text, label) {
  const src = readFileSync(path.join(trackingDir, file), "utf8");
  assert(src.includes(text), `${label} (${file} に "${text}" を含む)`);
  return src;
}

// ---- 1. 契約チェック（テキスト） ----
mustContain("types.ts", "interface Visitor", "Visitor 型");
mustContain("types.ts", "positions", "Visitor.positions（軌道）");
mustContain("types.ts", "velocity", "Visitor.velocity（速度）");
mustContain("types.ts", "TrackEvent", "TrackEvent 型");
mustContain("types.ts", "callout", "callout イベント種別");
mustContain("types.ts", "conversation_start", "conversation_start イベント種別");
mustContain("types.ts", "conversation_end", "conversation_end イベント種別");
mustContain("types.ts", '"stop"', "stop イベント種別");
mustContain("types.ts", '"leave"', "leave イベント種別");
mustContain("types.ts", "variant", "ABテスト用 variant");
mustContain("visitorTracker.ts", "createVisitorTracker", "createVisitorTracker 公開");
mustContain("visitorTracker.ts", "update(faces", "update(faces, nowMs) 公開");
mustContain("visitorTracker.ts", "leaveAfterMs", "leave 判定の猶予設定");
mustContain("eventLog.ts", "toJsonl", "toJsonl 公開");
mustContain("eventLog.ts", "downloadJsonl", "downloadJsonl 公開");
mustContain("eventLog.ts", "variant", "eventLog の variant 対応");

// ---- 2. 実物の TS をトランスパイルして読み込む ----
let trackerSrc = readFileSync(path.join(trackingDir, "visitorTracker.ts"), "utf8");
let eventLogSrc = readFileSync(path.join(trackingDir, "eventLog.ts"), "utf8");
let ts;
try {
  ts = require("typescript");
} catch (e) {
  console.error(`FAIL - typescript が require できません: ${e.message}`);
  process.exit(1);
}
const outDir = path.join(os.tmpdir(), "mirage-tracking-test");
mkdirSync(outDir, { recursive: true });
function transpile(name, src) {
  const out = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const file = path.join(outDir, `${name}.test.mjs`);
  writeFileSync(file, out);
  return file;
}
const trackerFile = transpile("visitorTracker", trackerSrc);
const eventLogFile = transpile("eventLog", eventLogSrc);
const trackerMod = await import(pathToFileURL(trackerFile).href);
const eventLogMod = await import(pathToFileURL(eventLogFile).href);

// ---- 3. visitorTracker の振る舞い ----
{
  const tracker = trackerMod.createVisitorTracker();
  let r = tracker.update([{ x: 0.5, y: 0.5, size: 0.2 }], 1000);
  assert(r.active.length === 1, "初回観測で1人を追跡開始");
  const id = r.active[0].id;
  assert(typeof id === "string" && id.length > 0, "Visitor に id が付与される");
  assert(r.active[0].firstSeenMs === 1000, "firstSeenMs が記録される");
  assert(r.active[0].positions.length === 1, "軌道の初回サンプルが記録される");

  r = tracker.update([{ x: 0.51, y: 0.5, size: 0.2 }], 1100);
  assert(r.active.length === 1 && r.active[0].id === id, "近傍の顔は同一 id で継続");
  assert(r.active[0].positions.length === 2, "軌道が蓄積される");
  assert(r.active[0].zones.length >= 1, "zone 履歴が記録される");

  r = tracker.update(
    [
      { x: 0.51, y: 0.5, size: 0.2 },
      { x: 0.85, y: 0.4, size: 0.15 },
    ],
    1200,
  );
  assert(r.active.length === 2, "2人同時で2トラック");
  assert(new Set(r.active.map((v) => v.id)).size === 2, "id が重複しない");
  assert(r.active.some((v) => v.id === id), "既存 id が維持される");

  // 速度推定：+x 方向に移動させると vx > 0
  const t2 = trackerMod.createVisitorTracker();
  t2.update([{ x: 0.2, y: 0.5, size: 0.2 }], 0);
  const moved = t2.update([{ x: 0.3, y: 0.5, size: 0.2 }], 500);
  assert(moved.active[0].velocity.vx > 0, "右移動で vx > 0（速度推定）");

  // zone 判定：size 0.3 は near
  const t3 = trackerMod.createVisitorTracker();
  const near = t3.update([{ x: 0.5, y: 0.5, size: 0.3 }], 0);
  assert(near.active[0].zones[0].zone === "near", "size 0.3 → near（useFaceDetection と同閾値）");

  // leave 判定：既定 4000ms 未観測で left に出る
  const t4 = trackerMod.createVisitorTracker();
  t4.update([{ x: 0.5, y: 0.5, size: 0.2 }], 0);
  const gone = t4.update([], 4001);
  assert(gone.active.length === 0 && gone.left.length === 1, "4000ms 超の未観測で leave 判定");
  assert(gone.left[0].lastSeenMs === 0, "leave 者の lastSeenMs が保持される");
  const t5 = trackerMod.createVisitorTracker();
  t5.update([{ x: 0.5, y: 0.5, size: 0.2 }], 0);
  const before = t5.update([], 3999);
  assert(before.left.length === 0 && before.active.length === 1, "猶予内（3999ms）は leave しない");
}

// ---- 4. eventLog の振る舞い ----
{
  const log = eventLogMod.createEventLog({ variant: "A", clock: () => 1234 });
  assert(log.size === 0, "初期サイズ 0");
  const e1 = log.append("callout", "v1", { zone: "far" });
  assert(e1.type === "callout" && e1.visitorId === "v1", "append がイベントを返す");
  assert(e1.t === 1234, "既定 clock が使われる");
  assert(e1.variant === "A", "既定 variant が付与される（ABテスト）");
  log.append("conversation_start", "v1", undefined, { t: 2000 });
  log.append("leave", "v1", { stayMs: 5000 }, { t: 7000, variant: "B" });
  log.append("stop", null, { reason: "paused" }, { t: 8000 });
  assert(log.size === 4, "4イベントが蓄積される");

  const jsonl = log.toJsonl();
  const lines = jsonl.trim().split("\n");
  assert(lines.length === 4, "toJsonl は1行1イベント");
  const parsed = lines.map((l) => JSON.parse(l));
  assert(parsed[0].type === "callout" && parsed[0].data.zone === "far", "JSONL 往復で内容保持");
  assert(parsed[2].variant === "B", "イベント単位の variant 上書き");
  assert(parsed[3].visitorId === null, "全体イベントは visitorId null");

  assert(typeof log.downloadJsonl === "function", "downloadJsonl が公開される");
  log.clear();
  assert(log.size === 0 && log.toJsonl() === "", "clear で空になる");

  const empty = eventLogMod.createEventLog();
  assert(empty.toJsonl() === "", "空ログの toJsonl は空文字");
}

// ---- 5. 結果 ----
if (failures > 0) {
  console.error(`\n${failures} 件の失敗がありました`);
  process.exit(1);
}
console.log("\n全チェック成功");
