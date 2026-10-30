// Walk mode: a hands-free loop driven by headphone button presses.
//
// This is a pure state machine. It knows nothing about audio, the microphone,
// or the network. The host feeds it events and runs the effects it returns.
// Spike decisions still open for review are marked DECISION.

export type WalkModeState =
  | { readonly kind: "idle"; readonly hasSpeech: false }
  | { readonly kind: "speaking"; readonly hasSpeech: true }
  | { readonly kind: "paused"; readonly hasSpeech: true }
  | {
      readonly kind: "recording";
      readonly hasSpeech: boolean;
      readonly sendWhenDone: boolean;
    }
  | {
      readonly kind: "transcribing";
      readonly hasSpeech: boolean;
      readonly sendWhenDone: boolean;
    };

export type WalkModeEvent =
  | { readonly type: "press.single" }
  | { readonly type: "press.double" }
  | { readonly type: "press.triple" }
  | { readonly type: "reply.loaded" }
  | { readonly type: "reply.arrived" }
  | { readonly type: "speech.finished" }
  | { readonly type: "transcript.ready" }
  | { readonly type: "transcript.failed" }
  | { readonly type: "record.failed" }
  /** The output route lost its headphones. */
  | { readonly type: "headset.lost" };

export type WalkModeEffect =
  | { readonly type: "speech.start" }
  | { readonly type: "speech.pause" }
  | { readonly type: "speech.resume" }
  /** Reads the latest reply again; the host plays the error sound when there is none. */
  | { readonly type: "speech.replay" }
  | { readonly type: "record.start" }
  | { readonly type: "record.stop" }
  /** Sends the composer draft; the host plays the error sound when it is empty. */
  | { readonly type: "send" }
  | { readonly type: "sound.error" };

export type WalkModeStep = {
  readonly state: WalkModeState;
  readonly effects: readonly WalkModeEffect[];
};

export const initialWalkModeState: WalkModeState = { kind: "idle", hasSpeech: false };

function restingState(hasSpeech: boolean): WalkModeState {
  return hasSpeech ? { kind: "paused", hasSpeech: true } : { kind: "idle", hasSpeech: false };
}

function startRecording(
  hasSpeech: boolean,
  extraEffects: readonly WalkModeEffect[] = [],
): WalkModeStep {
  return {
    state: { kind: "recording", hasSpeech, sendWhenDone: false },
    effects: [...extraEffects, { type: "record.start" }],
  };
}

function stopRecording(state: Extract<WalkModeState, { kind: "recording" }>): WalkModeStep {
  return { state: { ...state, kind: "transcribing" }, effects: [{ type: "record.stop" }] };
}

export function walkModeReducer(state: WalkModeState, event: WalkModeEvent): WalkModeStep {
  const stay: WalkModeStep = { state, effects: [] };

  switch (event.type) {
    case "press.single": {
      switch (state.kind) {
        case "speaking":
          return {
            state: { kind: "paused", hasSpeech: true },
            effects: [{ type: "speech.pause" }],
          };
        case "paused":
          return {
            state: { kind: "speaking", hasSpeech: true },
            effects: [{ type: "speech.resume" }],
          };
        case "recording":
          // Any press stops a recording: in call mode presses arrive without a count.
          return stopRecording(state);
        case "idle":
          return {
            state: { kind: "speaking", hasSpeech: true },
            effects: [{ type: "speech.replay" }],
          };
        case "transcribing":
          return stay;
      }
      return assertNever(state);
    }

    case "press.double": {
      switch (state.kind) {
        case "paused":
          return startRecording(true);
        case "speaking":
          // DECISION: a double press while speaking pauses first, then records.
          return startRecording(true, [{ type: "speech.pause" }]);
        case "idle":
          // DECISION: recording is allowed with nothing to read, so the user can
          // start a conversation.
          return startRecording(false);
        case "recording":
          return stopRecording(state);
        case "transcribing":
          return stay;
      }
      return assertNever(state);
    }

    case "press.triple": {
      switch (state.kind) {
        case "idle":
        case "speaking":
        case "paused":
          return { state, effects: [{ type: "send" }] };
        case "recording":
          // The current recording is part of the message: stop it, send when its text arrives.
          return {
            state: { ...state, kind: "transcribing", sendWhenDone: true },
            effects: [{ type: "record.stop" }],
          };
        case "transcribing":
          return { state: { ...state, sendWhenDone: true }, effects: [] };
      }
      return assertNever(state);
    }

    case "reply.loaded": {
      // A reply that waits for one press: the latest reply when the session starts.
      switch (state.kind) {
        case "idle":
          return { state: { kind: "paused", hasSpeech: true }, effects: [] };
        case "speaking":
        case "paused":
          return stay;
        case "recording":
        case "transcribing":
          return { state: { ...state, hasSpeech: true }, effects: [] };
      }
      return assertNever(state);
    }

    case "reply.arrived": {
      switch (state.kind) {
        case "idle":
          return {
            state: { kind: "speaking", hasSpeech: true },
            effects: [{ type: "speech.start" }],
          };
        case "speaking":
          // The speech layer appends the new reply to what it is already reading.
          return stay;
        case "paused":
          return stay;
        case "recording":
        case "transcribing":
          // Remember there is something to read; the user hears it after a single press.
          return { state: { ...state, hasSpeech: true }, effects: [] };
      }
      return assertNever(state);
    }

    case "speech.finished": {
      switch (state.kind) {
        case "speaking":
        case "paused":
          return { state: { kind: "idle", hasSpeech: false }, effects: [] };
        case "recording":
        case "transcribing":
          return { state: { ...state, hasSpeech: false }, effects: [] };
        case "idle":
          return stay;
      }
      return assertNever(state);
    }

    case "transcript.ready": {
      // The host has already appended the text to the draft.
      if (state.kind !== "transcribing") return stay;
      return {
        state: restingState(state.hasSpeech),
        effects: state.sendWhenDone ? [{ type: "send" }] : [],
      };
    }

    case "record.failed": {
      if (state.kind !== "recording") return stay;
      return { state: restingState(state.hasSpeech), effects: [{ type: "sound.error" }] };
    }

    case "headset.lost": {
      switch (state.kind) {
        case "speaking":
          return {
            state: { kind: "paused", hasSpeech: true },
            effects: [{ type: "speech.pause" }],
          };
        case "recording":
          // The recording's text still lands in the draft, but nothing is sent.
          return {
            state: { ...state, kind: "transcribing", sendWhenDone: false },
            effects: [{ type: "record.stop" }],
          };
        case "idle":
        case "paused":
        case "transcribing":
          return stay;
      }
      return assertNever(state);
    }

    case "transcript.failed": {
      if (state.kind !== "transcribing") return stay;
      // DECISION: a failed transcription drops the pending send; earlier draft text is kept.
      return { state: restingState(state.hasSpeech), effects: [{ type: "sound.error" }] };
    }
  }
  return assertNever(event);
}

function assertNever(value: never): never {
  throw new Error(`Unhandled walk mode case: ${JSON.stringify(value)}`);
}
