import type { WalkModeStatus } from "@t3tools/client-runtime/walk-mode";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import {
  startWalkMode,
  stopWalkMode,
  useWalkModeStatus,
  walkModeAvailable,
} from "./walkModeController";

const STATUS_LABELS: Record<WalkModeStatus, string> = {
  idle: "Walk mode · Idle",
  speaking: "Walk mode · Speaking",
  paused: "Walk mode · Paused",
  recording: "Walk mode · Recording",
  transcribing: "Walk mode · Transcribing",
};

/** Starts and stops Walk mode on this thread and shows its state. iOS only. */
export function WalkModeBar(props: { readonly threadRef: ScopedThreadRef | null }) {
  const { threadRef } = props;
  const status = useWalkModeStatus(threadRef);
  if (!walkModeAvailable || threadRef === null) return null;

  const start = () => {
    startWalkMode(threadRef).catch((error: unknown) => {
      Dialog.alert(
        "Could not start Walk mode",
        error instanceof Error ? error.message : "Try again.",
      );
    });
  };

  return (
    <View className="flex-row items-center gap-2 px-4 pb-2">
      <SymbolView name="headphones" size={12} tintColorClassName="accent-foreground-muted" />
      <Text className="min-w-0 flex-1 text-xs text-foreground-muted" numberOfLines={1}>
        {status === null ? "Walk mode" : STATUS_LABELS[status]}
      </Text>
      <Button
        label={status === null ? "Start" : "Stop"}
        accessibilityLabel={status === null ? "Start Walk mode" : "Stop Walk mode"}
        tone="text"
        onPress={status === null ? start : stopWalkMode}
      />
    </View>
  );
}
