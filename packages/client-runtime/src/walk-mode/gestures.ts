// Walk mode: a hands-free loop driven by headphone button presses.
//
// This is a pure state machine. It knows nothing about audio, the microphone,
// or the network. The host feeds it events and runs the effects it returns.
// Spike decisions still open for review are marked DECISION.

export type WalkModeState =
  | { readonly kind: "idle"; readonly hasSpeech: false; readonly drafts: readonly string[] }
  | { readonly kind: "speaking"; readonly hasSpeech: true; readonly drafts: readonly string[] }
  | { readonly kind: "paused"; readonly hasSpeech: true; readonly drafts: readonly string[] }
  | {
      readonly kind: "recording";
      readonly hasSpeech: boolean;
      readonly drafts: readonly string[];
      readonly sendWhenDone: boolean;
    }
  | {
      readonly kind: "transcribing";
      readonly hasSpeech: boolean;
      readonly drafts: readonly string[];
      readonly sendWhenDone: boolean;
    };

export type WalkModeEvent =
  | { readonly type: "press.single" }
  | { readonly type: "press.double" }
  | { readonly type: "press.triple" }
  | { readonly type: "reply.arrived" }
  | { readonly type: "speech.finished" }
  | { readonly type: "transcript.ready"; readonly text: string }
  | { readonly type: "transcript.failed" }
  | { readonly type: "record.failed" };

export type WalkModeEffect =
  | { readonly type: "speech.start" }
  | { readonly type: "speech.pause" }
  | { readonly type: "speech.resume" }
  | { readonly type: "record.start" }
  | { readonly type: "record.stop" }
  | { readonly type: "send"; readonly text: string }
  | { readonly type: "sound.error" }
  | { readonly type: "sound.sent" };

export type WalkModeStep = {
  readonly state: WalkModeState;
  readonly effects: readonly WalkModeEffect[];
};

export const initialWalkModeState: WalkModeState = { kind: "idle", hasSpeech: false, drafts: [] };

export function joinDrafts(drafts: readonly string[]): string {
  return drafts.join("\n\n");
}

function restingState(hasSpeech: boolean, drafts: readonly string[]): WalkModeState {
  return hasSpeech
    ? { kind: "paused", hasSpeech: true, drafts }
    : { kind: "idle", hasSpeech: false, drafts };
}

function send(
  state: WalkModeState,
  drafts: readonly string[],
  extraEffects: readonly WalkModeEffect[] = [],
): WalkModeStep {
  if (drafts.length === 0) {
    return { state: { ...state, drafts }, effects: [...extraEffects, { type: "sound.error" }] };
  }
  return {
    state: { ...state, drafts: [] },
    effects: [...extraEffects, { type: "send", text: joinDrafts(drafts) }, { type: "sound.sent" }],
  };
}

function startRecording(
  hasSpeech: boolean,
  drafts: readonly string[],
  extraEffects: readonly WalkModeEffect[] = [],
): WalkModeStep {
  return {
    state: { kind: "recording", hasSpeech, drafts, sendWhenDone: false },
    effects: [...extraEffects, { type: "record.start" }],
  };
}

export function walkModeReducer(state: WalkModeState, event: WalkModeEvent): WalkModeStep {
  const { drafts } = state;
  const stay: WalkModeStep = { state, effects: [] };

  switch (event.type) {
    case "press.single": {
      switch (state.kind) {
        case "speaking":
          return {
            state: { kind: "paused", hasSpeech: true, drafts },
            effects: [{ type: "speech.pause" }],
          };
        case "paused":
          return {
            state: { kind: "speaking", hasSpeech: true, drafts },
            effects: [{ type: "speech.resume" }],
          };
        case "idle":
        case "recording":
        case "transcribing":
          // DECISION: a single press is the easiest accidental press, so it never
          // stops a recording and never sends.
          return stay;
      }
      return assertNever(state);
    }

    case "press.double": {
      switch (state.kind) {
        case "paused":
          return startRecording(true, drafts);
        case "speaking":
          // DECISION: a double press while speaking pauses first, then records.
          return startRecording(true, drafts, [{ type: "speech.pause" }]);
        case "idle":
          // DECISION: recording is allowed with nothing to read, so the user can
          // start a conversation.
          return startRecording(false, drafts);
        case "recording":
          return { state: { ...state, kind: "transcribing" }, effects: [{ type: "record.stop" }] };
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
          return send(state, drafts);
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

    case "reply.arrived": {
      switch (state.kind) {
        case "idle":
          return {
            state: { kind: "speaking", hasSpeech: true, drafts },
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
          return { state: { kind: "idle", hasSpeech: false, drafts }, effects: [] };
        case "recording":
        case "transcribing":
          return { state: { ...state, hasSpeech: false }, effects: [] };
        case "idle":
          return stay;
      }
      return assertNever(state);
    }

    case "transcript.ready": {
      if (state.kind !== "transcribing") return stay;
      const text = event.text.trim();
      const nextDrafts = text.length > 0 ? [...drafts, text] : drafts;
      const rested = restingState(state.hasSpeech, nextDrafts);
      return state.sendWhenDone ? send(rested, nextDrafts) : { state: rested, effects: [] };
    }

    case "record.failed": {
      if (state.kind !== "recording") return stay;
      return { state: restingState(state.hasSpeech, drafts), effects: [{ type: "sound.error" }] };
    }

    case "transcript.failed": {
      if (state.kind !== "transcribing") return stay;
      // DECISION: a failed transcription drops the pending send; earlier drafts are kept.
      return { state: restingState(state.hasSpeech, drafts), effects: [{ type: "sound.error" }] };
    }
  }
  return assertNever(event);
}

function assertNever(value: never): never {
  throw new Error(`Unhandled walk mode case: ${JSON.stringify(value)}`);
}
