// @effect-diagnostics globalTimers:off - The session runs in the mobile client without an Effect runtime.
import type { PreparedVoiceTranscription, VoiceTranscriber } from "../voice-input/transcription.ts";
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
  /** A wired microphone (the Lightning dongle) is connected. */
  hasWiredInput(): Promise<boolean>;
  /** Call mode records the headset microphone through a fake call; otherwise the wired input. */
  startRecording(useCallMode: boolean): Promise<string>;
  /** Ends any fake call and returns the headset to music mode. */
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

export const WALK_MODE_RECORDING_LIMIT_MS = 5 * 60 * 1000;

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
  /** Settles true once the native recorder runs, false when it could not start. */
  private recordingStarted: Promise<boolean> | null = null;
  private recordingLimit: ReturnType<typeof setTimeout> | null = null;
  private transcription: Promise<PreparedVoiceTranscription> | null = null;
  private abortController = new AbortController();

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
    this.abortController = new AbortController();
    const { audio, turns } = this.input;
    this.cleanups.push(audio.subscribe((event) => this.handleAudioEvent(event)));
    try {
      await audio.configureSession();
      if (!this.running) return;
      await audio.setKeepAlive(true);
    } catch (error) {
      this.stop();
      throw error;
    }
    if (!this.running) {
      ignoreFailure(audio.setKeepAlive(false));
      return;
    }
    this.cleanups.push(turns.subscribe(() => this.syncTurns()));
    this.syncTurns();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    for (const cleanup of this.cleanups) cleanup();
    this.cleanups = [];
    const { audio } = this.input;
    this.clearRecordingLimit();
    this.abortController.abort();
    this.transcription = null;
    const recording = this.recordingStarted;
    this.recordingStarted = null;
    recording?.then((started) => {
      if (started) ignoreFailure(audio.stopRecording());
    });
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
    // A run can turn terminal before its reply text arrives, so a run is seen only once
    // its reply has loaded; a run without one is checked again on the next change.
    if (!this.baselineTaken) {
      this.baselineTaken = true;
      for (let index = readable.length - 1; index >= 0; index -= 1) {
        const reply = walkModeReplyForRun(turns, readable[index]!.id);
        if (reply === null) continue;
        for (const run of readable.slice(0, index + 1)) this.seenRuns.add(run.id);
        this.pendingChunks.push(...reply.chunks);
        this.dispatch({ type: "reply.loaded" });
        break;
      }
      return;
    }
    for (const run of readable) {
      if (this.seenRuns.has(run.id)) continue;
      const reply = walkModeReplyForRun(turns, run.id);
      if (reply === null) continue;
      this.seenRuns.add(run.id);
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
        this.startRecording();
        return;
      case "record.stop":
        this.stopRecording();
        return;
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

  private startRecording(): void {
    const { audio } = this.input;
    if (this.input.transcriber === null) {
      this.dispatch({ type: "record.failed" });
      return;
    }
    const started = (async () => {
      const wired = await audio.hasWiredInput();
      await audio.startRecording(!wired);
    })();
    this.recordingStarted = started.then(
      () => true,
      () => false,
    );
    started.then(
      () => {
        if (!this.running || this.state.kind !== "recording") return;
        ignoreFailure(audio.playSound("tick"));
        this.recordingLimit = setTimeout(() => {
          this.recordingLimit = null;
          if (this.state.kind === "recording") this.dispatch(PRESS_EVENTS[1]);
        }, WALK_MODE_RECORDING_LIMIT_MS);
      },
      () => this.dispatch({ type: "record.failed" }),
    );
  }

  private stopRecording(): void {
    this.clearRecordingLimit();
    const started = this.recordingStarted;
    this.recordingStarted = null;
    ignoreFailure(this.input.audio.playSound("tick"));
    void this.transcribeRecording(started).then(
      (text) => {
        if (!this.running) return;
        const trimmed = text.trim();
        if (trimmed.length > 0) this.appendToDraft(trimmed);
        this.dispatch({ type: "transcript.ready", text: trimmed });
      },
      // Also covers a recording stopped while starting whose start then failed.
      () => this.dispatch({ type: "transcript.failed" }),
    );
  }

  private async transcribeRecording(started: Promise<boolean> | null): Promise<string> {
    if (started === null || !(await started)) throw new Error("The recording did not start.");
    const { uri } = await this.input.audio.stopRecording();
    if (uri === null) throw new Error("The recording produced no audio.");
    const prepared = await this.prepareTranscription();
    return prepared.transcribe(uri, { signal: this.abortController.signal });
  }

  private prepareTranscription(): Promise<PreparedVoiceTranscription> {
    const { transcriber } = this.input;
    if (transcriber === null) return Promise.reject(new Error("No transcriber."));
    if (this.transcription === null) {
      const preparing = transcriber.prepare({ signal: this.abortController.signal });
      preparing.catch(() => {
        if (this.transcription === preparing) this.transcription = null;
      });
      this.transcription = preparing;
    }
    return this.transcription;
  }

  /** Each recording starts a new paragraph after text already in the draft. */
  private appendToDraft(text: string): void {
    const { draft } = this.input;
    const existing = draft.read();
    const separator = existing.trim().length === 0 || /\s$/u.test(existing) ? "" : "\n\n";
    draft.append(`${separator}${text}`);
  }

  private clearRecordingLimit(): void {
    if (this.recordingLimit === null) return;
    clearTimeout(this.recordingLimit);
    this.recordingLimit = null;
  }
}
