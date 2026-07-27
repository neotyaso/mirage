# mirage Architecture

> Last updated: 2026-07-27
> Scope: 現在の実装を、今後の設計変更の基準として固定する。

## Purpose

mirage は、展示ブースの前を通る来場者に 3D アバターが気づき、呼び込み、近づいた相手と音声で会話するリアルタイム対話システム。

現時点では React/Vite のフロントエンドが、カメラ入力、顔検出、3D 表示、会話制御、STT/LLM/TTS 呼び出しの大半を持つ。Vite proxy とローカル補助サーバーが外部 API とローカルフォールバックを支える。

## High-Level Flow

```text
Web camera
  -> useFaceDetection(MediaPipe FaceLandmarker)
  -> presence / face size / face center / eye center / yaw / expression
  -> App orchestration
       -> callout / notice chime / vision comment
       -> useConversation
            -> browser microphone + VAD
            -> Groq Whisper STT
                 fallback -> local stt_server.py
            -> Groq chat streaming
                 fallback -> Ollama
            -> AivisSpeech TTS
                 fallback -> Web Speech API
       -> Avatar
            -> VRM render
            -> wandering / noticing / beckoning / glancing / lip sync / expressions
       -> OffAxisCamera
            -> camera parallax from face position
```

## Main Runtime Components

### `src/App.tsx`

Top-level runtime orchestrator.

Responsibilities:
- Starts the exhibition mode and fullscreen.
- Owns `started`, `paused`, `present`, `zone`, `debugMode`.
- Reads face refs from `useFaceDetection`.
- Computes conversation context from number of faces, smile score, and last vision comment.
- Starts/stops `useConversation` when a visitor reaches `mid` or `near`.
- Handles callouts, notice chime, startle lines, look-away reactions, farewell lines.
- Owns app-level `speak()` for non-conversation utterances such as callouts and vision comments.
- Passes live refs into `Avatar`.

Important coupling:
- `App.tsx` has its own TTS path separate from `useConversation.ts`.
- Both paths share `speakingRef` and `volumeRef`, but use separate `activeSourceRef` instances.
- `App.tsx` calls `startConversation()` while also speaking a conversation-start line. This is intentional but easy to break.

### `src/hooks/useFaceDetection.ts`

Camera and visual perception layer.

Responsibilities:
- Opens the browser camera.
- Runs MediaPipe FaceLandmarker in video mode.
- Tracks up to 4 faces.
- Chooses a primary face by nearest previous primary center, falling back to largest face.
- Exposes refs for:
  - `presentRef`
  - `faceCountRef`
  - `faceCenterRef`
  - `eyeCenterRef`
  - `faceSizeRef`
  - `faceYawRef`
  - `allFaceCentersRef`
  - `allEyeCentersRef`
  - `expressionRef`
- Smooths face size to reduce distance-zone jitter.
- Provides adjustable zone thresholds.

Current distance zones:

```ts
faceSize <= 0        -> absent
faceSize < 0.12      -> far
faceSize < 0.25      -> mid
otherwise            -> near
```

### `src/hooks/useConversation.ts`

Conversation pipeline.

Responsibilities:
- Owns conversation state: `idle`, `listening`, `thinking`, `speaking`.
- Opens microphone on `startConversation()`.
- Runs a browser-side volume-threshold VAD loop.
- Records speech with `MediaRecorder`.
- Sends audio to Groq Whisper.
- Falls back to local STT server if Groq STT fails.
- Filters common Whisper hallucinations and no-speech results.
- Sends user text to Groq chat completions with streaming enabled.
- Falls back to Ollama if Groq chat fails.
- Splits streaming LLM output by sentence and queues TTS before full completion.
- Sends TTS to AivisSpeech.
- Falls back to Web Speech API if AivisSpeech fails.
- Emits action tags for `Avatar`, currently `[nod]` and `[surprise]`.
- Nudges the visitor after long silence.

Important coupling:
- VAD, STT, LLM, TTS, log state, conversation history, and action tags live in one hook.
- Provider selection is embedded in this file rather than abstracted.
- API shapes are mixed directly into UI runtime logic.

### `src/components/Avatar.tsx`

VRM avatar runtime.

Responsibilities:
- Loads the VRM model and VRMA animations.
- Updates avatar pose every frame.
- Handles wandering, meaningful anchor visits, noticing, beckoning, far-zone glancing, walking, speaking sway, nod/tilt/surprise/stretch actions, lip sync, blink, expressions, neck tracking, and look-at behavior.
- Uses face refs directly for gaze, zone detection, and reactions.

Current behavioral axes inside this component:
- Presence/distance: `absent`, `far`, `mid`, `near`
- Conversation flag: `conversing`
- Motion mode: wandering, returning, conversation positioning, noticing, beckoning, gesturing, paused
- Attention mode: normal gaze, multi-face scan, far glance, anchor gaze
- Expression mode: blink, lip sync, happy, surprised

This is the largest current design bottleneck. It should be split only after the current behavior is covered by docs and small regression checks.

### `src/vision/visionComment.ts`

One-frame visual comment generator.

Responsibilities:
- Captures a camera frame.
- Sends it to Groq vision model.
- Returns a short positive appearance comment or empty result.

The result is stored in `lastVisionCommentRef` and can either be spoken before the conversation starts or injected into future LLM context.

### `vite.config.ts`

Development proxy and API-key boundary.

Responsibilities:
- Loads `GROQ_API_KEY` server-side through Vite.
- Proxies:
  - `/groq` -> `https://api.groq.com`
  - `/ollama` -> `http://localhost:11434`
  - `/stt` -> `http://localhost:8000`

Current limitation:
- This is a development-server boundary, not a production backend. For a production-quality architecture, this should become a real backend service.

### `stt_server.py`

Local STT fallback.

Responsibilities:
- FastAPI server on port `8000`.
- Accepts audio files at `POST /transcribe`.
- Runs faster-whisper `small` on CPU with `int8`.
- Uses faster-whisper VAD filtering.

## Current Provider Map

| Capability | Primary | Fallback | Location |
| --- | --- | --- | --- |
| Face detection | MediaPipe FaceLandmarker | none | `useFaceDetection.ts` |
| STT | Groq Whisper `whisper-large-v3` | local `stt_server.py` | `useConversation.ts` |
| LLM | Groq `llama-3.3-70b-versatile` | Ollama `gemma4:e4b` | `useConversation.ts` |
| Vision comment | Groq `llama-4-scout` | skip comment | `visionComment.ts` |
| TTS | AivisSpeech | Web Speech API | `App.tsx`, `useConversation.ts` |
| 3D avatar | Three.js + VRM | none | `Avatar.tsx` |

## Design Boundaries To Create Next

These are not implemented yet. They are the natural next boundaries for Phase 2+.

1. `conversation-runtime`
   - Own STT, LLM, TTS, history, provider fallback, timeout, retry, and logs.

2. `perception-runtime`
   - Own face detection, target selection, zone state, expressions, and gaze targets.

3. `avatar-state-machine`
   - Convert distance/conversation/attention/motion into explicit events and states.

4. `audio-runtime`
   - Unify app-level callout TTS and conversation TTS.
   - Own playback generation counters, interruption, volume analysis, and pan.

5. `operations`
   - Start services, check ports, expose health, and provide failure diagnostics.

## Known Architecture Debt

- `Avatar.tsx` is a god component. It mixes state transitions, animation math, rendering, and behavior policy.
- `useConversation.ts` mixes provider code, browser audio, VAD, chat state, TTS playback, and UI logs.
- `App.tsx` owns too much orchestration and uses timer-based polling every 150ms.
- There are two TTS implementations with similar AivisSpeech logic.
- Fallbacks exist, but they are not surfaced as explicit runtime states.
- There is no automated regression test for core visitor flows.
- Current backend boundary is Vite proxy, not a deployable backend.
