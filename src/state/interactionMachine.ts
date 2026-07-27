export type InteractionZone = "absent" | "far" | "mid" | "near";
export type RuntimeStatus = "stopped" | "running" | "paused";
export type VisitorPhase = "none" | "candidate" | "engaged" | "departing";
export type AttentionState =
  | "wandering"
  | "glancing"
  | "noticing"
  | "beckoning"
  | "engaged"
  | "farewell";
export type ConversationState = "idle" | "listening" | "thinking" | "speaking";
export type GreetingState = "not_started" | "requested" | "done";

export interface InteractionConfig {
  greetFallbackMs: number;
  awayTimeoutMs: number;
}

export const DEFAULT_INTERACTION_CONFIG: InteractionConfig = {
  greetFallbackMs: 4000,
  awayTimeoutMs: 4000,
};

export interface InteractionState {
  runtime: RuntimeStatus;
  zone: InteractionZone;
  present: boolean;
  visitorPhase: VisitorPhase;
  attention: AttentionState;
  conversation: ConversationState;
  greeting: GreetingState;
  sessionId: number;
  firstSeenAtMs: number | null;
  lastPresentAtMs: number | null;
  silentResume: boolean;
  lookAwayStreak: number;
}

export type InteractionEvent =
  | { type: "APP_STARTED" }
  | { type: "APP_PAUSED" }
  | { type: "APP_RESUMED" }
  | { type: "APP_STOPPED" }
  | { type: "FACE_UPDATED"; zone: InteractionZone; present: boolean; nowMs: number }
  | { type: "GREETING_COMPLETED" }
  | { type: "CONVERSATION_STATE_CHANGED"; state: ConversationState }
  | { type: "CONVERSATION_STOPPED" }
  | { type: "DEPARTURE_CONFIRMED" }
  | { type: "LOOK_AWAY_REACTION_FIRED" }
  | { type: "SILENT_RESUME_CONSUMED" }
  | { type: "ATTENTION_CHANGED"; attention: AttentionState };

export type InteractionEffect =
  | { type: "PLAY_FIRST_GREETING"; reason: "interactive_zone" | "far_timeout"; zone: Exclude<InteractionZone, "absent"> }
  | { type: "START_CONVERSATION"; zone: "mid" | "near" }
  | { type: "END_CONVERSATION"; reason: "departure_timeout" | "paused" }
  | { type: "CLEAR_VISITOR_MEMORY"; reason: "departure_timeout" };

export interface InteractionTransition {
  state: InteractionState;
  effects: InteractionEffect[];
}

export function createInitialInteractionState(): InteractionState {
  return {
    runtime: "stopped",
    zone: "absent",
    present: false,
    visitorPhase: "none",
    attention: "wandering",
    conversation: "idle",
    greeting: "not_started",
    sessionId: 0,
    firstSeenAtMs: null,
    lastPresentAtMs: null,
    silentResume: false,
    lookAwayStreak: 0,
  };
}

export function isInteractiveZone(zone: InteractionZone): zone is "mid" | "near" {
  return zone === "mid" || zone === "near";
}

export function isPresentZone(zone: InteractionZone): zone is Exclude<InteractionZone, "absent"> {
  return zone !== "absent";
}

export function transitionInteraction(
  current: InteractionState,
  event: InteractionEvent,
  config: InteractionConfig = DEFAULT_INTERACTION_CONFIG,
): InteractionTransition {
  const effects: InteractionEffect[] = [];
  let state = current;

  const patch = (partial: Partial<InteractionState>) => {
    state = { ...state, ...partial };
  };

  switch (event.type) {
    case "APP_STARTED": {
      patch({ runtime: "running" });
      break;
    }

    case "APP_PAUSED": {
      patch({ runtime: "paused" });
      if (state.conversation !== "idle") {
        effects.push({ type: "END_CONVERSATION", reason: "paused" });
      }
      break;
    }

    case "APP_RESUMED": {
      patch({ runtime: "running" });
      break;
    }

    case "APP_STOPPED": {
      patch({
        runtime: "stopped",
        zone: "absent",
        present: false,
        visitorPhase: "none",
        attention: "wandering",
        conversation: "idle",
        greeting: "not_started",
        firstSeenAtMs: null,
        lastPresentAtMs: null,
        silentResume: false,
        lookAwayStreak: 0,
      });
      break;
    }

    case "FACE_UPDATED": {
      const effectivePresent = event.present && isPresentZone(event.zone);
      const wasPresent = state.present;

      if (effectivePresent) {
        const isNewArrival = !wasPresent;
        patch({
          zone: event.zone,
          present: true,
          lastPresentAtMs: event.nowMs,
          visitorPhase: isInteractiveZone(event.zone) ? "engaged" : "candidate",
          sessionId: isNewArrival ? state.sessionId + 1 : state.sessionId,
          firstSeenAtMs: isNewArrival ? event.nowMs : state.firstSeenAtMs,
          greeting: isNewArrival && !state.silentResume ? "not_started" : state.greeting,
          lookAwayStreak: isNewArrival ? 0 : state.lookAwayStreak,
        });

        if (state.runtime === "running" && state.conversation === "idle") {
          if (state.silentResume) {
            patch({ silentResume: false });
          } else if (state.greeting === "not_started") {
            if (isInteractiveZone(event.zone)) {
              effects.push({ type: "PLAY_FIRST_GREETING", reason: "interactive_zone", zone: event.zone });
              patch({ greeting: "requested" });
            } else if (
              event.zone === "far" &&
              state.firstSeenAtMs !== null &&
              event.nowMs - state.firstSeenAtMs > config.greetFallbackMs
            ) {
              effects.push({ type: "PLAY_FIRST_GREETING", reason: "far_timeout", zone: "far" });
              patch({ greeting: "requested" });
            }
          }

          if (isInteractiveZone(event.zone)) {
            effects.push({ type: "START_CONVERSATION", zone: event.zone });
            patch({ conversation: "listening", visitorPhase: "engaged", attention: "engaged" });
          }
        }
      } else {
        patch({
          zone: "absent",
          present: false,
          attention: state.conversation === "idle" ? "wandering" : state.attention,
        });

        if (
          state.runtime === "running" &&
          state.conversation !== "idle" &&
          state.lastPresentAtMs !== null &&
          event.nowMs - state.lastPresentAtMs > config.awayTimeoutMs
        ) {
          effects.push({ type: "END_CONVERSATION", reason: "departure_timeout" });
          effects.push({ type: "CLEAR_VISITOR_MEMORY", reason: "departure_timeout" });
          patch({
            visitorPhase: "departing",
            attention: "farewell",
            conversation: "idle",
            greeting: "not_started",
            firstSeenAtMs: null,
            silentResume: true,
          });
        }
      }
      break;
    }

    case "GREETING_COMPLETED": {
      patch({ greeting: "done" });
      break;
    }

    case "CONVERSATION_STATE_CHANGED": {
      patch({
        conversation: event.state,
        visitorPhase: event.state === "idle" && !state.present ? "none" : state.visitorPhase,
        attention: event.state !== "idle" ? "engaged" : state.present ? state.attention : "wandering",
      });
      break;
    }

    case "CONVERSATION_STOPPED": {
      patch({
        conversation: "idle",
        attention: state.present ? state.attention : "wandering",
      });
      break;
    }

    case "DEPARTURE_CONFIRMED": {
      patch({
        zone: "absent",
        present: false,
        visitorPhase: "none",
        attention: "wandering",
        conversation: "idle",
        greeting: "not_started",
        firstSeenAtMs: null,
        lastPresentAtMs: null,
        silentResume: false,
        lookAwayStreak: 0,
      });
      break;
    }

    case "LOOK_AWAY_REACTION_FIRED": {
      patch({ lookAwayStreak: state.lookAwayStreak + 1 });
      break;
    }

    case "SILENT_RESUME_CONSUMED": {
      patch({ silentResume: false });
      break;
    }

    case "ATTENTION_CHANGED": {
      patch({ attention: event.attention });
      break;
    }
  }

  return { state, effects };
}
