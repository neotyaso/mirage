# mirage Behavior Spec

> Last updated: 2026-07-27
> Scope: 現在の来場者体験と状態遷移を、リファクタ前の基準として固定する。

## Core Experience

mirage の体験は、以下の流れを基本とする。

```text
不在
  -> 遠距離検知
  -> チラ見しながら生活感を維持
  -> 中距離/近距離到達
  -> 気づき演出 + 呼び込み
  -> 会話開始
  -> 聞く / 考える / 喋る
  -> 離脱検知
  -> 見送り
  -> 履歴リセット
```

## Distance Zones

距離は顔の正規化幅 `faceSize` で近似する。

| Zone | Condition | Meaning |
| --- | --- | --- |
| `absent` | `faceSize <= 0` | 顔が検出されていない |
| `far` | `0 < faceSize < ZONE_THRESHOLDS.far` | 遠くにいる。まだ会話対象としては扱わない |
| `mid` | `ZONE_THRESHOLDS.far <= faceSize < ZONE_THRESHOLDS.mid` | 気づき・呼び込み・会話開始対象 |
| `near` | `ZONE_THRESHOLDS.mid <= faceSize` | 近距離の会話対象 |

Current defaults:
- `far`: `0.12`
- `mid`: `0.25`

Debug mode:
- `d`: HUD toggle
- `Left/Right`: adjust far boundary
- `Up/Down`: adjust near boundary
- `0`: reset thresholds

## Visitor Presence

`useFaceDetection` updates `presentRef`.

Rules:
- A face is considered present while MediaPipe has recently seen one.
- Short camera dropouts are tolerated by `ABSENCE_GRACE_MS = 600`.
- App-level departure uses a longer timeout: `AWAY_TIMEOUT_MS = 4000`.

Important behavior:
- If a visitor disappears for more than 4 seconds during conversation, the app ends the conversation and resets history.
- This can erase context if face detection drops for too long while the same visitor is still present.

## Idle / Wandering Behavior

When `zone` is `absent` or `far`, and the app is not paused or conversing:

- Avatar wanders inside `WANDER_BOUNDS`.
- It randomly picks a target point.
- With `DEFAULT_ANCHOR_GAZE_PARAMS.chance = 0.35`, it may choose a meaningful anchor:
  - `window`
  - `plant`
- On reaching an anchor, it lingers longer and looks toward that object.
- On reaching a normal random target, it may trigger an idle gesture:
  - `stretch`
  - `nod`
  - `tilt`

Purpose:
- Keep the avatar from feeling like a static mannequin.
- Preserve the "not yet fully aware of you" fiction while someone is still far away.

## Far-Zone Glance

When a visitor is in `far`:

- Avatar continues wandering.
- It does not fully enter the noticing/beckoning mode.
- It periodically glances toward the visitor.
- Glance interval is randomized.
- If the avatar just stopped walking, glance can be triggered early with `pauseChance`.

Current defaults:
- `durationS`: `0.8`
- `intervalMinS`: `3.5`
- `intervalMaxS`: `8.0`
- `neckMax`: `0.75`
- `chestMax`: `0.55`
- `pauseChance`: `0.6`

Purpose:
- Create the feeling of "今、こっち見た?" without immediately switching to full callout.

## First Callout

The first callout for a detected visitor is delayed in `far`.

Rules:
- On new arrival, `hasGreetedRef` resets to `false`.
- If the visitor reaches `mid` or `near`, the first callout fires immediately.
- If the visitor stays in `far`, the first callout fires after `GREET_FALLBACK_MS = 4000`.
- The first callout plays `playNoticeChime()` immediately before speech.
- After the first callout, `hasGreetedRef` becomes `true`.

After greeting:
- In `far`, repeated callouts can happen every `COOLDOWN.far = 4000ms`.
- In `mid`/`near`, repeated callouts are not used because the conversation auto-starts.

## Noticing / Beckoning

When the visitor reaches `mid` or `near` after enough absent/far time:

- Avatar enters noticing for `NOTICE_DURATION_S = 2.0`.
- Avatar triggers beckon.
- Early phase uses surprised expression.
- Later phase uses happy expression.
- Body turn speed depends on initial yaw:
  - Mostly front-facing: body does not rotate much; neck pitch shows recognition.
  - Side-facing: normal turn.
  - Back-facing: faster turn.

Noticing does not trigger repeatedly unless:
- The avatar has been effectively absent/far for `NOTICE_ABSENT_MIN_S`.
- Cooldown `NOTICE_COOLDOWN_S = 8.0` has passed.

## Conversation Start

When app is started, not paused, zone is `mid` or `near`, and `convState === "idle"`:

1. App speaks one conversation-start line.
2. App calls `startConversation()`.
3. `useConversation` opens the microphone.
4. State becomes `listening`.

Reason:
- Conversation mode is otherwise silent until the visitor talks.
- Without the start line, the visitor may think nothing happened.

Current start lines:
- "うんうん、何か話してよ！"
- "よし、聞く準備できたよ！"
- "さあさあ、何でも聞かせて！"

## Conversation State Machine

Current `useConversation` state:

```text
idle
  -> startConversation()
listening
  -> VAD detects speech start
listening
  -> VAD detects speech end
thinking
  -> STT result accepted
thinking
  -> LLM streaming starts
speaking
  -> first ready sentence sent to TTS
speaking
  -> all queued TTS done
listening
  -> stopConversation()
idle
```

Notes:
- `thinking` includes STT request time and LLM request time.
- `speaking` can begin before full LLM output is complete, because the stream is split by sentence.
- After all TTS has completed, state returns to `listening` if conversation is still active.

## VAD / Recording Behavior

Conversation uses browser audio APIs:

- `getUserMedia({ audio: true })`
- `AudioContext`
- `AnalyserNode`
- `MediaRecorder`

VAD rules:
- Speech starts when average frequency magnitude exceeds `SPEECH_THRESHOLD = 28`.
- Speech ends after `SILENCE_DURATION_MS = 900` of silence.
- Speech shorter than `MIN_SPEECH_MS = 500` is ignored.
- While avatar is speaking or busy, VAD loop does not record.
- On speech start, avatar triggers `nod`.
- During longer speech, avatar may trigger more nods.

## STT Behavior

Primary:
- Groq Whisper `whisper-large-v3`
- Endpoint: `/groq/openai/v1/audio/transcriptions`
- Request uses `response_format=verbose_json`.

Fallback:
- Local STT server
- Endpoint: `/stt/transcribe`
- Backed by `stt_server.py` and faster-whisper `small`.

Filtering:
- If Groq returns high `no_speech_prob`, the text is discarded.
- Known Whisper hallucination phrases are discarded.
- Local fallback does not return `no_speech_prob`, so only text-pattern filtering applies.

If STT fails completely:
- Conversation returns to `listening`.
- No explicit user-facing error is shown.

## LLM Behavior

Primary:
- Groq chat completions
- Model: `llama-3.3-70b-versatile`
- Streaming enabled.

Fallback:
- Ollama
- Model: `gemma4:e4b`
- Non-streaming.

Context:
- System prompt defines the Rem persona.
- Conversation history is stored in `historyRef`.
- Current perception context can be inserted as a system note:
  - number of visitors
  - smile state
  - previous visual comment

Output rules:
- Short Japanese replies.
- Optional action tags at the beginning:
  - `[nod]`
  - `[surprise]`
- Tags are stripped from spoken text and mapped to avatar actions.

## TTS Behavior

Primary:
- AivisSpeech at `http://localhost:10101`
- Speaker ID: `888753760`

Fallback:
- Browser Web Speech API.

Conversation TTS:
- `useConversation.ts` queues sentence chunks.
- Each sentence plays after the previous one ends.
- Speech generation epoch prevents old async TTS from playing after conversation stop.

App-level TTS:
- `App.tsx` has separate `speak()` for callouts, startle, look-away, vision comments, and farewell.
- It uses a generation counter to prevent overlapping non-conversation speech.

Known issue:
- App-level TTS and conversation TTS are separate systems. This works today through shared refs and explicit interruption, but should be unified.

## Vision Comment Behavior

When first greeting occurs at `mid` or `near`:

- App captures one video frame.
- Sends it to Groq vision model.
- If a positive appearance comment returns, it is stored in `lastVisionCommentRef`.
- If conversation has not started and avatar is not speaking, the comment may be spoken.
- If conversation has started, it is not spoken immediately but can be used in later LLM context.

Cooldown:
- `VISION_COOLDOWN_MS = 25000`

## Look-Away Reaction

When visitor is in `mid` or `near`:

- If `abs(faceYawRef.current) > 0.5` for more than `1500ms`, avatar may react.
- Reactions have a `15000ms` cooldown.
- Repeated look-away within a visit escalates through tiered lines.

Guardrails:
- Does not trigger while avatar is speaking.
- Does not trigger while `convState === "thinking"`.

## Startle Reaction

The app reacts to sudden approach speed rather than absolute distance.

Rules:
- Uses face size delta per second.
- Requires `curSize > 0.12`.
- Requires speed above `0.35 faceSize/sec`.
- Requires `convState === "idle"`.
- Cooldown: `10000ms`.

Purpose:
- React to abrupt movement without interrupting an active conversation.

## Departure / Farewell

When conversation is active and no face is present for `AWAY_TIMEOUT_MS = 4000`:

1. If there is conversation log history, app speaks a farewell line.
2. Avatar triggers `beckon` as a farewell wave.
3. `stopConversation()` runs.
4. `resetHistory()` clears the conversation.
5. `lastVisionCommentRef` is cleared.
6. `silentResumeRef` becomes `true`.

`silentResumeRef` prevents an immediate false "new arrival" callout after a short detection dropout.

## Paused Behavior

Debug pause:

- Stops app-level TTS.
- Stops conversation if active.
- Sets `paused = true`.
- Avatar freezes movement/position updates but keeps idle animation aspects such as blink/breath/lip logic.

## Behaviors To Preserve During Refactor

- `far` should not immediately force the avatar to face the visitor.
- `mid`/`near` should start conversation automatically.
- The conversation-start line should make the listening state visible to visitors.
- Callout and vision comment should not overlap.
- Conversation TTS should not continue after `stopConversation()`.
- Face-size smoothing should prevent zone jitter.
- Primary face tracking should avoid jumping targets when multiple faces appear.
- Conversation history should reset on real departure, not on brief camera dropout.
- App-level callouts should not interrupt active listening/thinking conversation states except where explicitly intended.
