import { useEffect, useState, useSyncExternalStore } from "react";
import { View } from "react-native";

import {
  initialWalkModeState,
  walkModeReducer,
  type WalkModeEffect,
  type WalkModeEvent,
  type WalkModeState,
} from "@t3tools/client-runtime/walk-mode";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ListToggleRow } from "../../components/ui/ListToggleRow";
import { getLocalVoiceTranscriber } from "../../native/voiceTranscription";
import { walkModeAudio } from "../../native/walkModeAudio";
import type { WalkModeAudio } from "../../native/walkModeAudio.types";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { SettingsSection } from "../settings/components/SettingsSection";

const SAMPLE_REPLY = [
  "This is the walk mode spike. One press pauses me, one more press resumes me.",
  "Two presses start a recording. Two more presses stop it.",
  "Three presses send everything you recorded. With nothing recorded you hear the error sound.",
  "Now lock the screen and try the headphone buttons again. Each gesture is written to the log.",
  "This is the last sentence. After it, I stop and the state goes back to idle.",
];

const LOG_LIMIT = 60;

type LogLine = { readonly id: number; readonly text: string };

type Snapshot = {
  readonly state: WalkModeState;
  readonly log: readonly LogLine[];
  readonly keepAlive: boolean;
  readonly sessionReady: boolean;
};

const GESTURE_EVENTS: Record<1 | 2 | 3, WalkModeEvent> = {
  1: { type: "press.single" },
  2: { type: "press.double" },
  3: { type: "press.triple" },
};

// Lives outside React: it holds the machine state, runs effects against the native
// module, and answers headphone gestures that arrive while the screen is locked.
function createSpikeController(audio: WalkModeAudio | null) {
  let snapshot: Snapshot = {
    state: initialWalkModeState,
    log: [],
    keepAlive: false,
    sessionReady: false,
  };
  let nextLogId = 1;
  const transcriber = getLocalVoiceTranscriber();
  const listeners = new Set<() => void>();
  const subscriptions: { remove(): void }[] = [];

  const publish = (patch: Partial<Snapshot>) => {
    snapshot = { ...snapshot, ...patch };
    for (const listener of listeners) listener();
  };
  const append = (text: string) => {
    const time = new Date().toLocaleTimeString(undefined, { hour12: false });
    const line: LogLine = { id: nextLogId++, text: `${time}  ${text}` };
    publish({ log: [line, ...snapshot.log].slice(0, LOG_LIMIT) });
  };

  const runEffect = (effect: WalkModeEffect) => {
    if (!audio) return;
    switch (effect.type) {
      case "speech.start":
        void audio.speak(SAMPLE_REPLY);
        return;
      case "speech.pause":
        void audio.pause();
        return;
      case "speech.resume":
        void audio.resume();
        return;
      case "record.start":
        audio
          .startRecording()
          .then(() => {
            void audio.playSound("tick");
            append("recording started");
          })
          .catch((error: unknown) => {
            append(`record start error: ${String(error)}`);
            dispatch({ type: "transcript.failed" });
          });
        return;
      case "record.stop":
        void audio.playSound("tick");
        audio
          .stopRecording()
          .then(async ({ uri, seconds }) => {
            append(`recording stopped after ${seconds.toFixed(1)} s`);
            if (!uri) throw new Error("no recording file");
            if (!transcriber) throw new Error("on-device transcription unavailable");
            const prepared = await transcriber.prepare({ signal: new AbortController().signal });
            const text = await prepared.transcribe(uri, { signal: new AbortController().signal });
            append(`transcript: ${text}`);
            dispatch({ type: "transcript.ready", text });
          })
          .catch((error: unknown) => {
            append(`transcription error: ${String(error)}`);
            dispatch({ type: "transcript.failed" });
          });
        return;
      case "send":
        append(`SEND: ${effect.text.replaceAll("\n\n", " | ")}`);
        return;
      case "sound.error":
        void audio.playSound("error");
        return;
      case "sound.sent":
        void audio.playSound("sent");
        return;
    }
  };

  function dispatch(event: WalkModeEvent) {
    const step = walkModeReducer(snapshot.state, event);
    publish({ state: step.state });
    const effectNames = step.effects.map((effect) => effect.type).join(", ");
    append(`${event.type} -> ${step.state.kind}${effectNames ? ` [${effectNames}]` : ""}`);
    for (const effect of step.effects) runEffect(effect);
  }

  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    dispatch,
    start() {
      if (!audio) {
        append("Native module not available on this platform.");
        return;
      }
      subscriptions.push(
        audio.addListener("gesture", ({ presses }) => {
          append(`headphones: ${presses} press${presses === 1 ? "" : "es"}`);
          dispatch(GESTURE_EVENTS[presses]);
        }),
        audio.addListener("speech", (event) => {
          if (event.type === "finished") dispatch({ type: "speech.finished" });
        }),
        audio.addListener("session", (event) => {
          if (event.type === "route") append(`route: out ${event.outputs} / in ${event.inputs}`);
          else if (event.type === "engineRestarted") append("keep-alive engine restarted");
        }),
      );
      audio
        .configureSession()
        .then(() => {
          publish({ sessionReady: true });
          append("audio session configured, remote commands installed");
        })
        .catch((error: unknown) => append(`session error: ${String(error)}`));
    },
    setKeepAlive(enabled: boolean) {
      publish({ keepAlive: enabled });
      audio
        ?.setKeepAlive(enabled)
        .then(() => append(`keep-alive ${enabled ? "on" : "off"}`))
        .catch((error: unknown) => append(`keep-alive error: ${String(error)}`));
    },
    dispose() {
      for (const subscription of subscriptions) subscription.remove();
      subscriptions.length = 0;
      void audio?.stop();
      void audio?.setKeepAlive(false);
    },
  };
}

export function WalkModeSpikeScreen() {
  const [controller] = useState(() => createSpikeController(walkModeAudio));
  const { state, log, keepAlive, sessionReady } = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps the native audio session and its headphone listeners alive while this screen is mounted
  useEffect(() => {
    controller.start();
    return () => controller.dispose();
  }, [controller]);

  return (
    <SettingsScreen title="Walk mode spike">
      <SettingsSection title="State">
        <View className="gap-1 px-4 py-2">
          <Text className="text-lg font-semibold">{state.kind}</Text>
          <Text className="text-sm opacity-70">
            drafts: {state.drafts.length} · speech queued: {state.hasSpeech ? "yes" : "no"} ·
            session: {sessionReady ? "ready" : "not ready"}
          </Text>
        </View>
      </SettingsSection>
      <SettingsSection title="Simulate">
        <View className="flex-row flex-wrap gap-2 px-4 py-2">
          <Button
            label="Reply arrives"
            onPress={() => controller.dispatch({ type: "reply.arrived" })}
          />
          <Button label="1 press" onPress={() => controller.dispatch(GESTURE_EVENTS[1])} />
          <Button label="2 presses" onPress={() => controller.dispatch(GESTURE_EVENTS[2])} />
          <Button label="3 presses" onPress={() => controller.dispatch(GESTURE_EVENTS[3])} />
        </View>
        <ListToggleRow
          label="Silent keep-alive track"
          value={keepAlive}
          onValueChange={(enabled) => controller.setKeepAlive(enabled)}
        />
      </SettingsSection>
      <SettingsSection title="Log (newest first)">
        <View className="gap-1 px-4 py-2">
          {log.length === 0 ? <Text className="text-sm opacity-70">Nothing yet.</Text> : null}
          {log.map((line) => (
            <Text key={line.id} className="font-mono text-xs">
              {line.text}
            </Text>
          ))}
        </View>
      </SettingsSection>
    </SettingsScreen>
  );
}
