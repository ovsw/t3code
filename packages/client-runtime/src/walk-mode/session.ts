// @effect-diagnostics globalTimers:off - The session runs in the mobile client without an Effect runtime.
import type { PreparedVoiceTranscription, VoiceTranscriber } from "../voice-input/transcription.ts";
import {
  initialWalkModeState,
  walkModeReducer,
  type WalkModeEffect,
  type WalkModeEvent,
  type WalkModeState,
} from "./gestures.ts";
import {
  readableWalkModeRuns,
  walkModeReplyForRun,
  type WalkModeRun,
  type WalkModeTurns,
} from "./reply.ts";

export type WalkModeStatus = WalkModeState["kind"];

export type WalkModeSound = "error" | "sent" | "saved" | "tick" | "thinking";

export type WalkModeAudioEvent =
  | { readonly type: "gesture"; readonly presses: 1 | 2 | 3 }
  /** In call mode the headset sends call actions instead of press counts. */
  | { readonly type: "call-action"; readonly action: string }
  | { readonly type: "chunk-finished" }
  /** Sent once the session is configured and whenever headphones connect or disconnect. */
  | { readonly type: "route"; readonly headphones: boolean };

/** The native audio module, as the session sees it. */
export interface WalkModeAudioPort {
  configureSession(): Promise<void>;
  /** Replaces whatever is queued with these chunks and starts speaking. */
  speak(chunks: readonly string[]): Promise<void>;
  /** Queues chunks after the ones already loaded, keeping the pause state. */
  enqueue(chunks: readonly string[]): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  /** Speaks one sentence beside the reply queue, which keeps its place and pause state. */
  announce(text: string): Promise<void>;
  setKeepAlive(enabled: boolean): Promise<void>;
  setNowPlayingTitle(title: string): Promise<void>;
  /** A wired microphone (the Lightning dongle) is connected. */
  hasWiredInput(): Promise<boolean>;
  /** Call mode records the headset microphone through a fake call; otherwise the wired input. */
  startRecording(useCallMode: boolean): Promise<string>;
  /** Ends any fake call and returns the headset to music mode. */
  stopRecording(): Promise<{ readonly uri: string | null; readonly seconds: number }>;
  playSound(kind: WalkModeSound): Promise<void>;
  /** Ends speech, recording, any fake call, and the keep-alive, and releases the audio session. */
  shutdown(): Promise<void>;
  subscribe(listener: (event: WalkModeAudioEvent) => void): () => void;
}

/** Whether the thread's environment is connected. */
export interface WalkModeConnection {
  read(): boolean;
  subscribe(onChange: () => void): () => void;
}

export interface WalkModeTurnStream {
  read(): WalkModeTurns | null;
  subscribe(onChange: () => void): () => void;
}

/** The thread's composer draft. */
export interface WalkModeDraft {
  read(): string;
  append(text: string): void;
  replace(text: string): void;
}

/** Read on each use, so a change in Settings applies to the running session. */
export interface WalkModeSettings {
  /** A reply that arrives while the voice is paused starts at once instead of waiting for a press. */
  readonly readNewRepliesWhilePaused: boolean;
  /** The tone that repeats while a sent message waits for its reply. */
  readonly thinkingTone: boolean;
}

export const DEFAULT_WALK_MODE_SETTINGS: WalkModeSettings = {
  readNewRepliesWhilePaused: true,
  thinkingTone: true,
};

export type WalkModeSessionInput = {
  readonly turns: WalkModeTurnStream;
  readonly draft: WalkModeDraft;
  /** Sends one user message, queued after the active turn when one runs. */
  readonly send: (text: string) => Promise<void>;
  readonly audio: WalkModeAudioPort;
  readonly transcriber: VoiceTranscriber | null;
  readonly connection: WalkModeConnection;
  readonly settings: () => WalkModeSettings;
};

export const WALK_MODE_RECORDING_LIMIT_MS = 5 * 60 * 1000;

export const WALK_MODE_THINKING_INTERVAL_MS = 4000;

const WALK_MODE_ANNOUNCEMENTS = {
  sendFailed: "Send failed, your draft is kept.",
  transcriptionFailed: "Transcription failed, recording dropped.",
  recordingFailed: "Recording failed.",
  nothingHeard: "Nothing heard, draft unchanged.",
  serverUnreachable: "Server unreachable.",
  sendOffline: "Server unreachable, your draft is kept.",
} as const;

const WALK_MODE_MESSAGE_PREFIX =
  "[Walk mode: I dictated this by voice, so expect transcription mistakes. Your reply is read aloud to me. " +
  "Answer in short, plain spoken paragraphs, with no code and no lists, and ask one question at a time.]";

/** Added at send time only, so the draft keeps the walker's own words. */
export function withWalkModePrefix(text: string): string {
  // Slash commands must stay first so the server and composer still recognise them.
  if (text.trimStart().startsWith("/")) return text;
  return `${WALK_MODE_MESSAGE_PREFIX}\n\n${text}`;
}

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
  /** Changes on every start, so results from an earlier run are ignored. */
  private runId = 0;
  private cleanups: Array<() => void> = [];
  private readonly listeners = new Set<() => void>();
  private readonly seenRuns = new Set<string>();
  private baselineTaken = false;
  private title: string | null = null;
  /** Chunks of replies not yet handed to the audio port. */
  private pendingChunks: string[] = [];
  /** The newest reply, read again by one press once speech has finished. */
  private latestReplyChunks: readonly string[] = [];
  /** Chunks handed to the audio port that have not finished yet. */
  private loadedChunks = 0;
  /** Settles true once the native recorder runs, false when it could not start. */
  private recordingStarted: Promise<boolean> | null = null;
  private recordingLimit: ReturnType<typeof setTimeout> | null = null;
  private transcription: Promise<PreparedVoiceTranscription> | null = null;
  private abortController = new AbortController();
  private thinkingTone: ReturnType<typeof setInterval> | null = null;
  /** The thinking tone stops once a run newer than this ordinal reaches a terminal status. */
  private awaitedAfterOrdinal: number | null = null;
  /** Assumed until the audio port reports the route; nothing is audible without them. */
  private headphones = true;
  private connected = true;

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
    this.runId += 1;
    this.abortController = new AbortController();
    this.headphones = true;
    // A restart begins like a first start: silent, with the latest reply loaded as paused.
    this.title = null;
    this.latestReplyChunks = [];
    this.baselineTaken = false;
    this.seenRuns.clear();
    const { audio, turns, connection } = this.input;
    this.cleanups.push(audio.subscribe((event) => this.handleAudioEvent(event)));
    try {
      await audio.configureSession();
      if (this.running) await audio.setKeepAlive(true);
    } catch (error) {
      this.stop();
      throw error;
    }
    // stop() already queued shutdown after these native calls; a second one could end a newer session.
    if (!this.running) return;
    this.connected = connection.read();
    this.cleanups.push(connection.subscribe(() => this.syncConnection()));
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
    this.stopThinking();
    this.abortController.abort();
    this.transcription = null;
    const recording = this.recordingStarted;
    this.recordingStarted = null;
    ignoreFailure(audio.shutdown());
    // A recorder still starting when the shutdown ran is stopped once it runs.
    recording?.then((started) => {
      if (started) ignoreFailure(audio.stopRecording());
    });
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
    this.checkReplyReady(readable);
    // A run can turn terminal before its reply text arrives, so a run is seen only once
    // its reply has loaded; a run without one is checked again on the next change.
    if (!this.baselineTaken) {
      this.baselineTaken = true;
      for (let index = readable.length - 1; index >= 0; index -= 1) {
        const reply = walkModeReplyForRun(turns, readable[index]!.id);
        if (reply === null) continue;
        for (const run of readable.slice(0, index + 1)) this.seenRuns.add(run.id);
        this.pendingChunks.push(...reply.chunks);
        this.latestReplyChunks = reply.chunks;
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
      this.latestReplyChunks = reply.chunks;
      // The voice finishes what it reads before the new reply. Once paused, the rest of the
      // old reply is stale: the walker moved on, so the new reply takes its place.
      if (this.state.kind === "speaking") this.queueChunks(reply.chunks);
      else this.replaceChunks(reply.chunks);
      // Without headphones the reply waits as paused instead of playing through the speaker.
      this.dispatch(
        this.headphones
          ? {
              type: "reply.arrived",
              readWhilePaused: this.input.settings().readNewRepliesWhilePaused,
            }
          : { type: "reply.loaded" },
      );
    }
  }

  private syncConnection(): void {
    const connected = this.input.connection.read();
    const lost = this.connected && !connected;
    this.connected = connected;
    if (lost && this.running) this.announce(WALK_MODE_ANNOUNCEMENTS.serverUnreachable);
  }

  private playSound(kind: WalkModeSound): void {
    if (this.headphones) ignoreFailure(this.input.audio.playSound(kind));
  }

  /** The error sound, then the problem in one spoken sentence. */
  private announce(sentence: string): void {
    if (!this.headphones) return;
    this.playSound("error");
    ignoreFailure(this.input.audio.announce(sentence));
  }

  private queueChunks(chunks: readonly string[]): void {
    if (this.loadedChunks === 0) {
      this.pendingChunks.push(...chunks);
      return;
    }
    this.loadedChunks += chunks.length;
    ignoreFailure(this.input.audio.enqueue(chunks));
  }

  /** Paused chunks stay in the audio port until the next speak replaces them. */
  private replaceChunks(chunks: readonly string[]): void {
    this.pendingChunks = [...chunks];
    this.loadedChunks = 0;
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
        // Presses without headphones come from the lock screen and would play through the speaker.
        if (this.headphones) this.dispatch(PRESS_EVENTS[event.presses]);
        return;
      case "call-action":
        // Call actions carry no press count, so any of them stops a recording.
        if (this.headphones && this.state.kind === "recording") this.dispatch(PRESS_EVENTS[2]);
        return;
      case "chunk-finished":
        if (this.loadedChunks === 0) return;
        this.loadedChunks -= 1;
        if (this.loadedChunks === 0) this.dispatch({ type: "speech.finished" });
        return;
      case "route": {
        const lost = this.headphones && !event.headphones;
        this.headphones = event.headphones;
        if (lost) this.dispatch({ type: "headset.lost" });
        return;
      }
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
      case "speech.replay":
        if (this.latestReplyChunks.length === 0) {
          this.playSound("error");
          this.dispatch({ type: "speech.finished" });
          return;
        }
        this.pendingChunks = [...this.latestReplyChunks];
        this.speakPending();
        return;
      case "record.start":
        this.startRecording();
        return;
      case "record.stop":
        this.stopRecording();
        return;
      case "send":
        this.sendDraft();
        return;
      case "sound.error":
        this.playSound("error");
        return;
    }
  }

  private startRecording(): void {
    const { audio } = this.input;
    if (this.input.transcriber === null) {
      this.dispatch({ type: "record.failed" });
      if (this.headphones) {
        ignoreFailure(this.input.audio.announce(WALK_MODE_ANNOUNCEMENTS.recordingFailed));
      }
      return;
    }
    const runId = this.runId;
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
        if (runId !== this.runId || !this.running || this.state.kind !== "recording") return;
        this.playSound("tick");
        this.recordingLimit = setTimeout(() => {
          this.recordingLimit = null;
          if (this.state.kind === "recording") this.dispatch(PRESS_EVENTS[1]);
        }, WALK_MODE_RECORDING_LIMIT_MS);
      },
      () => {
        if (runId !== this.runId) return;
        this.dispatch({ type: "record.failed" });
        if (this.headphones) {
          ignoreFailure(this.input.audio.announce(WALK_MODE_ANNOUNCEMENTS.recordingFailed));
        }
      },
    );
  }

  private stopRecording(): void {
    this.clearRecordingLimit();
    const runId = this.runId;
    const started = this.recordingStarted;
    this.recordingStarted = null;
    this.playSound("tick");
    void this.transcribeRecording(started).then(
      (text) => {
        if (runId !== this.runId || !this.running) return;
        const trimmed = text.trim();
        const sending = this.state.kind === "transcribing" && this.state.sendWhenDone;
        if (trimmed.length > 0) {
          this.appendToDraft(trimmed);
          // Without it the walker cannot tell when the text landed; a send plays its own sound.
          if (!sending) this.playSound("saved");
        } else {
          this.announce(WALK_MODE_ANNOUNCEMENTS.nothingHeard);
        }
        this.dispatch({ type: "transcript.ready" });
      },
      // Also covers a recording stopped while starting whose start then failed.
      () => {
        if (runId !== this.runId || !this.running) return;
        this.dispatch({ type: "transcript.failed" });
        if (this.headphones) {
          ignoreFailure(this.input.audio.announce(WALK_MODE_ANNOUNCEMENTS.transcriptionFailed));
        }
      },
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
    const newlines = (/\s*$/u.exec(existing)?.[0] ?? "").split("\n").length - 1;
    const separator = existing.trim().length === 0 ? "" : "\n".repeat(Math.max(0, 2 - newlines));
    draft.append(`${separator}${text}`);
  }

  private sendDraft(): void {
    const { draft } = this.input;
    const text = draft.read();
    if (text.trim().length === 0) {
      this.playSound("error");
      return;
    }
    // The message would wait in the outbox with no reply and no tone to explain the silence.
    if (!this.connected) {
      this.announce(WALK_MODE_ANNOUNCEMENTS.sendOffline);
      return;
    }
    // Taken before sending: the reply's run, started or queued, is newer than every run now.
    const awaitedAfter = Math.max(
      -1,
      ...(this.input.turns.read()?.runs ?? []).map((run) => run.ordinal),
    );
    const runId = this.runId;
    this.input.send(withWalkModePrefix(text.trim())).then(
      () => {
        if (runId !== this.runId || !this.running) return;
        // Text added while the send was in flight stays in the draft.
        const current = draft.read();
        if (current.startsWith(text)) draft.replace(current.slice(text.length).trimStart());
        this.playSound("sent");
        this.startThinking(awaitedAfter);
      },
      () => {
        if (runId === this.runId && this.running) this.announce(WALK_MODE_ANNOUNCEMENTS.sendFailed);
      },
    );
  }

  private startThinking(awaitedAfter: number): void {
    this.awaitedAfterOrdinal = Math.max(this.awaitedAfterOrdinal ?? -1, awaitedAfter);
    const turns = this.input.turns.read();
    if (turns !== null) this.checkReplyReady(readableWalkModeRuns(turns));
    if (this.awaitedAfterOrdinal === null || this.thinkingTone !== null) return;
    this.thinkingTone = setInterval(() => {
      if (this.state.kind !== "speaking" && this.input.settings().thinkingTone) {
        this.playSound("thinking");
      }
    }, WALK_MODE_THINKING_INTERVAL_MS);
  }

  private checkReplyReady(readable: readonly WalkModeRun[]): void {
    const after = this.awaitedAfterOrdinal;
    if (after !== null && readable.some((run) => run.ordinal > after)) this.stopThinking();
  }

  private stopThinking(): void {
    this.awaitedAfterOrdinal = null;
    if (this.thinkingTone === null) return;
    clearInterval(this.thinkingTone);
    this.thinkingTone = null;
  }

  private clearRecordingLimit(): void {
    if (this.recordingLimit === null) return;
    clearTimeout(this.recordingLimit);
    this.recordingLimit = null;
  }
}
