import { requireOptionalNativeModule } from "expo";

import type { WalkModeAudio } from "./walkModeAudio.types";

export const walkModeAudio: WalkModeAudio | null =
  requireOptionalNativeModule<WalkModeAudio>("T3WalkModeAudio");
