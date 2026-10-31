import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { DEFAULT_WALK_MODE_SETTINGS } from "@t3tools/client-runtime/walk-mode";
import { AsyncResult } from "effect/reactivity";
import { Platform, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";

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

  const content = (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      showsVerticalScrollIndicator={false}
      className="flex-1"
      contentContainerClassName="gap-3 px-5 pt-4"
      contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
    >
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
      <Text className="px-2 text-sm text-foreground-muted">
        Walk mode reads replies in your headphones and records your answers by headphone presses.
        Start it from the bar above the composer in a thread.
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
