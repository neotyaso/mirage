import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  // .env.local から読む。ブラウザ側には一切渡さず、このNode側のプロキシ設定内だけで使う
  const env = loadEnv(mode, process.cwd(), "");
  const GROQ_API_KEY = env.GROQ_API_KEY ?? "";

  return {
    plugins: [react()],
    server: {
      host: true,
      proxy: {
        "/ollama": {
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
      },
    },
  };
});
