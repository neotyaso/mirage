import { SERVICE_URLS, health } from "./dev.mjs";

// URL定義・health/waitForの実体は dev.mjs に一本化。ここでは表示名とtimeoutのみ持つ。
const checks = [
  { name: "フロントエンド", key: "vite", timeoutMs: 4_000 },
  { name: "Groq APIプロキシ", key: "groq", timeoutMs: 15_000 },
  { name: "ローカルSTT", key: "stt", timeoutMs: 4_000 },
  { name: "AivisSpeech", key: "aivis", timeoutMs: 4_000 },
  { name: "Ollamaフォールバック", key: "ollama", timeoutMs: 4_000 },
];

async function checkService(check) {
  const url = SERVICE_URLS[check.key];
  const startedAt = performance.now();
  const ok = await health(url, check.timeoutMs);
  const elapsedMs = Math.round(performance.now() - startedAt);
  return { ...check, url, ok, detail: ok ? "HTTP 2xx/3xx" : `no response`, elapsedMs };
}

console.log("mirage 展示ランタイム確認\n");
const results = await Promise.all(checks.map(checkService));

for (const result of results) {
  const icon = result.ok ? "OK" : "NG";
  console.log(`[${icon}] ${result.name.padEnd(20)} ${result.detail} (${result.elapsedMs}ms)`);
}

console.log("\n[手動確認] カメラ・マイク: http://localhost:5173/ を開き、ブラウザ権限を許可");

const failures = results.filter((result) => !result.ok);
if (failures.length > 0) {
  console.error(`\n${failures.length}件のサービスが応答していません。`);
  process.exitCode = 1;
} else {
  console.log("\nすべてのサービスが正常です。");
}
