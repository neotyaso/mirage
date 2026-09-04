# mirage Runtime Guide

> Last updated: 2026-07-27
> Scope: 現在の開発・実行手順、依存サービス、ヘルスチェック、運用上の弱点を固定する。

## Runtime Summary

mirage currently runs as a Vite React app plus local/external services.

Required for the full experience:

| Service | Purpose | Port / Endpoint |
| --- | --- | --- |
| Vite dev server | Frontend and proxy | `5173` default |
| Camera | Face detection | Browser `getUserMedia` |
| Microphone | Conversation audio | Browser `getUserMedia` |
| Groq | Primary STT, LLM, vision comment | proxied through `/groq` |
| AivisSpeech | Primary TTS | `http://localhost:10101` |
| local STT server | STT fallback | `http://localhost:8000` |
| Ollama | LLM fallback | `http://localhost:11434` |

## Environment Variables

Required for Groq-backed features:

```bash
GROQ_API_KEY=gsk_...
```

Current behavior:
- `vite.config.ts` reads `GROQ_API_KEY`.
- The key is injected into proxied `/groq` requests server-side.
- Browser JS does not directly read the key.

Recommended follow-up:
- Add `.env.example`.
- Move provider config to a typed runtime configuration module.
- Replace Vite proxy with a real backend before treating this as production architecture.

## Install

Current repository has both `package-lock.json` and `pnpm-lock.yaml`. Pick one package manager for future cleanup. Existing README uses `pnpm dev`, while scripts are standard npm-compatible.

Current commands:

```bash
npm install
npm run dev
npm run build
```

or:

```bash
pnpm install
pnpm dev
pnpm build
```

## Start Full Local Runtime

### 1. Start AivisSpeech

Install and run AivisSpeech locally.

Expected:

```text
http://localhost:10101
```

Manual check:

```bash
curl http://localhost:10101/speakers
```

### 2. Start Ollama Fallback

Install and run Ollama locally.

Expected model:

```bash
ollama run gemma4:e4b
```

Manual check:

```bash
curl http://localhost:11434/api/tags
```

### 3. Start Local STT Fallback

Current helper:

```bash
./start-fallback.sh
```

It:
- Starts `stt_server.py` if port `8000` is free.
- Checks whether Ollama responds.
- Writes STT logs to `/tmp/mirage-stt.log`.

Manual start:

```bash
source .venv/bin/activate
python stt_server.py
```

Manual check:

```bash
curl http://localhost:8000/docs
```

### 4. Start Frontend

```bash
npm run dev
```

Open the Vite URL in a browser.

Expected permissions:
- Camera permission required.
- Microphone permission required once conversation starts.
- Fullscreen requested after pressing the exhibition start button.

## Build Check

```bash
npm run build
```

Current build script:

```text
tsc --noEmit && vite build
```

Use this as the minimum regression check before larger refactors.

## Health Check Targets

Run the combined health check:

```bash
pnpm health
```

It checks the frontend on fixed port `5173`, the Groq proxy, local STT,
AivisSpeech, and Ollama. Camera and microphone permissions must still be
confirmed in the browser.

Individual checks:

```bash
curl -s http://localhost:10101/speakers >/dev/null
curl -s http://localhost:11434/api/tags >/dev/null
curl -s http://localhost:8000/docs >/dev/null
```

For Vite:

```bash
curl -s http://localhost:5173 >/dev/null
```

For Groq:
- There is no direct repo health command yet.
- Current confirmation happens indirectly through STT, LLM, or vision comment calls.

Recommended follow-up:
- Add a backend `/health` endpoint that checks provider readiness without sending real visitor data.

## Runtime Failure Modes

### Camera unavailable

Symptoms:
- Debug HUD shows camera error.
- Avatar cannot track face position.
- Off-axis camera returns to center.

Current behavior:
- Error is displayed only in debug HUD.

Needed:
- User-facing operator warning.
- Recovery flow when permission is denied or camera disappears.

### Microphone unavailable

Symptoms:
- `startConversation()` fails while requesting `getUserMedia({ audio: true })`.

Current behavior:
- No robust visible recovery path.

Needed:
- Explicit error state.
- Retry button or device-selection flow.

### AivisSpeech unavailable

Symptoms:
- Fetch to `localhost:10101` fails.

Current behavior:
- Falls back to Web Speech API.
- Voice quality changes.

Needed:
- Surface degraded TTS mode in operator UI.
- Avoid hiding persistent Aivis failures.

### Groq STT unavailable

Symptoms:
- `/groq/openai/v1/audio/transcriptions` fails.

Current behavior:
- Falls back to local STT server.

Needed:
- Log provider used per utterance.
- Surface fallback state in operator UI.

### Local STT unavailable

Symptoms:
- Groq STT fails and `/stt/transcribe` also fails.

Current behavior:
- STT failure is swallowed and conversation returns to listening.

Needed:
- Count consecutive STT failures.
- Show operator warning.
- Consider asking visitor to repeat only when appropriate.

### Groq LLM unavailable

Symptoms:
- `/groq/openai/v1/chat/completions` fails.

Current behavior:
- Falls back to Ollama.

Needed:
- Log provider switch.
- Cap fallback response time.
- Surface degraded LLM mode.

### Ollama unavailable

Symptoms:
- Groq LLM fails and `/ollama/api/chat` also fails.

Current behavior:
- Assistant may produce no response.

Needed:
- Explicit fallback line.
- Error state for operator.

### TTS race / stale playback

Current protections:
- App-level `speak()` uses `speakGenRef` to ensure only the latest non-conversation speech plays.
- Conversation TTS uses `speechEpochRef` to prevent stale async TTS from playing after stop.
- Conversation TTS queues sentence chunks to prevent overlap.

Needed:
- Unify both TTS paths.
- Make interruption policy explicit.

## Debug Controls

In main app:

- `d`: Toggle debug UI.
- Debug HUD shows camera status, presence, face count, zone, conversation state, runtime state, face size, and thresholds.
- When debug HUD is visible:
  - Manual callout button is available.
  - Pause/resume button is available.
  - Manual conversation control panel is available.
  - Distance thresholds can be adjusted with arrow keys.

Routes/pages:
- `/` main app.
- `/playground.html` avatar and interaction tuning.
- `/dosita.html` alternate mode.

## Minimum Manual Regression Checklist

Run after any behavior-affecting refactor.

1. App loads with no console error.
2. Camera permission works.
3. Debug HUD shows `cam: ok`.
4. Face detected -> zone changes from `absent` to `far/mid/near`.
5. Off-axis camera moves with face.
6. In `far`, avatar continues wandering and may glance.
7. In `mid`/`near`, avatar notices and beckons.
8. Conversation auto-starts and says a start line.
9. User speech is detected by VAD.
10. STT result appears in log.
11. LLM reply streams into log.
12. TTS starts before full reply is necessarily complete.
13. Avatar lip sync moves with TTS volume.
14. `[nod]` or VAD nod triggers avatar action.
15. Leaving for more than 4 seconds stops conversation and resets history.
16. Pause stops current speech and conversation.
17. `npm run build` passes.

## Next Operations Work

These are the first engineering tasks after Phase 1.

1. Create a one-command local runtime script.
2. Add structured health checks for Vite, AivisSpeech, STT, Ollama, and Groq.
3. Add `.env.example`.
4. Add an operator status panel that reports provider mode:
   - primary
   - fallback
   - unavailable
5. Add basic runtime logs:
   - STT provider used
   - LLM provider used
   - TTS provider used
   - latency per stage
   - error class
6. Decide package manager and remove the unused lockfile.
