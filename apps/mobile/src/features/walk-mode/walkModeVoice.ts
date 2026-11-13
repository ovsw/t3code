import type {
  WalkModeInstalledVoices,
  WalkModeVoice,
  WalkModeVoiceQuality,
} from "../../native/walkModeAudio.types";

export const WALK_MODE_SPEED = { min: 0.8, max: 1.6, step: 0.1, default: 1 } as const;

const QUALITY_RANK: Record<WalkModeVoiceQuality, number> = { default: 0, enhanced: 1, premium: 2 };

export const WALK_MODE_VOICE_QUALITY_LABEL: Record<WalkModeVoiceQuality, string> = {
  default: "Default",
  enhanced: "Enhanced",
  premium: "Premium",
};

function baseLanguage(language: string): string {
  return language.split(/[-_]/)[0]!.toLowerCase();
}

function normalizedLanguage(language: string): string {
  return language.replace("_", "-").toLowerCase();
}

export function speaksLanguage(voice: WalkModeVoice, language: string): boolean {
  return baseLanguage(voice.language) === baseLanguage(language);
}

/**
 * The best Premium or Enhanced voice in the phone's language, the exact region first at equal
 * quality. Null leaves iOS its own default voice, so no novelty voice is picked by accident.
 */
export function bestWalkModeVoice(
  voices: readonly WalkModeVoice[],
  language: string,
): WalkModeVoice | null {
  const exact = normalizedLanguage(language);
  let best: WalkModeVoice | null = null;
  const score = (voice: WalkModeVoice) =>
    QUALITY_RANK[voice.quality] * 2 + (normalizedLanguage(voice.language) === exact ? 1 : 0);
  for (const voice of voices) {
    if (voice.quality === "default" || !speaksLanguage(voice, language)) continue;
    if (best === null || score(voice) > score(best)) best = voice;
  }
  return best;
}

/** The saved voice while it is installed, otherwise Automatic. */
export function resolveWalkModeVoice(
  saved: string | null,
  installed: WalkModeInstalledVoices | null,
): string | null {
  // Before the list loads, the native side still falls back when the saved voice is gone.
  if (installed === null) return saved;
  if (saved !== null && installed.voices.some((voice) => voice.identifier === saved)) return saved;
  return bestWalkModeVoice(installed.voices, installed.language)?.identifier ?? null;
}

export function walkModeSpeed(saved: number | undefined): number {
  if (saved === undefined || !Number.isFinite(saved)) return WALK_MODE_SPEED.default;
  return Math.min(WALK_MODE_SPEED.max, Math.max(WALK_MODE_SPEED.min, saved));
}
