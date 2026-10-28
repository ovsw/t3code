import type { VoiceTranscriber } from "../voice-input/transcription.ts";
import {
  initialWalkModeState,
  walkModeReducer,
  type WalkModeEffect,
  type WalkModeEvent,
  type WalkModeState,
} from "./gestures.ts";
import { readableWalkModeRuns, walkModeReplyForRun, type WalkModeTurns } from "./reply.ts";

export type WalkModeStatus = WalkModeState["kind"];

export type WalkModeSound = "error" | "sent" | "tick" | "thinking";

export type WalkModeAudioEvent =
  | { readonly type: "gesture"; readonly presses: 1 | 2 | 3 }
  /** In call mode the headset sends call actions instead of press counts. */
  | { readonly type: "call-action"; readonly action: string }
  | { readonly type: "chunk-finished" }
  | { readonly type: "route"; readonly outputs: string; readonly inputs: string };

/** The native audio module, as the session sees it. */
export interface WalkModeAudioPort {
  configureSession(): Promise<void>;
  /** Replaces whatever is queued with these chunks and starts speaking. */
  speak(chunks: readonly string[]): Promise<void>;
  /** Queues chunks after the ones already loaded, keeping the pause state. */
  enqueue(chunks: readonly string[]): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  stop(): Promise<void>;
  setKeepAlive(enabled: boolean): Promise<void>;
  setNowPlayingTitle(title: string): Promise<void>;
  startRecording(useCallMode: boolean): Promise<string>;
  stopRecording(): Promise<{ readonly uri: string | null; readonly seconds: number }>;
  playSound(kind: WalkModeSound): Promise<void>;
  subscribe(listener: (event: WalkModeAudioEvent) => void): () => void;
}

export interface WalkModeTurnStream {
  read(): WalkModeTurns | null;
  subscribe(onChange: () => void): () => void;
}

/** The thread's composer draft. */
export interface WalkModeDraft {
  read(): string;
  append(text: string): void;
}

export type WalkModeSessionInput = {
  readonly turns: WalkModeTurnStream;
  readonly draft: WalkModeDraft;
  readonly send: (text: string) => Promise<void>;
  readonly audio: WalkModeAudioPort;
  readonly transcriber: VoiceTranscriber | null;
};

const PRESS_EVENTS = {
  1: { type: "press.single" },
  2: { type: "press.double" },
  3: { type: "press.triple" },
} as const satisfies Record<1 | 2 | 3, WalkModeEvent>;

function ignoreFailure(promise: Promise<unknown>): void {
  promise.catch(() => undefined);
}

/**
 * One Walk mode session on one thread. It reads completed replies from the
 * turn stream, answers headphone gestures through the gesture state machine,
 * and runs the machine's effects against the audio port.
 */
export class WalkModeSession {
  private readonly input: WalkModeSessionInput;
  private state: WalkModeState = initialWalkModeState;
  private running = false;
  private cleanups: Array<() => void> = [];
  private readonly listeners = new Set<() => void>();
  private readonly seenRuns = new Set<string>();
  private baselineTaken = false;
  private title: string | null = null;
  /** Chunks of replies not yet handed to the audio port. */
  private pendingChunks: string[] = [];
  /** Chunks handed to the audio port that have not finished yet. */
  private loadedChunks = 0;

  constructor(input: WalkModeSessionInput) {
    this.input = input;
  }

  get status(): WalkModeStatus {
    return this.state.kind;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Silent: the latest completed reply waits as paused until one press. */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const { audio, turns } = this.input;
    this.cleanups.push(audio.subscribe((event) => this.handleAudioEvent(event)));
    try {
      await audio.configureSession();
      await audio.setKeepAlive(true);
    } catch (error) {
      this.stop();
      throw error;
    }
    if (!this.running) return;
    this.cleanups.push(turns.subscribe(() => this.syncTurns()));
    this.syncTurns();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    for (const cleanup of this.cleanups) cleanup();
    this.cleanups = [];
    const { audio } = this.input;
    ignoreFailure(audio.stop());
    ignoreFailure(audio.setKeepAlive(false));
    this.pendingChunks = [];
    this.loadedChunks = 0;
    this.setState(initialWalkModeState);
  }

  private setState(state: WalkModeState): void {
    if (state === this.state) return;
    const changed = state.kind !== this.state.kind;
    this.state = state;
    if (changed) for (const listener of this.listeners) listener();
  }

  private dispatch(event: WalkModeEvent): void {
    if (!this.running) return;
    const step = walkModeReducer(this.state, event);
    this.setState(step.state);
    for (const effect of step.effects) this.runEffect(effect);
  }

  private syncTurns(): void {
    const turns = this.input.turns.read();
    if (turns === null) return;
    if (turns.title !== this.title) {
      this.title = turns.title;
      ignoreFailure(this.input.audio.setNowPlayingTitle(turns.title));
    }
    const readable = readableWalkModeRuns(turns);
    if (!this.baselineTaken) {
      this.baselineTaken = true;
      for (const run of readable) this.seenRuns.add(run.id);
      for (let index = readable.length - 1; index >= 0; index -= 1) {
        const reply = walkModeReplyForRun(turns, readable[index]!.id);
        if (reply === null) continue;
        this.pendingChunks.push(...reply.chunks);
        this.dispatch({ type: "reply.loaded" });
        break;
      }
      return;
    }
    for (const run of readable) {
      if (this.seenRuns.has(run.id)) continue;
      this.seenRuns.add(run.id);
      const reply = walkModeReplyForRun(turns, run.id);
      if (reply === null) continue;
      this.queueChunks(reply.chunks);
      this.dispatch({ type: "reply.arrived" });
    }
  }

  private queueChunks(chunks: readonly string[]): void {
    if (this.loadedChunks === 0) {
      this.pendingChunks.push(...chunks);
      return;
    }
    this.loadedChunks += chunks.length;
    ignoreFailure(this.input.audio.enqueue(chunks));
  }

  private speakPending(): void {
    const chunks = this.pendingChunks;
    this.pendingChunks = [];
    this.loadedChunks = chunks.length;
    if (chunks.length > 0) ignoreFailure(this.input.audio.speak(chunks));
  }

  private handleAudioEvent(event: WalkModeAudioEvent): void {
    switch (event.type) {
      case "gesture":
        this.dispatch(PRESS_EVENTS[event.presses]);
        return;
      case "call-action":
        // Call actions carry no press count, so any of them stops a recording.
        if (this.state.kind === "recording") this.dispatch(PRESS_EVENTS[2]);
        return;
      case "chunk-finished":
        if (this.loadedChunks === 0) return;
        this.loadedChunks -= 1;
        if (this.loadedChunks === 0) this.dispatch({ type: "speech.finished" });
        return;
      case "route":
        return;
    }
  }

  private runEffect(effect: WalkModeEffect): void {
    const { audio } = this.input;
    switch (effect.type) {
      case "speech.start":
        this.speakPending();
        return;
      case "speech.pause":
        if (this.loadedChunks > 0) ignoreFailure(audio.pause());
        return;
      case "speech.resume":
        if (this.loadedChunks > 0) ignoreFailure(audio.resume());
        else this.speakPending();
        return;
      case "record.start":
        // Recording is not built yet: refuse it so the machine returns to rest.
        this.dispatch({ type: "record.failed" });
        return;
      case "record.stop":
      case "send":
        return;
      case "sound.error":
        ignoreFailure(audio.playSound("error"));
        return;
      case "sound.sent":
        ignoreFailure(audio.playSound("sent"));
        return;
    }
  }
}
