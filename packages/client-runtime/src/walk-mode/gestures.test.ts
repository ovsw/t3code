import { describe, expect, it } from "vite-plus/test";

import {
  initialWalkModeState,
  walkModeReducer,
  type WalkModeEffect,
  type WalkModeEvent,
  type WalkModeState,
} from "./gestures.ts";

const single: WalkModeEvent = { type: "press.single" };
const double: WalkModeEvent = { type: "press.double" };
const triple: WalkModeEvent = { type: "press.triple" };
const reply: WalkModeEvent = { type: "reply.arrived" };

/** Runs a sequence of events and returns the final state plus every effect in order. */
function run(events: readonly WalkModeEvent[], start: WalkModeState = initialWalkModeState) {
  const effects: WalkModeEffect[] = [];
  let state = start;
  for (const event of events) {
    const step = walkModeReducer(state, event);
    state = step.state;
    effects.push(...step.effects);
  }
  return { state, effects, effectTypes: effects.map((effect) => effect.type) };
}

describe("walk mode: listening", () => {
  it("starts speaking when a reply arrives while idle", () => {
    const { state, effectTypes } = run([reply]);
    expect(state.kind).toBe("speaking");
    expect(effectTypes).toEqual(["speech.start"]);
  });

  it("one press pauses, one more press resumes from where it left off", () => {
    const { state, effectTypes } = run([reply, single, single]);
    expect(state.kind).toBe("speaking");
    expect(effectTypes).toEqual(["speech.start", "speech.pause", "speech.resume"]);
  });

  it("a loaded reply waits as paused, and one press reads it", () => {
    const { state, effectTypes } = run([{ type: "reply.loaded" }, single]);
    expect(state.kind).toBe("speaking");
    expect(effectTypes).toEqual(["speech.resume"]);
  });

  it("one press while idle does nothing", () => {
    const { state, effects } = run([single]);
    expect(state).toEqual(initialWalkModeState);
    expect(effects).toEqual([]);
  });

  it("goes idle when speech finishes", () => {
    const start: WalkModeState = { kind: "speaking", hasSpeech: true };
    const { state } = run([{ type: "speech.finished" }], start);
    expect(state).toEqual({ kind: "idle", hasSpeech: false });
  });
});

describe("walk mode: recording", () => {
  it("two presses while paused start recording, two more stop it", () => {
    const { state, effectTypes } = run([reply, single, double, double]);
    expect(state.kind).toBe("transcribing");
    expect(effectTypes).toEqual(["speech.start", "speech.pause", "record.start", "record.stop"]);
  });

  it("two presses while speaking pause first, then record", () => {
    const { state, effectTypes } = run([reply, double]);
    expect(state.kind).toBe("recording");
    expect(effectTypes).toEqual(["speech.start", "speech.pause", "record.start"]);
  });

  it("two presses while idle start a recording, so a conversation can begin", () => {
    const { state, effectTypes } = run([double]);
    expect(state.kind).toBe("recording");
    expect(effectTypes).toEqual(["record.start"]);
  });

  it("one press while recording stops it", () => {
    const { state, effectTypes } = run([double, single]);
    expect(state.kind).toBe("transcribing");
    expect(effectTypes).toEqual(["record.start", "record.stop"]);
  });

  it("returns to paused after a transcript when there is speech", () => {
    const { state } = run([reply, single, double, double, { type: "transcript.ready" }]);
    expect(state).toEqual({ kind: "paused", hasSpeech: true });
  });

  it("returns to idle after a transcript when there is nothing to read", () => {
    const { state } = run([double, double, { type: "transcript.ready" }]);
    expect(state).toEqual({ kind: "idle", hasSpeech: false });
  });

  it("plays the error sound when transcription fails", () => {
    const start: WalkModeState = { kind: "transcribing", hasSpeech: false, sendWhenDone: true };
    const { state, effectTypes } = run([{ type: "transcript.failed" }], start);
    expect(state).toEqual({ kind: "idle", hasSpeech: false });
    expect(effectTypes).toEqual(["sound.error"]);
  });

  it("returns to rest with the error sound when the recording cannot start", () => {
    const { state, effectTypes } = run([reply, single, double, { type: "record.failed" }]);
    expect(state).toEqual({ kind: "paused", hasSpeech: true });
    expect(effectTypes).toEqual(["speech.start", "speech.pause", "record.start", "sound.error"]);
  });

  it("remembers a reply that arrives during recording, so one press plays it later", () => {
    const { state, effectTypes } = run([
      double,
      reply,
      double,
      { type: "transcript.ready" },
      single,
    ]);
    expect(state.kind).toBe("speaking");
    expect(effectTypes).toEqual(["record.start", "record.stop", "speech.resume"]);
  });
});

describe("walk mode: sending", () => {
  it("three presses send from idle, speaking, or paused without changing state", () => {
    for (const start of [
      initialWalkModeState,
      { kind: "speaking", hasSpeech: true },
      { kind: "paused", hasSpeech: true },
    ] satisfies WalkModeState[]) {
      const { state, effectTypes } = run([triple], start);
      expect(state).toEqual(start);
      expect(effectTypes).toEqual(["send"]);
    }
  });

  it("three presses while recording stop the recording and send once its text arrives", () => {
    const { state, effectTypes } = run([double, triple, { type: "transcript.ready" }]);
    expect(effectTypes).toEqual(["record.start", "record.stop", "send"]);
    expect(state).toEqual(initialWalkModeState);
  });

  it("three presses while transcribing send as soon as the text arrives", () => {
    const { effectTypes } = run([double, double, triple, { type: "transcript.ready" }]);
    expect(effectTypes).toEqual(["record.start", "record.stop", "send"]);
  });

  it("a failed transcription cancels a pending send", () => {
    const { effectTypes } = run([double, triple, { type: "transcript.failed" }]);
    expect(effectTypes).toEqual(["record.start", "record.stop", "sound.error"]);
  });
});
