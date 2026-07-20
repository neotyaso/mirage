#!/bin/bash
# Groq/Wi-Fi不調時のオフラインフォールバック(ローカルSTT)を起動する。
# 展示当日、これを1回実行してからnpm run devを開始すること。
# Ollama(チャットのフォールバック)はアプリ常駐前提でここでは起動しない。
cd "$(dirname "$0")"

if lsof -i :8000 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "ローカルSTTサーバーは既に起動しています (port 8000)"
else
  echo "ローカルSTTサーバーを起動します..."
  source .venv/bin/activate
  nohup python stt_server.py > /tmp/mirage-stt.log 2>&1 &
  disown
  sleep 5
  if lsof -i :8000 -sTCP:LISTEN >/dev/null 2>&1; then
    echo "起動しました (port 8000)。ログ: /tmp/mirage-stt.log"
  else
    echo "起動に失敗した可能性があります。/tmp/mirage-stt.log を確認してください"
  fi
fi

if curl -s -m 2 http://localhost:11434/api/tags > /dev/null 2>&1; then
  echo "Ollamaも起動確認OK"
else
  echo "⚠️ Ollamaが応答していません。Ollamaアプリを起動してください"
fi
