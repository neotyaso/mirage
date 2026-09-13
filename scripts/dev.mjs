#!/usr/bin/env node
/**
 * mirage one-shot launcher (Windows / M1 Mac 共通)。
 * vite(:5173) + local STT(:8000) を起動する。backend(:8002)は廃止のため警告のみ。
 * - viteは即起動する。STTは裏で温め、準備できたらログに出す
 * - 既にヘルス応答があるサービスは再利用する (ホットスタンバイ)
 * - STT/backendの起動失敗は警告に格下げし、viteは止めない (フォールバック低下運用)
 * - AivisSpeech/Ollama は外部アプリ前提のため警告のみ
 *
 * env:
 *   STT_MODEL (未指定時: small)
 *   STT_DEVICE / STT_COMPUTE_TYPE (未指定時: cpu/int8。cuda使用時は明示指定)
 *   STT_WAIT_SEC (既定180)
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const isWin = process.platform === "win32";

const VITE_URL = "http://localhost:5173/";
const STT_URL = "http://localhost:8000/health";
const BACKEND_URL = "http://localhost:8002/health";
const AIVIS_URL = "http://localhost:10101/speakers";
const OLLAMA_URL = "http://localhost:11434/api/tags";

const STT_WAIT_MS = Number(process.env.STT_WAIT_SEC ?? 180) * 1000;

const children = new Map(); // name -> ChildProcess (自分が起動した分だけ)

function pythonCmd() {
  const venv = path.join(root, isWin ? ".venv/Scripts/python.exe" : ".venv/bin/python");
  if (fs.existsSync(venv)) return venv;
  return isWin ? "python" : "python3";
}

async function health(url, timeoutMs = 4000) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitFor(name, url, waitMs) {
  const deadline = Date.now() + waitMs;
  process.stdout.write(`[wait] ${name} `);
  for (;;) {
    if (await health(url)) {
      console.log("OK");
      return true;
    }
    if (Date.now() >= deadline) {
      console.log("NG (timeout)");
      return false;
    }
    process.stdout.write(".");
    await new Promise((r) => setTimeout(r, 2000));
  }
}

function cleanup() {
  for (const [name, child] of children) {
    try {
      child.kill();
    } catch {
      // already dead
    }
    children.delete(name);
  }
}
process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});
process.on("SIGTERM", () => {
  cleanup();
  process.exit(143);
});

function startBackground(name, cmd, args, opts, logFile) {
  return new Promise((resolve, reject) => {
    const logFd = fs.openSync(logFile, "a");
    const child = spawn(cmd, args, { ...opts, stdio: ["ignore", logFd, logFd] });
    child.on("error", (err) => {
      reject(new Error(`[${name}] 起動失敗: ${err.message} (log: ${logFile})`));
    });
    child.on("exit", (code) => {
      children.delete(name);
      // 起動直後の異常終了はwaitFor側のtimeoutとして検出する。ここでは警告のみ
      if (code !== 0 && code !== null) {
        console.error(`\n[${name}] exited code=${code} (log: ${logFile})`);
      }
    });
    children.set(name, child);
    console.log(`[ .. ] ${name} を起動中... (log: ${logFile})`);
    resolve(child);
  });
}

async function ensureStt() {
  if (await health(STT_URL)) {
    console.log("[ OK ] local STT (:8000) 起動済み。再利用する");
    return;
  }
  const env = { ...process.env };
  if (!env.STT_DEVICE) env.STT_DEVICE = "cpu";
  if (!env.STT_COMPUTE_TYPE) env.STT_COMPUTE_TYPE = "int8";
  if (!env.STT_MODEL) env.STT_MODEL = "small";
  console.log(
    `[ .. ] local STT model=${env.STT_MODEL} device=${env.STT_DEVICE}/${env.STT_COMPUTE_TYPE}`,
  );
  await startBackground("local STT", pythonCmd(), ["stt_server.py"], { cwd: root, env }, path.join(os.tmpdir(), "mirage-stt.log"));
  if (!(await waitFor("local STT (:8000)", STT_URL, STT_WAIT_MS))) {
    throw new Error("local STT が応答しない。ログを確認");
  }
}

async function ensureBackend() {
  // moshi-backend廃止に伴い警告のみ。Gemini Liveはブラウザ直結、Groq経路はbackend不要
  if (await health(BACKEND_URL)) {
    console.log("[ OK ] backend (:8002) 応答あり (使用しない)");
    return;
  }
  console.log("[ -- ] backendなし (不要。moshi-backendは廃止予定)");
}

async function main() {
  console.log("mirage startup check");

  // STT/backendは裏で温める (viteをブロックしない)。失敗は警告に格下げ
  const warming = [ensureStt(), ensureBackend()].map((p) =>
    p.catch((err) => {
      console.error(`[ WARN ] ${err.message} (フォールバック低下で継続)`);
    }),
  );

  // AivisSpeech / Ollama (警告のみ、高速チェック)
  if (!(await health(AIVIS_URL))) console.log("[ -- ] AivisSpeechなし。起動は任意 (VOICEVOX等でも可)");
  else console.log("[ OK ] AivisSpeech 応答あり");
  if (!(await health(OLLAMA_URL))) console.log("[ -- ] Ollamaなし。起動は任意 (`ollama serve`)");
  else console.log("[ OK ] Ollama 応答あり");

  // viteは即起動
  if (await health(VITE_URL)) {
    console.log("[ OK ] vite 起動済み。再利用する。裏の起動完了を待つ...");
    await Promise.all(warming);
    return;
  }
  console.log("starting vite (:5173)...");
  // npx.cmd直spawnはWindowsでEINVALになるため、nodeでvite binを直接叩く
  const viteBin = path.join(root, "node_modules", "vite", "bin", "vite.js");
  if (!fs.existsSync(viteBin)) {
    console.error("[ NG ] viteがない。`npm install` を実行");
    cleanup();
    process.exit(1);
    return;
  }
  await new Promise((resolve) => {
    const vite = spawn(process.execPath, [viteBin], { cwd: root, stdio: "inherit", env: process.env });
    vite.on("exit", (code, signal) => {
      cleanup();
      resolve();
      process.exitCode = code ?? (signal ? 130 : 0);
    });
    vite.on("error", (err) => {
      console.error(`[vite] 起動失敗: ${err.message}`);
      cleanup();
      process.exitCode = 1;
      resolve();
    });
  });
}

try {
  await main();
} catch (err) {
  console.error(`[ NG ] ${err.message}`);
  cleanup();
  process.exit(1);
}
