const checks = [
  {
    name: "フロントエンド",
    url: "http://localhost:5173/",
    timeoutMs: 4_000,
  },
  {
    name: "Groq APIプロキシ",
    url: "http://localhost:5173/groq/openai/v1/models",
    timeoutMs: 15_000,
  },
  {
    name: "ローカルSTT",
    url: "http://localhost:8000/docs",
    timeoutMs: 4_000,
  },
  {
    name: "AivisSpeech",
    url: "http://localhost:10101/speakers",
    timeoutMs: 4_000,
  },
  {
    name: "Ollamaフォールバック",
    url: "http://localhost:11434/api/tags",
    timeoutMs: 4_000,
  },
];

async function checkService(check) {
  const startedAt = performance.now();
  try {
    const response = await fetch(check.url, {
      signal: AbortSignal.timeout(check.timeoutMs),
    });
    const elapsedMs = Math.round(performance.now() - startedAt);
    if (!response.ok) {
      return { ...check, ok: false, detail: `HTTP ${response.status}`, elapsedMs };
    }
    return { ...check, ok: true, detail: `HTTP ${response.status}`, elapsedMs };
  } catch (error) {
    const elapsedMs = Math.round(performance.now() - startedAt);
    const detail = error instanceof Error ? error.message : String(error);
    return { ...check, ok: false, detail, elapsedMs };
  }
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
