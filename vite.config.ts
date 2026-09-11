import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  // .env.local から読む。ブラウザ側には一切渡さず、このNode側のプロキシ設定内だけで使う
  const env = loadEnv(mode, process.cwd(), "");
  const GROQ_API_KEY = env.GROQ_API_KEY ?? "";
  // Gemini Live API 用。WSプロキシで ?key= として付与するのでブラウザJSには出さない
  const GEMINI_API_KEY = env.GEMINI_API_KEY ?? "";

  return {
    plugins: [react()],
    server: {
      host: true,
      port: 5173,
      // 展示端末のURLを固定する。使用中なら別ポートへ逃げず、明確に失敗させる。
      strictPort: true,
      proxy: {
        // Gemini backend (:8002)。token発行・S2Sプロキシ用。dev専用
        "/api": {
          target: "http://localhost:8002",
          changeOrigin: true,
        },        "/ollama": {
          target: "http://localhost:11434",
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/ollama/, ""),
        },
        // ローカルSTTサーバー（オフライン用フォールバック。今はGroqを優先）
        "/stt": {
          target: "http://localhost:8000",
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/stt/, ""),
        },
        // Groq (LLM + Whisper STT)。APIキーはここでサーバー側から付与するのでブラウザJSには出さない
        "/groq": {
          target: "https://api.groq.com",
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/groq/, ""),
          configure: (proxy) => {
            proxy.on("proxyReq", (proxyReq) => {
              if (GROQ_API_KEY) proxyReq.setHeader("Authorization", `Bearer ${GROQ_API_KEY}`);
            });
          },
        },
        // Gemini Live API (stateful WebSocket)。APIキーはクエリに付与して中継
        "/gemini-live": {
          target: "wss://generativelanguage.googleapis.com",
          changeOrigin: true,
          ws: true,
          rewrite: () =>
            `/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`,
        },
      },
    },
  };
});
