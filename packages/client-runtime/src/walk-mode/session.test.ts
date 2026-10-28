import { describe, expect, it } from "vite-plus/test";

import type { OrchestrationV2RunStatus } from "@t3tools/contracts";

import type { WalkModeTurnItem, WalkModeTurns } from "./reply.ts";
import {
  WalkModeSession,
  type WalkModeAudioEvent,
  type WalkModeAudioPort,
  type WalkModeTurnStream,
} from "./session.ts";

type AudioCall = readonly [method: string, ...args: unknown[]];

function fakeAudio() {
  const calls: AudioCall[] = [];
  const listeners = new Set<(event: WalkModeAudioEvent) => void>();
  const record =
    (method: string) =>
    async (...args: unknown[]) => {
      calls.push([method, ...args]);
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
    startRecording: async (useCallMode) => {
      calls.push(["startRecording", useCallMode]);
      return "file:///recording.m4a";
    },
    stopRecording: async () => {
      calls.push(["stopRecording"]);
      return { uri: null, seconds: 0 };
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

async function startSession(initial: WalkModeTurns | null) {
  const audio = fakeAudio();
  const turns = fakeTurns(initial);
  const drafts: string[] = [];
  const sent: string[] = [];
  const session = new WalkModeSession({
    turns: turns.stream,
    draft: { read: () => drafts.join(" "), append: (text) => drafts.push(text) },
    send: async (text) => {
      sent.push(text);
    },
    audio: audio.port,
    transcriber: {
      prepare: async () => ({ locale: "en-US", transcribe: async () => "transcript" }),
    },
  });
  await session.start();
  return { session, audio, turns, drafts, sent };
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
      "Change the **guard** in `auth.ts`:",
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
        ["Fix", "Change the guard in auth.ts:", "Code block skipped.", "Then run the tests."],
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
