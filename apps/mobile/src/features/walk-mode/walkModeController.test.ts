import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { scopedThreadKey } from "../../lib/scopedEntities";

const audio = vi.hoisted(() => ({
  configureSession: vi.fn(async () => {}),
  setKeepAlive: vi.fn(async () => {}),
  setNowPlayingTitle: vi.fn(async () => {}),
  shutdown: vi.fn(async () => {}),
  addListener: () => ({ remove: () => {} }),
}));
vi.mock("../../native/walkModeAudio", () => ({ walkModeAudio: audio }));
vi.mock("../../native/voiceTranscription", () => ({ getLocalVoiceTranscriber: () => null }));
vi.mock("../../state/atom-registry", () => ({
  appAtomRegistry: { get: () => null, subscribe: () => () => {} },
}));
vi.mock("../../state/threads", () => ({ environmentThreadDetails: { threadAtom: () => ({}) } }));
vi.mock("../../state/use-remote-environment-registry", () => ({
  environmentConnectedAtom: () => ({}),
}));
vi.mock("../../state/preferences", () => ({ mobilePreferencesAtom: {} }));
vi.mock("../../state/thread-outbox", () => ({ enqueueThreadOutboxMessage: vi.fn() }));
vi.mock("../../state/use-composer-drafts", () => ({}));
vi.mock("../../lib/commandMetadata", () => ({ makeQueuedMessageMetadata: vi.fn() }));

const {
  closeWalkModeThread,
  openWalkModeThread,
  startWalkMode,
  stopWalkMode,
  walkModeMessageText,
} = await import("./walkModeController");

function thread(id: string): ScopedThreadRef {
  return { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make(id) };
}

function runsOn(ref: ScopedThreadRef): boolean {
  return walkModeMessageText(scopedThreadKey(ref.environmentId, ref.threadId), "hi") !== "hi";
}

describe("walkModeController", () => {
  it("stays on across threads and moves to the thread on screen", async () => {
    const [a, b, c] = [thread("a"), thread("b"), thread("c")];

    await openWalkModeThread(a);
    expect(runsOn(a)).toBe(false);

    await startWalkMode(a);
    expect(runsOn(a)).toBe(true);

    await openWalkModeThread(b);
    expect(runsOn(a)).toBe(false);
    expect(runsOn(b)).toBe(true);
    expect(audio.shutdown).toHaveBeenCalledTimes(1);

    await openWalkModeThread(b);
    expect(audio.configureSession).toHaveBeenCalledTimes(2);

    stopWalkMode();
    await openWalkModeThread(c);
    expect(runsOn(b)).toBe(false);
    expect(runsOn(c)).toBe(false);

    // Settings starts it without a thread: it runs on the one open, else on the next to open.
    await startWalkMode();
    expect(runsOn(c)).toBe(true);
    closeWalkModeThread(c);
    expect(runsOn(c)).toBe(true);

    stopWalkMode();
    await startWalkMode();
    expect(runsOn(c)).toBe(false);
    await openWalkModeThread(a);
    expect(runsOn(a)).toBe(true);
  });
});
