import { useSyncExternalStore } from "react";

import {
  WalkModeSession,
  walkModeTurnsFromProjection,
  type WalkModeAudioPort,
  type WalkModeStatus,
  type WalkModeTurns,
  type WalkModeTurnStream,
} from "@t3tools/client-runtime/walk-mode";
import type { ScopedThreadRef } from "@t3tools/contracts";

import { scopedThreadKey } from "../../lib/scopedEntities";
import { getLocalVoiceTranscriber } from "../../native/voiceTranscription";
import { walkModeAudio } from "../../native/walkModeAudio";
import type { WalkModeAudio } from "../../native/walkModeAudio.types";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentThreadDetails } from "../../state/threads";
import { appendComposerDraftText, getComposerDraftSnapshot } from "../../state/use-composer-drafts";

function nativeAudioPort(audio: WalkModeAudio): WalkModeAudioPort {
  return {
    configureSession: () => audio.configureSession(),
    speak: (chunks) => audio.speak(chunks),
    enqueue: (chunks) => audio.enqueue(chunks),
    pause: () => audio.pause(),
    resume: () => audio.resume(),
    stop: () => audio.stop(),
    setKeepAlive: (enabled) => audio.setKeepAlive(enabled),
    setNowPlayingTitle: (title) => audio.setNowPlayingTitle(title),
    hasWiredInput: () => audio.hasWiredInput(),
    startRecording: (useCallMode) => audio.startRecording(useCallMode),
    stopRecording: () => audio.stopRecording(),
    playSound: (kind) => audio.playSound(kind),
    subscribe: (listener) => {
      const subscriptions = [
        audio.addListener("gesture", (event) =>
          listener(
            event.source === "call"
              ? { type: "call-action", action: event.action }
              : { type: "gesture", presses: event.presses },
          ),
        ),
        audio.addListener("speech", (event) => {
          if (event.type === "chunkFinished") listener({ type: "chunk-finished" });
        }),
        audio.addListener("session", (event) => {
          if (event.type === "route") {
            listener({ type: "route", outputs: event.outputs, inputs: event.inputs });
          }
        }),
      ];
      return () => {
        for (const subscription of subscriptions) subscription.remove();
      };
    },
  };
}

// The thread atom changes on every streamed token. The session only needs a
// look when a run changes status, the thread is renamed, or a reply lands late.
function threadTurnStream(ref: ScopedThreadRef): WalkModeTurnStream {
  const atom = environmentThreadDetails.threadAtom(ref);
  const projection = () => appAtomRegistry.get(atom)?.projection ?? null;
  let cachedSource: object | null = null;
  let cachedTurns: WalkModeTurns | null = null;
  return {
    read: () => {
      const current = projection();
      if (current === null) return null;
      if (current !== cachedSource) {
        cachedSource = current;
        cachedTurns = walkModeTurnsFromProjection(current);
      }
      return cachedTurns;
    },
    subscribe: (onChange) => {
      let runs = projection()?.runs;
      let title = projection()?.thread.title;
      let turnItems = projection()?.turnItems;
      let messages = projection()?.messages;
      return appAtomRegistry.subscribe(atom, () => {
        const current = projection();
        // Tokens stream only while a run is running; item changes outside that can carry
        // the reply text of a run that already turned terminal.
        const itemsChanged =
          (current?.turnItems !== turnItems || current?.messages !== messages) &&
          !current?.runs.some((run) => run.status === "running");
        if (current?.runs === runs && current?.thread.title === title && !itemsChanged) return;
        runs = current?.runs;
        title = current?.thread.title;
        turnItems = current?.turnItems;
        messages = current?.messages;
        onChange();
      });
    },
  };
}

type ActiveWalkMode = {
  readonly threadKey: string;
  readonly session: WalkModeSession;
  readonly unsubscribe: () => void;
};

let active: ActiveWalkMode | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

export const walkModeAvailable = walkModeAudio !== null;

export function stopWalkMode(): void {
  if (active === null) return;
  const { session, unsubscribe } = active;
  active = null;
  unsubscribe();
  session.stop();
  notify();
}

/** One session at a time: starting on another thread stops the current one. */
export async function startWalkMode(ref: ScopedThreadRef): Promise<void> {
  if (walkModeAudio === null) return;
  stopWalkMode();
  const draftKey = scopedThreadKey(ref.environmentId, ref.threadId);
  const session = new WalkModeSession({
    turns: threadTurnStream(ref),
    draft: {
      read: () => getComposerDraftSnapshot(draftKey).text,
      append: (text) => appendComposerDraftText(draftKey, text),
    },
    send: () => Promise.reject(new Error("Walk mode cannot send messages yet.")),
    audio: nativeAudioPort(walkModeAudio),
    transcriber: getLocalVoiceTranscriber(),
  });
  const current: ActiveWalkMode = {
    threadKey: draftKey,
    session,
    unsubscribe: session.subscribe(notify),
  };
  active = current;
  notify();
  try {
    await session.start();
  } catch (error) {
    if (active === current) stopWalkMode();
    throw error;
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The Walk mode state on this thread, or null when Walk mode is off here. */
export function useWalkModeStatus(ref: ScopedThreadRef | null): WalkModeStatus | null {
  const threadKey = ref === null ? null : scopedThreadKey(ref.environmentId, ref.threadId);
  return useSyncExternalStore(subscribe, () =>
    active !== null && active.threadKey === threadKey ? active.session.status : null,
  );
}
