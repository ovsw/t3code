import { requireNativeModule } from "expo";

import type { WalkModeAudio } from "./walkModeAudio.types";

export const walkModeAudio: WalkModeAudio | null =
  requireNativeModule<WalkModeAudio>("T3WalkModeAudio");
