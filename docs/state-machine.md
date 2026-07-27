# Interaction State Machine

> Last updated: 2026-07-27
> Scope: Phase 2 の足場。現時点では `App.tsx` に読み取り専用で接続し、既存制御は置き換えない。

## Goal

今の mirage は、来場者の距離、会話状態、呼び込み、チラ見、気づき、離脱処理が `App.tsx` と `Avatar.tsx` に分散している。

Phase 2 では、まず状態を明示する。いきなり既存コードを置き換えず、`src/state/interactionMachine.ts` に純粋な reducer を置き、`App.tsx` から観察用にイベントを流す。その後の小さな移行で、既存の refs と分岐を reducer の effects へ寄せていく。

## Added Module

[src/state/interactionMachine.ts](/Users/apple/mirage/src/state/interactionMachine.ts:1)

This module exports:

- `InteractionState`
- `InteractionEvent`
- `InteractionEffect`
- `createInitialInteractionState()`
- `transitionInteraction()`

It has no React dependency and no browser API dependency.

## Current Wiring

[src/App.tsx](/Users/apple/mirage/src/App.tsx:1) now dispatches these events to the reducer:

- `APP_STARTED`
- `APP_PAUSED`
- `APP_RESUMED`
- `FACE_UPDATED`
- `CONVERSATION_STATE_CHANGED`

The returned effects are intentionally ignored for now. Existing `App.tsx` logic still performs callouts, conversation start, departure handling, and memory reset.

Debug HUD now shows:

```text
machine: running | phase: engaged | attn: engaged | greet: requested | mconv: listening | sid: 1 | lookAway: 0
```

This lets us compare actual runtime state with the state-machine model before using the reducer as a source of truth.

## Promoted State

The first production state promoted into the reducer is `lookAwayStreak`.

Before:
- `App.tsx` owned `lookAwayStreakRef`.
- New visitor detection reset it.
- Each look-away reaction incremented it.

Now:
- `interaction.lookAwayStreak` is the source of truth.
- `FACE_UPDATED` resets it on new arrival.
- `LOOK_AWAY_REACTION_FIRED` increments it.
- `App.tsx` still owns the actual speech timing and cooldown.

This is intentionally low-risk because it only affects which tier of look-away line is selected. It does not start/stop conversation or play first greetings.

## State Axes

The state machine separates the current implicit state into these axes.

| Axis | Values | Meaning |
| --- | --- | --- |
| `runtime` | `stopped`, `running`, `paused` | App-level operation state |
| `zone` | `absent`, `far`, `mid`, `near` | Visitor distance zone |
| `visitorPhase` | `none`, `candidate`, `engaged`, `departing` | High-level visitor lifecycle |
| `attention` | `wandering`, `glancing`, `noticing`, `beckoning`, `engaged`, `farewell` | Avatar attention mode |
| `conversation` | `idle`, `listening`, `thinking`, `speaking` | Conversation pipeline state |
| `greeting` | `not_started`, `requested`, `done` | First greeting state for the current visitor |

## Event Model

Events represent facts from the runtime. They do not directly play audio or manipulate the avatar.

Examples:

```ts
{ type: "APP_STARTED" }
{ type: "FACE_UPDATED", zone: "mid", present: true, nowMs: 12345 }
{ type: "CONVERSATION_STATE_CHANGED", state: "thinking" }
{ type: "GREETING_COMPLETED" }
```

## Effect Model

Effects represent commands the outside runtime should perform.

Current effects:

```ts
{ type: "PLAY_FIRST_GREETING", reason: "interactive_zone", zone: "mid" }
{ type: "START_CONVERSATION", zone: "near" }
{ type: "END_CONVERSATION", reason: "departure_timeout" }
{ type: "CLEAR_VISITOR_MEMORY", reason: "departure_timeout" }
```

This is the key design direction: the state machine decides *what should happen*, while `App.tsx`, `useConversation.ts`, and `Avatar.tsx` decide *how to perform it*.

## Current Mapping To Existing Code

| Existing code | Future source of truth |
| --- | --- |
| `started`, `paused` in `App.tsx` | `runtime` |
| `zone` state in `App.tsx` | `zone` |
| `hasGreetedRef` | `greeting` |
| `firstSeenAtRef` | `firstSeenAtMs` |
| `lastPresentAtRef` | `lastPresentAtMs` |
| `silentResumeRef` | `silentResume` |
| `lookAwayStreakRef` | `lookAwayStreak` implemented |
| `convState` from `useConversation` | `conversation` |
| `noticeUntil`, `glanceUntil`, `beckonT` in `Avatar.tsx` | eventually `attention` plus animation-local clocks |

## Migration Plan

Do not wire everything at once.

1. Add unit-level examples or tests for `transitionInteraction()`.
2. Observe reducer output in the debug HUD while using the app.
3. Replace `hasGreetedRef`, `firstSeenAtRef`, `silentResumeRef`, and `lastPresentAtRef` with `InteractionState`.
4. Move callout/conversation-start decisions from the 150ms interval into state-machine effects.
5. Keep `Avatar.tsx` animation clocks local, but feed it explicit attention state.
6. Only after App orchestration is stable, split `Avatar.tsx` into animation submodules.

## Rules To Preserve

- `far` means "detected but not fully engaged".
- `mid` and `near` may trigger first greeting and conversation start.
- `far` triggers first greeting only after the fallback delay.
- Conversation departure is based on the longer app-level away timeout, not MediaPipe's short absence grace.
- Silent resume prevents a brief face-detection dropout from causing a new-arrival callout.
- Effects must be idempotent enough that React render timing does not cause duplicate speech.

## Why This Comes Before Splitting `Avatar.tsx`

`Avatar.tsx` is large, but most of the risk is not file size by itself. The risk is that behavior policy and animation mechanics are mixed.

The reducer gives us a stable policy layer before moving animation code around. That means future refactors can preserve behavior intentionally instead of relying on scattered refs and timing assumptions.
