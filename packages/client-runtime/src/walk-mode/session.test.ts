import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { OrchestrationV2RunStatus } from "@t3tools/contracts";

import type { WalkModeTurnItem, WalkModeTurns } from "./reply.ts";
import {
  WALK_MODE_RECORDING_LIMIT_MS,
  WalkModeSession,
  type WalkModeAudioEvent,
  type WalkModeAudioPort,
  type WalkModeTurnStream,
} from "./session.ts";

type AudioCall = readonly [method: string, ...args: unknown[]];

/** Resolves waiters when a condition they wait for becomes true; no polling. */
function changes() {
  const waiters = new Set<() => void>();
  return {
    notify: () => {
      for (const waiter of Array.from(waiters)) waiter();
    },
    until: (check: () => boolean) =>
      new Promise<void>((resolve) => {
        const waiter = () => {
          if (!check()) return;
          waiters.delete(waiter);
          resolve();
        };
        waiters.add(waiter);
        waiter();
      }),
  };
}

type FakeAudioOptions = {
  readonly wiredInput?: boolean;
  readonly startFails?: boolean;
  /** The first start fails only when the next start begins. */
  readonly firstStartFailsLate?: boolean;
};

function fakeAudio(options: FakeAudioOptions = {}) {
  const calls: AudioCall[] = [];
  const changed = changes();
  const listeners = new Set<(event: WalkModeAudioEvent) => void>();
  let heldStart: ((error: Error) => void) | null = null;
  let starts = 0;
  const push = (call: AudioCall) => {
    calls.push(call);
    changed.notify();
  };
  const record =
    (method: string) =>
    async (...args: unknown[]) => {
      push([method, ...args]);
    };
  const port: WalkModeAudioPort = {
    configureSession: record("configureSession"),
    speak: record("speak"),
    enqueue: record("enqueue"),
    pause: record("pause"),
    resume: record("resume"),
    stop: record("stop"),
    setKeepAlive: record("setKeepAlive"),
    setNowPlayingTitle: record("setNowPlayingTitle"),
    hasWiredInput: async () => options.wiredInput ?? false,
    startRecording: async (useCallMode) => {
      push(["startRecording", useCallMode]);
      starts += 1;
      heldStart?.(new Error("Call could not start"));
      if (options.firstStartFailsLate && starts === 1) {
        return new Promise<string>((_, reject) => {
          heldStart = reject;
        });
      }
      if (options.startFails) throw new Error("Call could not start");
      return "file:///recording.m4a";
    },
    stopRecording: async () => {
      push(["stopRecording"]);
      return { uri: "file:///recording.m4a", seconds: 3 };
    },
    playSound: record("playSound"),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const emit = (event: WalkModeAudioEvent) => {
    for (const listener of listeners) listener(event);
  };
  return {
    port,
    calls,
    /** Calls since the last `take`, then forgets them. */
    take: () => calls.splice(0),
    press: (presses: 1 | 2 | 3) => emit({ type: "gesture", presses }),
    callAction: (action: string) => emit({ type: "call-action", action }),
    /** Waits until an untaken call matches. */
    until: (...expected: AudioCall) =>
      changed.until(() => calls.some((call) => JSON.stringify(call) === JSON.stringify(expected))),
    finishChunks: (count: number) => {
      for (let index = 0; index < count; index += 1) emit({ type: "chunk-finished" });
    },
    listenerCount: () => listeners.size,
  };
}

function fakeTurns(initial: WalkModeTurns | null) {
  let turns = initial;
  const listeners = new Set<() => void>();
  const stream: WalkModeTurnStream = {
    read: () => turns,
    subscribe: (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
  };
  return {
    stream,
    set: (next: WalkModeTurns) => {
      turns = next;
      for (const listener of listeners) listener();
    },
  };
}

function turn(
  id: string,
  ordinal: number,
  status: OrchestrationV2RunStatus,
  text: string,
): { readonly run: WalkModeTurns["runs"][number]; readonly items: WalkModeTurnItem[] } {
  return {
    run: { id, ordinal, status },
    items: [{ type: "assistant_message", runId: id, ordinal: ordinal * 10, text }],
  };
}

function thread(
  turnsList: ReadonlyArray<ReturnType<typeof turn>>,
  title = "Fix the login bug",
  extraItems: readonly WalkModeTurnItem[] = [],
): WalkModeTurns {
  return {
    title,
    runs: turnsList.map((entry) => entry.run),
    items: [...turnsList.flatMap((entry) => entry.items), ...extraItems],
  };
}

type SessionOptions = FakeAudioOptions & {
  readonly draft?: string;
  /** Transcripts returned in order; an Error makes that transcription fail. */
  readonly transcripts?: ReadonlyArray<string | Error>;
};

async function startSession(initial: WalkModeTurns | null, options: SessionOptions = {}) {
  const audio = fakeAudio(options);
  const turns = fakeTurns(initial);
  const draft = { text: options.draft ?? "" };
  const transcripts = [...(options.transcripts ?? ["transcript"])];
  const sent: string[] = [];
  const session = new WalkModeSession({
    turns: turns.stream,
    draft: {
      read: () => draft.text,
      append: (text) => {
        draft.text += text;
      },
    },
    send: async (text) => {
      sent.push(text);
    },
    audio: audio.port,
    transcriber: {
      prepare: async () => ({
        locale: "en-US",
        transcribe: async () => {
          const next = transcripts.shift() ?? "transcript";
          if (next instanceof Error) throw next;
          return next;
        },
      }),
    },
  });
  await session.start();
  return {
    session,
    audio,
    turns,
    draft,
    sent,
    /** Waits until the session leaves recording and transcribing. */
    rested: () =>
      new Promise<void>((resolve) => {
        const check = () => {
          if (session.status === "recording" || session.status === "transcribing") return false;
          unsubscribe();
          resolve();
          return true;
        };
        const unsubscribe = session.subscribe(check);
        check();
      }),
  };
}

const first = turn("run-1", 1, "completed", "Older reply.");
const latest = turn("run-2", 2, "completed", "The login works now. Try it again.");

describe("WalkModeSession: start and stop", () => {
  it("starts silently with the keep-alive on, the title shown, and the latest reply paused", async () => {
    const { session, audio } = await startSession(thread([first, latest]));
    expect(audio.take()).toEqual([
      ["configureSession"],
      ["setKeepAlive", true],
      ["setNowPlayingTitle", "Fix the login bug"],
    ]);
    expect(session.status).toBe("paused");
  });

  it("starts idle when the thread has no completed reply, and a press does nothing", async () => {
    const running = turn("run-1", 1, "running", "Half a thought");
    const { session, audio } = await startSession(thread([running]));
    audio.take();
    audio.press(1);
    expect(session.status).toBe("idle");
    expect(audio.take()).toEqual([]);
  });

  it("stop ends speech, turns the keep-alive off, and ignores later presses and replies", async () => {
    const { session, audio, turns } = await startSession(thread([latest]));
    audio.press(1);
    audio.take();
    session.stop();
    expect(audio.take()).toEqual([["stop"], ["setKeepAlive", false]]);
    expect(session.status).toBe("idle");
    expect(audio.listenerCount()).toBe(0);
    turns.set(thread([latest, turn("run-3", 3, "completed", "Too late.")]));
    expect(audio.take()).toEqual([]);
  });

  it("shows a renamed thread's new title on the now-playing card", async () => {
    const { audio, turns } = await startSession(thread([latest]));
    audio.take();
    turns.set(thread([latest], "Login bug fixed"));
    expect(audio.take()).toEqual([["setNowPlayingTitle", "Login bug fixed"]]);
  });
});

describe("WalkModeSession: presses", () => {
  it("one press reads the loaded reply from the start, sentence by sentence", async () => {
    const { session, audio } = await startSession(thread([first, latest]));
    audio.take();
    audio.press(1);
    expect(audio.take()).toEqual([["speak", ["The login works now.", "Try it again."]]]);
    expect(session.status).toBe("speaking");
  });

  it("presses toggle pause and resume, and the reply ends in idle", async () => {
    const { session, audio } = await startSession(thread([latest]));
    audio.press(1);
    audio.take();
    audio.press(1);
    expect(session.status).toBe("paused");
    audio.press(1);
    expect(session.status).toBe("speaking");
    expect(audio.take()).toEqual([["pause"], ["resume"]]);
    audio.finishChunks(2);
    expect(session.status).toBe("idle");
    audio.press(1);
    expect(audio.take()).toEqual([]);
  });
});

describe("WalkModeSession: replies", () => {
  it("reads a turn only when it completes", async () => {
    const { session, audio, turns } = await startSession(thread([]));
    audio.take();
    turns.set(thread([turn("run-1", 1, "running", "Draft that may change.")]));
    expect(audio.take()).toEqual([]);
    turns.set(thread([turn("run-1", 1, "completed", "")]));
    expect(audio.take()).toEqual([]);
    turns.set(thread([turn("run-1", 1, "completed", "Final answer.")]));
    expect(audio.take()).toEqual([["speak", ["Final answer."]]]);
    expect(session.status).toBe("speaking");
  });

  it("queues a reply that completes while another is being read", async () => {
    const { session, audio, turns } = await startSession(thread([latest]));
    audio.press(1);
    audio.take();
    turns.set(thread([latest, turn("run-3", 3, "completed", "Second reply.")]));
    expect(audio.take()).toEqual([["enqueue", ["Second reply."]]]);
    audio.finishChunks(2);
    expect(session.status).toBe("speaking");
    audio.finishChunks(1);
    expect(session.status).toBe("idle");
  });

  it("keeps a reply that completes while paused waiting until the next press", async () => {
    const { session, audio, turns } = await startSession(thread([latest]));
    audio.take();
    turns.set(thread([latest, turn("run-3", 3, "completed", "Second reply.")]));
    expect(audio.take()).toEqual([]);
    expect(session.status).toBe("paused");
    audio.press(1);
    expect(audio.take()).toEqual([
      ["speak", ["The login works now.", "Try it again.", "Second reply."]],
    ]);
  });

  it("speaks a new reply at once after the previous one finished", async () => {
    const { session, audio, turns } = await startSession(thread([latest]));
    audio.press(1);
    audio.finishChunks(2);
    audio.take();
    turns.set(thread([latest, turn("run-3", 3, "completed", "Next one.")]));
    expect(audio.take()).toEqual([["speak", ["Next one."]]]);
    expect(session.status).toBe("speaking");
  });

  it("announces code blocks as skipped and drops markdown symbols", async () => {
    const reply = [
      "## Fix",
      "Change the **guard** in `auth_check.ts` for _snake_case_value_:",
      "```md",
      "```ts",
      "if (!user) return;",
      "```",
      "- Then run the [tests](https://example.com).",
    ].join("\n");
    const { audio, turns } = await startSession(thread([]));
    audio.take();
    turns.set(thread([turn("run-1", 1, "completed", reply)]));
    expect(audio.take()).toEqual([
      [
        "speak",
        [
          "Fix",
          "Change the guard in auth_check.ts for snake_case_value:",
          "Code block skipped.",
          "Then run the tests.",
        ],
      ],
    ]);
  });

  it("reads a structured question followed by its options", async () => {
    const asking = turn("run-1", 1, "completed", "I need one decision.");
    const question: WalkModeTurnItem = {
      type: "user_input_request",
      runId: "run-1",
      ordinal: 20,
      questions: [
        {
          question: "Which database should I use?",
          options: [{ label: "Postgres" }, { label: "SQLite" }, { label: "MySQL" }],
        },
      ],
    };
    const { audio, turns } = await startSession(thread([]));
    audio.take();
    turns.set(thread([asking], undefined, [question]));
    expect(audio.take()).toEqual([
      [
        "speak",
        [
          "I need one decision.",
          "Which database should I use?",
          "Options: Postgres, SQLite, or MySQL.",
        ],
      ],
    ]);
  });

  it("reads only the final assistant text of a turn and skips rolled back turns", async () => {
    const multi = {
      run: { id: "run-1", ordinal: 1, status: "completed" as const },
      items: [
        { type: "assistant_message" as const, runId: "run-1", ordinal: 1, text: "Let me look." },
        { type: "assistant_message" as const, runId: "run-1", ordinal: 5, text: "Done." },
      ],
    };
    const { audio, turns } = await startSession(thread([]));
    audio.take();
    turns.set(thread([turn("run-0", 1, "rolled_back", "Taken back."), multi]));
    expect(audio.take()).toEqual([["speak", ["Done."]]]);
  });
});

describe("WalkModeSession: recording", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("two presses from idle record through call mode, and any press stops it into the draft", async () => {
    const { session, audio, draft, rested } = await startSession(thread([]), {
      transcripts: ["  Add a login test.  "],
    });
    audio.take();
    audio.press(2);
    await audio.until("playSound", "tick");
    expect(session.status).toBe("recording");
    expect(audio.take()).toEqual([
      ["startRecording", true],
      ["playSound", "tick"],
    ]);
    audio.press(1);
    await rested();
    expect(audio.take()).toEqual([["playSound", "tick"], ["stopRecording"]]);
    expect(draft.text).toBe("Add a login test.");
    expect(session.status).toBe("idle");
  });

  it("a call action stops a recording, and each recording appends a paragraph", async () => {
    const { audio, draft, rested } = await startSession(thread([]), {
      draft: "Typed first. ",
      transcripts: ["Spoken second.", "Spoken third."],
    });
    audio.press(2);
    await audio.until("playSound", "tick");
    audio.callAction("end");
    await rested();
    audio.press(2);
    await audio.until("startRecording", true);
    audio.press(2);
    await rested();
    expect(draft.text).toBe("Typed first. \n\nSpoken second.\n\nSpoken third.");
  });

  it("uses a wired microphone without a call when one is connected", async () => {
    const { audio } = await startSession(thread([]), { wiredInput: true });
    audio.take();
    audio.press(2);
    await audio.until("playSound", "tick");
    expect(audio.take()).toEqual([
      ["startRecording", false],
      ["playSound", "tick"],
    ]);
  });

  it("two presses while speaking pause first; a reply that completes meanwhile waits as paused", async () => {
    const { session, audio, turns, rested } = await startSession(thread([latest]));
    audio.press(1);
    audio.take();
    audio.press(2);
    expect(audio.take()).toEqual([["pause"]]);
    await audio.until("playSound", "tick");
    turns.set(thread([latest, turn("run-3", 3, "completed", "Second reply.")]));
    audio.press(1);
    await rested();
    expect(session.status).toBe("paused");
    expect(audio.take()).toEqual([
      ["startRecording", true],
      ["playSound", "tick"],
      ["enqueue", ["Second reply."]],
      ["playSound", "tick"],
      ["stopRecording"],
    ]);
  });

  it("stops by itself after five minutes, like a manual stop", async () => {
    vi.useFakeTimers();
    const { session, audio, draft, rested } = await startSession(thread([]));
    audio.press(2);
    await audio.until("playSound", "tick");
    vi.advanceTimersByTime(WALK_MODE_RECORDING_LIMIT_MS - 1);
    expect(session.status).toBe("recording");
    vi.advanceTimersByTime(1);
    await rested();
    expect(draft.text).toBe("transcript");
    expect(session.status).toBe("idle");
  });

  it("plays the error sound and returns to paused when the recording cannot start", async () => {
    const { session, audio, draft, rested } = await startSession(thread([latest]), {
      startFails: true,
      draft: "Keep me.",
    });
    audio.take();
    audio.press(2);
    await rested();
    expect(audio.take()).toEqual([
      ["startRecording", true],
      ["playSound", "error"],
    ]);
    expect(session.status).toBe("paused");
    expect(draft.text).toBe("Keep me.");
  });

  it("plays the error sound and keeps the draft when transcription fails", async () => {
    const { session, audio, draft, rested } = await startSession(thread([]), {
      draft: "Keep me.",
      transcripts: [new Error("Speech model unavailable")],
    });
    audio.press(2);
    await audio.until("playSound", "tick");
    audio.take();
    audio.press(1);
    await rested();
    expect(audio.take()).toEqual([
      ["playSound", "tick"],
      ["stopRecording"],
      ["playSound", "error"],
    ]);
    expect(draft.text).toBe("Keep me.");
    expect(session.status).toBe("idle");
  });

  it("a start that fails after Walk mode restarts leaves the new recording alone", async () => {
    const { session, audio } = await startSession(thread([]), { firstStartFailsLate: true });
    audio.press(2);
    await audio.until("startRecording", true);
    session.stop();
    await session.start();
    audio.take();
    audio.press(2);
    await Promise.race([audio.until("playSound", "tick"), audio.until("playSound", "error")]);
    expect(session.status).toBe("recording");
    expect(audio.take()).toEqual([
      ["startRecording", true],
      ["playSound", "tick"],
    ]);
  });

  it("turning Walk mode off ends a running recording", async () => {
    const { session, audio } = await startSession(thread([]));
    audio.press(2);
    await audio.until("playSound", "tick");
    audio.take();
    session.stop();
    await audio.until("stopRecording");
    expect(audio.take()).toEqual([["stop"], ["setKeepAlive", false], ["stopRecording"]]);
  });
});
