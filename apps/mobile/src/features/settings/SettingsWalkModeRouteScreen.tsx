import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { DEFAULT_WALK_MODE_SETTINGS } from "@t3tools/client-runtime/walk-mode";
import type { MenuAction } from "@react-native-menu/menu";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useState } from "react";
import { AppState, Platform, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { Menu } from "../../components/ui/Menu";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { SliderRow } from "../../components/ui/SliderRow";
import { walkModeAudio } from "../../native/walkModeAudio";
import type { WalkModeInstalledVoices, WalkModeVoice } from "../../native/walkModeAudio.types";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { alertWalkModeStartFailure } from "../walk-mode/WalkModeBar";
import {
  loadWalkModeVoices,
  startWalkMode,
  stopWalkMode,
  useWalkModeEnabled,
  walkModeAvailable,
} from "../walk-mode/walkModeController";
import {
  bestWalkModeVoice,
  resolveWalkModeVoice,
  speaksLanguage,
  WALK_MODE_SPEED,
  WALK_MODE_VOICE_QUALITY_LABEL,
  walkModeSpeed,
} from "../walk-mode/walkModeVoice";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";

const AUTOMATIC_VOICE = "automatic";
const PREVIEW_TEXT = "This is how Walk mode reads replies to you.";

function voiceAction(voice: WalkModeVoice, selected: string | null): MenuAction {
  return {
    id: voice.identifier,
    title: voice.name,
    subtitle: `${WALK_MODE_VOICE_QUALITY_LABEL[voice.quality]} · ${voice.language}`,
    state: voice.identifier === selected ? "on" : "off",
  };
}

const QUALITY_ORDER = { premium: 0, enhanced: 1, default: 2 } as const;

/** Automatic, then the phone's language by quality, then every other language in a submenu. */
function voiceMenuActions(installed: WalkModeInstalledVoices, selected: string | null) {
  const local = installed.voices
    .filter((voice) => speaksLanguage(voice, installed.language))
    .sort(
      (a, b) => QUALITY_ORDER[a.quality] - QUALITY_ORDER[b.quality] || a.name.localeCompare(b.name),
    );
  const other = installed.voices
    .filter((voice) => !speaksLanguage(voice, installed.language))
    .sort((a, b) => a.language.localeCompare(b.language) || a.name.localeCompare(b.name));
  const actions: MenuAction[] = [
    {
      id: AUTOMATIC_VOICE,
      title: "Automatic (best installed)",
      state: selected === null ? "on" : "off",
    },
  ];
  if (local.length > 0) {
    actions.push({
      id: "local",
      title: "",
      displayInline: true,
      subactions: local.map((voice) => voiceAction(voice, selected)),
    });
  }
  if (other.length > 0) {
    actions.push({
      id: "other",
      title: "Other languages",
      subactions: other.map((voice) => voiceAction(voice, selected)),
    });
  }
  return actions;
}

function useInstalledVoices(): WalkModeInstalledVoices | null {
  const [voices, setVoices] = useState<WalkModeInstalledVoices | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the native voice list, again on return from iOS Settings where voices are downloaded
  useEffect(() => {
    if (walkModeAudio === null) return;
    let active = true;
    const load = () =>
      loadWalkModeVoices().then((next) => {
        if (active && next !== null) setVoices(next);
      });
    void load();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void load();
    });
    return () => {
      active = false;
      subscription.remove();
    };
  }, []);
  return voices;
}

export function SettingsWalkModeRouteScreen() {
  const insets = useSafeAreaInsets();
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const preferencesReady = AsyncResult.isSuccess(preferencesResult) && !preferencesResult.waiting;
  const preferences = AsyncResult.isSuccess(preferencesResult) ? preferencesResult.value : {};
  const readNewReplies =
    preferences.walkModeReadNewRepliesWhilePaused ??
    DEFAULT_WALK_MODE_SETTINGS.readNewRepliesWhilePaused;
  const thinkingTone = preferences.walkModeThinkingTone ?? DEFAULT_WALK_MODE_SETTINGS.thinkingTone;
  const walkModeOn = useWalkModeEnabled();
  const installedVoices = useInstalledVoices();
  const savedVoice = preferences.walkModeVoice ?? null;
  const speed = walkModeSpeed(preferences.walkModeSpeechSpeed);
  // A deleted voice shows as Automatic, which is what Walk mode speaks with.
  const selectedVoice =
    installedVoices?.voices.find((voice) => voice.identifier === savedVoice) ?? null;
  const automaticVoice =
    installedVoices === null
      ? null
      : bestWalkModeVoice(installedVoices.voices, installedVoices.language);
  const voiceLabel = selectedVoice
    ? `${selectedVoice.name}, ${WALK_MODE_VOICE_QUALITY_LABEL[selectedVoice.quality]}`
    : automaticVoice
      ? `Automatic: ${automaticVoice.name}`
      : "Automatic";
  const voiceControlsDisabled = !preferencesReady || installedVoices === null;

  const content = (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      showsVerticalScrollIndicator={false}
      className="flex-1"
      contentContainerClassName="gap-3 px-5 pt-4"
      contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
    >
      <SettingsSection>
        <SettingsSwitchRow
          icon="headphones"
          label="Walk mode"
          subtitle="Stays on for the thread you have open, and moves to each thread you open."
          disabled={!walkModeAvailable}
          value={walkModeOn}
          onValueChange={(value) => {
            if (value) startWalkMode().catch(alertWalkModeStartFailure);
            else stopWalkMode();
          }}
        />
      </SettingsSection>
      <SettingsSection title="Replies">
        <SettingsSwitchRow
          icon="text.bubble"
          label="Read new replies at once"
          subtitle="A reply that arrives while the voice is paused starts right away. Off: it waits for one press."
          disabled={!preferencesReady}
          value={readNewReplies}
          onValueChange={(value) => savePreferences({ walkModeReadNewRepliesWhilePaused: value })}
        />
        <SettingsSwitchRow
          icon="bell.badge"
          label="Thinking tone"
          subtitle="A soft tone repeats while a message you sent waits for its reply."
          disabled={!preferencesReady}
          value={thinkingTone}
          onValueChange={(value) => savePreferences({ walkModeThinkingTone: value })}
        />
      </SettingsSection>
      <SettingsSection title="Voice">
        <Menu
          accessible
          accessibilityRole="button"
          accessibilityLabel={`Voice, ${voiceLabel}`}
          title="Voice"
          actions={
            installedVoices === null
              ? []
              : voiceMenuActions(installedVoices, selectedVoice?.identifier ?? null)
          }
          onPressAction={({ nativeEvent }) =>
            savePreferences({
              walkModeVoice: nativeEvent.event === AUTOMATIC_VOICE ? null : nativeEvent.event,
            })
          }
        >
          <View className="bg-grouped-card">
            <ListRowLayout
              icon="person.crop.circle"
              label="Voice"
              detail={voiceLabel}
              disabled={voiceControlsDisabled}
            />
          </View>
        </Menu>
        <SliderRow
          icon="timer"
          label="Speed"
          valueLabel={`${speed.toFixed(1)}×`}
          min={WALK_MODE_SPEED.min}
          max={WALK_MODE_SPEED.max}
          step={WALK_MODE_SPEED.step}
          value={speed}
          disabled={!preferencesReady}
          onChange={(value) => savePreferences({ walkModeSpeechSpeed: value })}
        />
        <ListActionRow
          icon="play"
          label="Preview"
          disabled={voiceControlsDisabled}
          onPress={() => {
            void walkModeAudio
              ?.previewVoice(PREVIEW_TEXT, {
                identifier: resolveWalkModeVoice(savedVoice, installedVoices),
                speed,
              })
              .catch(() => {});
          }}
        />
      </SettingsSection>
      {installedVoices !== null && automaticVoice === null ? (
        <Text className="px-2 text-sm text-foreground-muted">
          For a more natural voice, download an Enhanced or Premium voice in iOS Settings →
          Accessibility → Spoken Content → Voices.
        </Text>
      ) : null}
      <Text className="px-2 text-sm text-foreground-muted">
        Walk mode reads replies in your headphones and records your answers by headphone presses.
        Turn it on here or from the bar above the composer in a thread.
      </Text>
    </ScrollView>
  );

  return Platform.OS === "android" ? (
    <SettingsScreen title="Walk mode">{content}</SettingsScreen>
  ) : (
    <View collapsable={false} className="flex-1 bg-sheet">
      {content}
    </View>
  );
}
